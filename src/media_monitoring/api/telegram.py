"""The collected Telegram data, for admins: the monitored channels a page at a time, searched and in the order the
site's channels page asks for, each with its latest message (GET /api/telegram/channels), a channel's details
(.../{channel_id}), its photo (.../{channel_id}/photo), and its saved messages, newest first, all of them or those a
search finds (.../{channel_id}/messages). Both lists can keep to the messages whose names were labelled by hand
(app.telegram_message_labels), and the messages come with those names, or with the names another labeller found in
them, compared with the hand's; admins correct the hand's (.../messages/{message_id}/names). The column and the
indexes the channel list reads them by are in app.sql; a channel's messages come by the messages table's key."""

import asyncio
import logging
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Path, Query, Request, Response
from psycopg import sql
from psycopg.rows import class_row, dict_row
from psycopg.types.json import Jsonb
from pydantic import BaseModel

from media_monitoring.api.accounts import Admin
from media_monitoring.api.errors import Failure, failures
from media_monitoring.api.labels import (
    CheckChange,
    LabelCheck,
    LabelledName,
    Labeller,
    NamesChange,
    compared,
    in_utf16,
    placed,
)
from media_monitoring.api.lists import LAST_PAGE, PAGE_SIZE, SEARCH_MAX, anywhere

log = logging.getLogger("media_monitoring.api")
router = APIRouter()


class TelegramChannel(BaseModel):
    id: int  # Telegram's ID for the channel, which never changes
    username: str  # without the @: its public page is t.me/<username>
    title: str | None
    subscribers: int | None  # exact below 1,000; Telegram's page rounds bigger counts to three digits (1.14M)
    last_message_at: datetime | None  # when its latest message came out
    last_message: str | None  # its latest saved message's text, the first 200 characters, for a chat list's line
    photo_url: str | None  # its photo, 160 × 160 (see PHOTO); None without one
    # In the labelled list: how many of its messages labelled by hand aren't marked checked yet
    unchecked: int | None = None


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
    # The names labelled in it, by hand or by a model (see the messages' source), in order; None for a message that
    # wasn't labelled
    names: list[LabelledName] | None
    checked_at: datetime | None = None  # when an admin marked its names labelled by hand checked


class TelegramMessages(BaseModel):
    messages: list[TelegramMessage]  # this page's: fewer than page_size on the last one
    page_size: int


# A channel's photo, for the site's pages: the one the channels step saved, from this API (see telegram_channel_photo),
# with its fingerprint in the address, so a browser keeps it until the photo changes; Telegram's own link while none
# is saved (it lasts less than two days); NULL for a channel without a photo. It reads c, the channel, and photo, the
# saved photo SAVED_PHOTO joins on, of which only the fingerprint, not the image.
PHOTO = """CASE WHEN c.photo_url IS NULL THEN NULL
        WHEN photo.hash IS NULL THEN c.photo_url
        ELSE '/api/telegram/channels/' || c.channel_id || '/photo?v=' || photo.hash END"""
