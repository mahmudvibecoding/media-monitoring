"""The collected Telegram data, for admins: the monitored channels a page at a time, searched and in the order the
site's channels page asks for, each with its latest message (GET /api/telegram/channels), a channel's details
(.../{channel_id}), and its saved messages, newest first, all of them or those a search finds
(.../{channel_id}/messages). The column and the indexes the channel list reads them by are in app.sql; a channel's
messages come by the messages table's key."""

import asyncio
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Path, Query, Request
from psycopg import sql
from psycopg.rows import class_row, dict_row
from pydantic import BaseModel

from media_monitoring.api.accounts import Admin
from media_monitoring.api.errors import Failure, failures
from media_monitoring.api.lists import LAST_PAGE, PAGE_SIZE, SEARCH_MAX, anywhere

router = APIRouter()


class TelegramChannel(BaseModel):
    id: int  # Telegram's ID for the channel, which never changes
    username: str  # without the @: its public page is t.me/<username>
    title: str | None
    subscribers: int | None  # exact below 1,000; Telegram's page rounds bigger counts to three digits (1.14M)
    last_message_at: datetime | None  # when its latest message came out
    last_message: str | None  # its latest saved message's text, the first 200 characters, for a chat list's line
    photo_url: str | None  # its photo, 160 × 160, on Telegram's image server; None without one


class TelegramChannels(BaseModel):
    channels: list[TelegramChannel]  # this page's
    total: int  # how many channels match, on all the pages
    page_size: int


class TelegramChannelDetails(TelegramChannel):
    description: str | None
    messages: int  # how many of its messages have been saved (those with text)


class TelegramMessage(BaseModel):
    id: int  # its number in the channel: t.me/<username>/<id>
    published_at: datetime  # to the second
    text: str  # as plain text, with links kept as addresses


class TelegramMessages(BaseModel):
    messages: list[TelegramMessage]  # this page's: fewer than page_size on the last one
    page_size: int


# As for YouTube's channels: the page's channels are picked from the order's index alone, and only those are read,
# each with its latest saved message, which the messages table's key gives at once: 10 ms for a page of 50
LAST = """
    LEFT JOIN LATERAL (
        SELECT left(m.text, 200) AS last_message FROM telegram_messages AS m
        WHERE m.channel_id = c.channel_id ORDER BY m.message_id DESC LIMIT 1
    ) AS last ON true
"""
CHANNELS = sql.SQL(
    """
    SELECT c.channel_id AS id, c.username, c.title, c.subscriber_count AS subscribers, c.last_message_at,
        last.last_message, c.photo_url
    FROM (SELECT channel_id FROM telegram_channels {where} ORDER BY {order} LIMIT %(limit)s OFFSET %(offset)s) AS page
    JOIN telegram_channels AS c USING (channel_id)
"""
    + LAST
    + """
    ORDER BY {order}
"""
)
COUNT = sql.SQL("SELECT count(*) FROM telegram_channels {where}")
# Only the channels with a saved message (app.sql), and with a search, those it matches: lowercase, apostrophes left out
LISTED = sql.SQL("WHERE has_messages")
SEARCHED = sql.SQL("WHERE has_messages AND search_text LIKE app.searchable(%(pattern)s)")
# For a while, to review them: the channels that post 300 messages a day or more (app.telegram_busy)
BUSY = sql.SQL("WHERE channel_id IN (SELECT channel_id FROM app.telegram_busy)")
# Each order ends with the channel's ID, so that channels that tie keep their places from one page to the next
ORDERS = {
    "subscribers": sql.SQL("subscriber_count DESC NULLS LAST, channel_id"),
    "latest": sql.SQL("last_message_at DESC NULLS LAST, channel_id"),
}


@router.get(
    "/api/telegram/channels",
    responses=failures(
        {
            401: "not_signed_in: no session, or it ended",
            403: "forbidden: only admins see this; must_change_password: the temporary password isn't changed yet",
            422: "invalid_request: a parameter is out of its range",
        }
    ),
)
async def telegram_channels(
    request: Request,
    _: Admin,
    search: Annotated[str, Query(max_length=SEARCH_MAX, description="Part of a channel's name or username")] = "",
    sort: Annotated[
        Literal["subscribers", "latest"], Query(description="The biggest first, or the latest to post")
    ] = "subscribers",
    page: Annotated[int, Query(ge=1, le=LAST_PAGE, description=f"{PAGE_SIZE} channels to a page")] = 1,
    busy: Annotated[
        bool, Query(description="For a while: only the channels that post 300 messages a day or more")
    ] = False,
) -> TelegramChannels:
    """The monitored channels that have a message saved, a page at a time, the biggest first or the latest to post
    first. With a search, only the channels whose name or username has it in them, whatever the case of its letters, and
    apostrophes aside. With busy, only the channels that post 300 messages a day or more, searched as well."""
    search = " ".join(search.split())
    if busy:
        where = BUSY + sql.SQL(" AND search_text LIKE app.searchable(%(pattern)s)") if search else BUSY
    else:
        where = SEARCHED if search else LISTED
    values = {"pattern": anywhere(search), "limit": PAGE_SIZE, "offset": (page - 1) * PAGE_SIZE}

    # Planned for the search they're given (prepare=False), as for YouTube's channels
    async def channels() -> list[TelegramChannel]:
        async with request.state.pool.connection() as conn:
            cursor = conn.cursor(row_factory=class_row(TelegramChannel))
            query = CHANNELS.format(where=where, order=ORDERS[sort])
            return await (await cursor.execute(query, values, prepare=False)).fetchall()

    async def total() -> int:
        async with request.state.pool.connection() as conn:
            (count,) = await (await conn.execute(COUNT.format(where=where), values, prepare=False)).fetchone()
            return count

    found, count = await asyncio.gather(channels(), total())  # each on a connection of its own, at the same time
    return TelegramChannels(channels=found, total=count, page_size=PAGE_SIZE)


