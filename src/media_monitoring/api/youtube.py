"""The collected YouTube data, for admins: GET /api/youtube/channels, the monitored channels a page at a time, searched
and in the order the site's channels page asks for. The column and the indexes it reads them by are in app.sql."""

import asyncio
from typing import Annotated, Literal

from fastapi import APIRouter, Query, Request
from psycopg import sql
from psycopg.rows import class_row
from pydantic import BaseModel

from media_monitoring.api.accounts import Admin
from media_monitoring.api.errors import failures

PAGE_SIZE = 50  # channels
LAST_PAGE = 10_000  # the furthest a page may be, so that skipping to it stays quick
SEARCH_MAX = 100  # characters

router = APIRouter()


class YouTubeChannel(BaseModel):
    id: str
    title: str | None  # None until the channels collector has fetched the channel's details
    handle: str | None  # with its @
    avatar_url: str | None
    subscribers: int | None  # None when the channel hides the count


class YouTubeChannels(BaseModel):
    channels: list[YouTubeChannel]  # this page's
    total: int  # how many channels match, on all the pages
    page_size: int


# The page's channels are picked from the order's index alone, which holds their IDs, and only those are read from the
# table: a page far down then takes milliseconds, not the 0.4 s of reading and sorting every channel
PAGE = sql.SQL("""
    SELECT c.channel_id AS id, c.title, c.handle, c.avatar_url, c.subscriber_count AS subscribers
    FROM (SELECT channel_id FROM youtube_channels {where} ORDER BY {order} LIMIT %(limit)s OFFSET %(offset)s) AS page
    JOIN youtube_channels AS c USING (channel_id)
    ORDER BY {order}
""")
COUNT = sql.SQL("SELECT count(*) FROM youtube_channels {where}")
SEARCHED = sql.SQL("WHERE search_text LIKE app.searchable(%(pattern)s)")  # lowercase, apostrophes left out (app.sql)
# Each order ends with the channel's ID, so that channels that tie keep their places from one page to the next
ORDERS = {
    "subscribers": sql.SQL("subscriber_count DESC NULLS LAST, channel_id"),
    "name": sql.SQL("title COLLATE app.names, channel_id"),  # alphabetical, the channels without a name yet last
}


def anywhere(text: str) -> str:
    """A LIKE pattern for the text anywhere in a value: the text's own %, _ and \\ count as themselves"""
    return "%" + text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


@router.get(
    "/api/youtube/channels",
    responses=failures(
        {
            401: "not_signed_in: no session, or it ended",
            403: "forbidden: only admins see this; must_change_password: the temporary password isn't changed yet",
            422: "invalid_request: a parameter is out of its range",
        }
    ),
)
async def youtube_channels(
    request: Request,
    _: Admin,
    search: Annotated[str, Query(max_length=SEARCH_MAX, description="Part of a channel's name or handle")] = "",
    sort: Annotated[Literal["subscribers", "name"], Query(description="The biggest first, or by name")] = "subscribers",
    page: Annotated[int, Query(ge=1, le=LAST_PAGE, description=f"{PAGE_SIZE} channels to a page")] = 1,
) -> YouTubeChannels:
    """The monitored channels, a page at a time, the biggest first or by name. With a search, only the channels whose
    name or handle has it in them, whatever the case of its letters, and apostrophes aside: zor finds Zo‘r."""
    search = " ".join(search.split())
    where = SEARCHED if search else sql.SQL("")
    values = {"pattern": anywhere(search), "limit": PAGE_SIZE, "offset": (page - 1) * PAGE_SIZE}

    # Both queries are planned for the search they're given (prepare=False): a plan made once for any search would
    # look up a single letter in the trigram index, which can't narrow it down
    async def channels() -> list[YouTubeChannel]:
        async with request.state.pool.connection() as conn:
            cursor = conn.cursor(row_factory=class_row(YouTubeChannel))
            query = PAGE.format(where=where, order=ORDERS[sort])
            return await (await cursor.execute(query, values, prepare=False)).fetchall()

    async def total() -> int:
        async with request.state.pool.connection() as conn:
            (count,) = await (await conn.execute(COUNT.format(where=where), values, prepare=False)).fetchone()
            return count

    # Each on a connection of its own, at the same time: counting every match takes the longer, up to 50 ms
    found, count = await asyncio.gather(channels(), total())
    return YouTubeChannels(channels=found, total=count, page_size=PAGE_SIZE)