SAVED_PHOTO = "LEFT JOIN telegram_channel_photos AS photo USING (channel_id)"
# As for YouTube's channels: the page's channels are picked from the order's index alone, and only those are read,
# each with its latest saved message, which the messages table's key gives at once, and its photo's fingerprint, by
# the photos' key: 10 ms for a page of 50
LAST = """
    LEFT JOIN LATERAL (
        SELECT left(m.text, 200) AS last_message FROM telegram_messages AS m
        WHERE m.channel_id = c.channel_id ORDER BY m.message_id DESC LIMIT 1
    ) AS last ON true
"""
CHANNELS = sql.SQL(
    f"""
    SELECT c.channel_id AS id, c.username, c.title, c.subscriber_count AS subscribers, c.last_message_at,
        last.last_message, {PHOTO} AS photo_url, {{unchecked}} AS unchecked
    FROM (SELECT channel_id FROM telegram_channels {{where}} ORDER BY {{order}} LIMIT %(limit)s OFFSET %(offset)s) AS page
    JOIN telegram_channels AS c USING (channel_id)
    {SAVED_PHOTO}
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
# Only the channels with a message labelled by hand (with names, or as having none), some 500, each found by its key
LABELLED = sql.SQL(" AND channel_id IN (SELECT channel_id FROM app.telegram_message_labels WHERE source = 'hand')")
# In the labelled list, each channel's messages labelled by hand that aren't checked yet, by the labels' key
UNCHECKED = sql.SQL("""(SELECT count(*) FROM app.telegram_message_labels AS l
    WHERE l.channel_id = c.channel_id AND l.source = 'hand' AND l.checked_at IS NULL)""")
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
    labelled: Annotated[bool, Query(description="Only the channels with a message labelled by hand")] = False,
    page: Annotated[int, Query(ge=1, le=LAST_PAGE, description=f"{PAGE_SIZE} channels to a page")] = 1,
) -> TelegramChannels:
    """The monitored channels that have a message saved, a page at a time, the biggest first or the latest to post
    first. With a search, only the channels whose name or username has it in them, whatever the case of its letters, and
    apostrophes aside; labelled, only those with a message labelled by hand."""
    search = " ".join(search.split())
    where = SEARCHED if search else LISTED
    if labelled:
        where += LABELLED
    values = {"pattern": anywhere(search), "limit": PAGE_SIZE, "offset": (page - 1) * PAGE_SIZE}

    # Planned for the search they're given (prepare=False), as for YouTube's channels
    async def channels() -> list[TelegramChannel]:
        async with request.state.pool.connection() as conn:
            cursor = conn.cursor(row_factory=class_row(TelegramChannel))
            unchecked = UNCHECKED if labelled else sql.SQL("NULL")
            query = CHANNELS.format(where=where, order=ORDERS[sort], unchecked=unchecked)
            return await (await cursor.execute(query, values, prepare=False)).fetchall()

    async def total() -> int:
        async with request.state.pool.connection() as conn:
            (count,) = await (await conn.execute(COUNT.format(where=where), values, prepare=False)).fetchone()
            return count

    found, count = await asyncio.gather(channels(), total())  # each on a connection of its own, at the same time
    return TelegramChannels(channels=found, total=count, page_size=PAGE_SIZE)


CHANNEL = (
    f"""
    SELECT c.channel_id AS id, c.username, c.title, c.description, c.subscriber_count AS subscribers,
        c.last_message_at, last.last_message, {PHOTO} AS photo_url
    FROM telegram_channels AS c
    {SAVED_PHOTO}
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


SAVED_IMAGE = "SELECT photo FROM telegram_channel_photos WHERE channel_id = %(channel)s"
KEEP = "private, max-age=31536000, immutable"  # a year: a new photo comes with a new address (see PHOTO)


@router.get(
    "/api/telegram/channels/{channel_id}/photo",
    response_class=Response,
    responses={200: {"content": {"image/jpeg": {}}, "description": "The photo"}}
    | failures(
        {
            401: "not_signed_in: no session, or it ended",
            403: "forbidden: only admins see this; must_change_password: the temporary password isn't changed yet",
            404: "not_found: no photo of that channel is saved",
            422: "invalid_request: that isn't a channel's ID",
        }
    ),
)
async def telegram_channel_photo(request: Request, _: Admin, channel_id: Annotated[int, Path(ge=1)]) -> Response:
    """A channel's photo (JPEG, 160 × 160), as the channels step saved it from Telegram, whose links to it last less
    than two days. The address the channels' details give carries the photo's fingerprint (v), so a browser keeps it
    for a year, and a new photo comes with a new address."""
    async with request.state.pool.connection() as conn:
        row = await (await conn.execute(SAVED_IMAGE, {"channel": channel_id})).fetchone()
    if row is None:
        raise Failure(404, "not_found", "No photo of that channel is saved")
    return Response(row[0], media_type="image/jpeg", headers={"Cache-Control": KEEP})


# Newest first: a channel's messages are numbered as they come out, and the table's key keeps them in that order, each
# with the labeller's names and the hand's, by the labels' key. A search reads all the channel's messages: 50 ms for
# the one with the most (7,000).
MESSAGES = sql.SQL("""
    SELECT m.message_id AS id, m.published_at, m.text, l.names, hand.names AS hand, hand.checked_at
    FROM telegram_messages AS m
    LEFT JOIN app.telegram_message_labels AS l
        ON l.channel_id = m.channel_id AND l.message_id = m.message_id AND l.source = %(source)s
    LEFT JOIN app.telegram_message_labels AS hand
        ON hand.channel_id = m.channel_id AND hand.message_id = m.message_id AND hand.source = 'hand'
    WHERE m.channel_id = %(channel)s {search} {labelled}
    ORDER BY m.message_id DESC LIMIT %(limit)s OFFSET %(offset)s
""")
# Lowercase, apostrophes left out, as the channels' search
FOUND = sql.SQL("AND app.searchable(m.text) LIKE app.searchable(%(pattern)s)")
# The messages labelled by hand (with names, or as having none), which the labeller labelled too, so that each shows the
# same ones
WITH_NAMES = sql.SQL("AND hand.names IS NOT NULL AND l.names IS NOT NULL")


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
    labelled: Annotated[
        bool, Query(description="Only the messages labelled by hand, which the source labelled too")
    ] = False,
    source: Annotated[
        Labeller,
        Query(
            description="Whose names come with the messages: labelled by hand (as admins correct them), Claude's as "
            "first made, or Gemma 4 26B's (in the posts labelled by hand)"
        ),
    ] = "hand",
    page: Annotated[int, Query(ge=1, le=LAST_PAGE, description=f"{PAGE_SIZE} messages to a page")] = 1,
) -> TelegramMessages:
    """A channel's saved messages, newest first, a page at a time (a channel that isn't monitored has none), each with
    the names labelled in it by hand, or another labeller's, compared with the hand's, if it was labelled; with a
    search, only those whose text has it in them, whatever the case of its letters, and apostrophes aside; labelled,
    only those labelled by hand. How many there are is in the channel's details, so that a page isn't counted
    again."""
    search = " ".join(search.split())
    values = {
        "channel": channel_id,
        "source": source,
        "pattern": anywhere(search),
        "limit": PAGE_SIZE,
        "offset": (page - 1) * PAGE_SIZE,
    }
    query = MESSAGES.format(search=FOUND if search else sql.SQL(""), labelled=WITH_NAMES if labelled else sql.SQL(""))
    async with request.state.pool.connection() as conn:
        cursor = conn.cursor(row_factory=dict_row)
        rows = await (await cursor.execute(query, values, prepare=False if search else None)).fetchall()
    messages = []
    for row in rows:
        names, hand = row.pop("names"), row.pop("hand")
        if names is not None and source != "hand":
            names = compared(names, hand or [])
        messages.append(TelegramMessage(**row, names=None if names is None else in_utf16(row["text"], names)))
    return TelegramMessages(messages=messages, page_size=PAGE_SIZE)