CHANNEL = (
    """
    SELECT c.channel_id AS id, c.username, c.title, c.description, c.subscriber_count AS subscribers,
        c.last_message_at, last.last_message, c.photo_url
    FROM telegram_channels AS c
"""
    + LAST
    + """
    WHERE c.channel_id = %(channel)s
"""
)
MESSAGE_COUNT = "SELECT count(*) FROM telegram_messages WHERE channel_id = %(channel)s"


@router.get(
    "/api/telegram/channels/{channel_id}",
    responses=failures(
        {
            401: "not_signed_in: no session, or it ended",
            403: "forbidden: only admins see this; must_change_password: the temporary password isn't changed yet",
            404: "not_found: no channel with that ID is monitored",
            422: "invalid_request: that isn't a channel's ID",
        }
    ),
)
async def telegram_channel(
    request: Request, _: Admin, channel_id: Annotated[int, Path(ge=1)]
) -> TelegramChannelDetails:
    """A monitored channel's details, and how many of its messages have been saved"""

    async def details() -> dict | None:
        async with request.state.pool.connection() as conn:
            cursor = conn.cursor(row_factory=dict_row)
            return await (await cursor.execute(CHANNEL, {"channel": channel_id})).fetchone()

    async def saved() -> int:
        async with request.state.pool.connection() as conn:
            (count,) = await (await conn.execute(MESSAGE_COUNT, {"channel": channel_id})).fetchone()
            return count

    channel, count = await asyncio.gather(details(), saved())
    if channel is None:
        raise Failure(404, "not_found", "No channel with that ID is monitored")
    return TelegramChannelDetails(**channel, messages=count)


# Newest first: a channel's messages are numbered as they come out, and the table's key keeps them in that order. A
# search reads all the channel's messages: 50 ms for the one with the most (7,000).
MESSAGES = sql.SQL("""
    SELECT message_id AS id, published_at, text FROM telegram_messages WHERE channel_id = %(channel)s {search}
    ORDER BY message_id DESC LIMIT %(limit)s OFFSET %(offset)s
""")
# Lowercase, apostrophes left out, as the channels' search
FOUND = sql.SQL("AND app.searchable(text) LIKE app.searchable(%(pattern)s)")


@router.get(
    "/api/telegram/channels/{channel_id}/messages",
    responses=failures(
        {
            401: "not_signed_in: no session, or it ended",
            403: "forbidden: only admins see this; must_change_password: the temporary password isn't changed yet",
            422: "invalid_request: that isn't a channel's ID, or a parameter is out of its range",
        }
    ),
)
async def telegram_channel_messages(
    request: Request,
    _: Admin,
    channel_id: Annotated[int, Path(ge=1)],
    search: Annotated[str, Query(max_length=SEARCH_MAX, description="Part of a message's text")] = "",
    page: Annotated[int, Query(ge=1, le=LAST_PAGE, description=f"{PAGE_SIZE} messages to a page")] = 1,
) -> TelegramMessages:
    """A channel's saved messages, newest first, a page at a time (a channel that isn't monitored has none); with a
    search, only those whose text has it in them, whatever the case of its letters, and apostrophes aside. How many
    there are is in the channel's details, so that a page isn't counted again."""
    search = " ".join(search.split())
    values = {"channel": channel_id, "pattern": anywhere(search), "limit": PAGE_SIZE, "offset": (page - 1) * PAGE_SIZE}
    query = MESSAGES.format(search=FOUND if search else sql.SQL(""))
    async with request.state.pool.connection() as conn:
        cursor = conn.cursor(row_factory=class_row(TelegramMessage))
        messages = await (await cursor.execute(query, values, prepare=False if search else None)).fetchall()
    return TelegramMessages(messages=messages, page_size=PAGE_SIZE)
