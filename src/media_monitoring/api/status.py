"""GET /api/status: how much the database holds."""

from fastapi import APIRouter, Request
from pydantic import BaseModel

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


@router.get("/api/status")
async def status(request: Request) -> Status:
    """How many YouTube channels, videos and comments, and Telegram channels and messages the database holds."""
    async with request.state.pool.connection() as conn:
        rows = dict(await (await conn.execute(COUNTS)).fetchall())
    return Status(
        youtube=YouTubeCounts(
            channels=rows["youtube_channels"], videos=rows["youtube_videos"], comments=rows["youtube_comments"]
        ),
        telegram=TelegramCounts(channels=rows["telegram_channels"], messages=rows["telegram_messages"]),
    )