MESSAGE_TEXT = "SELECT text FROM telegram_messages WHERE channel_id = %s AND message_id = %s"
SAVE_NAMES = """
    INSERT INTO app.telegram_message_labels (channel_id, message_id, source, names) VALUES (%s, %s, 'hand', %s)
    ON CONFLICT (channel_id, message_id, source) DO UPDATE SET names = EXCLUDED.names
"""


@router.put(
    "/api/telegram/channels/{channel_id}/messages/{message_id}/names",
    responses=failures(
        {
            401: "not_signed_in: no session, or it ended",
            403: "forbidden: only admins do this; must_change_password: the temporary password isn't changed yet",
            404: "not_found: no such message is saved",
            422: "invalid_request: that isn't a message's ID; invalid_names: a name is out of the text, splits a "
            "character, has no letters, or overlaps another",
        }
    ),
)
async def label_message(
    request: Request,
    user: Admin,
    channel_id: Annotated[int, Path(ge=1)],
    message_id: Annotated[int, Path(ge=1)],
    body: NamesChange,
) -> list[LabelledName]:
    """Sets the names labelled by hand in a message, all of them at once: each its kind and where it is in the text,
    as the messages give them (in UTF-16 units). A message not labelled yet becomes one of the labelled. Gives the names
    back as saved, in order."""
    async with request.state.pool.connection() as conn, conn.transaction():
        row = await (await conn.execute(MESSAGE_TEXT, [channel_id, message_id])).fetchone()
        if row is None:
            raise Failure(404, "not_found", "No such message is saved")
        text = row[0]
        names = placed(text, body.names)
        await conn.execute(SAVE_NAMES, [channel_id, message_id, Jsonb(names)])
    log.info(
        "message labelled",
        extra={"fields": {"channel": channel_id, "message": message_id, "names": len(names), "user": user.id}},
    )
    return [LabelledName(**name) for name in in_utf16(text, names)]


