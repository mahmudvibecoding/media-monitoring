"""GET /api/status: how much the database holds, for admins: the channels the site lists, with something collected,
and every video, comment and message."""

import asyncio

from fastapi import APIRouter, Request
from pydantic import BaseModel

from media_monitoring.api.accounts import Admin
from media_monitoring.api.errors import failures

router = APIRouter()

# Each table's rows as PostgreSQL counts them, as rows come and go: reading that takes a millisecond, while counting
# the rows takes minutes for the biggest tables. A crash starts that count again from 0 and forgets when PostgreSQL
# last checked the table; until it checks it again, the count since is added to its estimate from before.
COUNTS = """
    SELECT s.relname,
        CASE WHEN coalesce(s.last_vacuum, s.last_autovacuum, s.last_analyze, s.last_autoanalyze) IS NULL
            THEN greatest(c.reltuples::bigint, 0) + s.n_live_tup
            ELSE s.n_live_tup END
    FROM pg_stat_user_tables s JOIN pg_class c ON c.oid = s.relid
    WHERE s.schemaname = 'public'
"""
# The channels the lists show (app.sql): with a video, with a saved message, counted from their indexes, which hold only
# those: 46 ms for YouTube's 55,600 and 20 ms for Telegram's 30,272
LISTED = {
    "youtube": "SELECT count(*) FROM youtube_channels WHERE has_videos",
    "telegram": "SELECT count(*) FROM telegram_channels WHERE has_messages",
}


class YouTubeCounts(BaseModel):
    channels: int
    videos: int
    comments: int


class TelegramCounts(BaseModel):
    channels: int
    messages: int


class Status(BaseModel):
    youtube: YouTubeCounts
    telegram: TelegramCounts


@router.get(
    "/api/status",
    responses=failures(
        {
            401: "not_signed_in: no session, or it ended",
            403: "forbidden: only admins see this; must_change_password: the temporary password isn't changed yet",
        }
    ),
)
async def status(request: Request, _: Admin) -> Status:
    """How many YouTube channels (with a video), videos and comments, and Telegram channels (with a saved message) and
    messages the database holds."""

    async def read(query: str) -> list[tuple]:
        async with request.state.pool.connection() as conn:
            return await (await conn.execute(query)).fetchall()

    # Each on a connection of its own, at the same time
    counts, [(youtube_channels,)], [(telegram_channels,)] = await asyncio.gather(
        read(COUNTS), read(LISTED["youtube"]), read(LISTED["telegram"])
    )
    rows = dict(counts)
    return Status(
        youtube=YouTubeCounts(
            channels=youtube_channels, videos=rows["youtube_videos"], comments=rows["youtube_comments"]
        ),
        telegram=TelegramCounts(channels=telegram_channels, messages=rows["telegram_messages"]),
    )