CHECK = """
    UPDATE app.telegram_message_labels SET checked_at = CASE WHEN %(checked)s THEN now() END
    WHERE channel_id = %(channel)s AND message_id = %(message)s AND source = 'hand'
    RETURNING checked_at
"""


@router.put(
    "/api/telegram/channels/{channel_id}/messages/{message_id}/checked",
    responses=failures(
        {
            401: "not_signed_in: no session, or it ended",
            403: "forbidden: only admins do this; must_change_password: the temporary password isn't changed yet",
            404: "not_found: the message isn't labelled by hand",
            422: "invalid_request: that isn't a message's ID",
        }
    ),
)
async def check_message(
    request: Request,
    user: Admin,
    channel_id: Annotated[int, Path(ge=1)],
    message_id: Annotated[int, Path(ge=1)],
    body: CheckChange,
) -> LabelCheck:
    """Marks a message's names labelled by hand checked (or not any more), so that what's left to check shows."""
    async with request.state.pool.connection() as conn:
        values = {"checked": body.checked, "channel": channel_id, "message": message_id}
        row = await (await conn.execute(CHECK, values)).fetchone()
    if row is None:
        raise Failure(404, "not_found", "The message isn't labelled by hand")
    log.info(
        "message checked",
        extra={"fields": {"channel": channel_id, "message": message_id, "checked": body.checked, "user": user.id}},
    )
    return LabelCheck(checked_at=row[0])


class TelegramProgress(BaseModel):
    messages: int  # the messages labelled by hand (with names, or as having none)
    checked: int  # of them, those marked checked
    next: int | None  # the next channel with a message to check, in the labelled list's order; None when all are


# Each channel with messages labelled by hand, in the labelled list's order (the biggest first), with how many of them
# there are and how many are checked: some 500 channels
PROGRESS = """
    SELECT l.channel_id, count(*) AS messages, count(l.checked_at) AS checked
    FROM app.telegram_message_labels AS l JOIN telegram_channels AS c USING (channel_id)
    WHERE l.source = 'hand'
    GROUP BY l.channel_id, c.subscriber_count
    ORDER BY c.subscriber_count DESC NULLS LAST, l.channel_id
"""


@router.get(
    "/api/telegram/labelled",
    responses=failures(
        {
            401: "not_signed_in: no session, or it ended",
            403: "forbidden: only admins see this; must_change_password: the temporary password isn't changed yet",
            422: "invalid_request: that isn't a channel's ID",
        }
    ),
)
async def labelled_progress(
    request: Request,
    _: Admin,
    after: Annotated[
        int | None, Query(ge=1, description="The channel open: the next one is after it, else from the first")
    ] = None,
) -> TelegramProgress:
    """How far the checking of the names labelled by hand has got: the messages with them, how many are checked, and
    the next channel with a message still to check (after the one given, in the labelled list's order, round to the
    first)."""
    async with request.state.pool.connection() as conn:
        rows = await (await conn.execute(PROGRESS)).fetchall()
    left = {channel for channel, messages, checked in rows if checked < messages}
    ids = [channel for channel, _, _ in rows]
    start = ids.index(after) + 1 if after in ids else 0
    following = [channel for channel in ids[start:] + ids[:start] if channel in left]
    return TelegramProgress(
        messages=sum(row[1] for row in rows),
        checked=sum(row[2] for row in rows),
        next=next((channel for channel in following if channel != after), None),
    )
