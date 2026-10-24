"""The labelled texts where another labeller's names differ from the hand's, Telegram's and YouTube's together, for admins
to review a model's mistakes in one list (GET /api/labels/disagreements): by where the texts are from and by the kind of
difference, a page at a time. The 2,000 labelled texts' names are compared as they're asked for, so that a correction
made by hand shows at once; only the texts of the page shown are read."""

from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Query, Request
from psycopg.rows import dict_row
from pydantic import BaseModel

from media_monitoring.api.accounts import Admin
from media_monitoring.api.errors import failures
from media_monitoring.api.labels import LabelledName, compared, in_utf16
from media_monitoring.api.youtube_labels import TEXT

router = APIRouter()
PAGE_SIZE = 50

Platform = Literal["telegram", "youtube_video", "youtube_short", "youtube_comment"]
# How a labeller's names differ from the hand's in a text: a hand's name it missed, a name of its own the hand hasn't
# (or that isn't written in the text), one the hand has as another kind, or the same name with other boundaries
Difference = Literal["missed", "extra", "kind", "part"]


class DisagreementText(BaseModel):
    platform: Platform
    channel_id: str  # Telegram's number or YouTube's ID, as the channel's page is addressed
    channel_title: str | None
    message_id: int | None  # Telegram's
    video_id: str | None  # YouTube's
    comment_id: str | None  # a YouTube comment's
    video_title: str | None  # the video a YouTube comment is under, or the video's own
    text: str  # as name finders read it
    names: list[LabelledName]  # the labeller's, each compared with the hand's (see LabelledName.verdict)
    differences: list[Difference]
    checked_at: datetime | None  # when an admin marked the hand's names checked


class Disagreements(BaseModel):
    texts: list[DisagreementText]  # this page's
    total: int  # the texts that match, on all the pages
    page_size: int
    platforms: dict[str, int]  # the texts with a difference (of the kind asked for) from each platform
    differences: dict[str, int]  # the texts (from the platform asked for) with each kind of difference


# The names of all the labelled texts, the hand's and the source's, with what's needed to compare, count and order them:
# Telegram's first, then YouTube's, the biggest channels first; the texts themselves only for the page shown (below)
NAMES = """
    SELECT * FROM (
        SELECT 'telegram' AS platform, h.channel_id::text AS channel_id, h.message_id, NULL AS video_id,
            NULL AS comment_id, l.names, h.names AS hand, h.checked_at, c.subscriber_count
        FROM app.telegram_message_labels AS h
        JOIN app.telegram_message_labels AS l
            ON l.channel_id = h.channel_id AND l.message_id = h.message_id AND l.source = %(source)s
        JOIN telegram_channels AS c ON c.channel_id = h.channel_id
        WHERE h.source = 'hand'
        UNION ALL
        SELECT CASE WHEN h.comment_id <> '' THEN 'youtube_comment' WHEN v.kind = 'short' THEN 'youtube_short'
                ELSE 'youtube_video' END,
            v.channel_id, NULL, h.video_id, h.comment_id, l.names, h.names, h.checked_at, ch.subscriber_count
        FROM app.youtube_labels AS h
        JOIN app.youtube_labels AS l ON l.video_id = h.video_id AND l.comment_id = h.comment_id AND l.source = %(source)s
        JOIN youtube_videos AS v ON v.video_id = h.video_id
        JOIN youtube_channels AS ch ON ch.channel_id = v.channel_id
        WHERE h.source = 'hand'
    ) AS labelled
    ORDER BY platform <> 'telegram', subscriber_count DESC NULLS LAST, channel_id, message_id, video_id, comment_id
"""
TELEGRAM_TEXTS = """
    SELECT 'telegram' AS platform, m.channel_id::text AS channel_id, m.message_id, m.text, c.title AS channel_title
    FROM unnest(%(channels)s::bigint[], %(messages)s::integer[]) AS t (channel_id, message_id)
    JOIN telegram_messages AS m ON m.channel_id = t.channel_id AND m.message_id = t.message_id
    JOIN telegram_channels AS c ON c.channel_id = m.channel_id
"""
YOUTUBE_TEXTS = f"""
    SELECT 'youtube' AS platform, t.video_id, t.comment_id, {TEXT} AS text, v.title AS video_title,
        ch.title AS channel_title
    FROM unnest(%(videos)s::text[], %(comments)s::text[]) AS t (video_id, comment_id)
    JOIN youtube_videos AS v ON v.video_id = t.video_id
    JOIN youtube_channels AS ch ON ch.channel_id = v.channel_id
    LEFT JOIN youtube_comments AS c ON t.comment_id <> '' AND c.video_id = t.video_id AND c.comment_id = t.comment_id
"""


def place(row: dict) -> tuple:
    """Which text a row is of: a Telegram post's channel and message, or a YouTube video and comment ('' for the
    video's own text)"""
    if row["platform"] == "telegram":
        return row["channel_id"], row["message_id"]
    return row["video_id"], row["comment_id"]


def differences(names: list[dict]) -> list[str]:
    """The kinds of difference among a text's compared names, in a set order"""
    found = {name.get("verdict") for name in names if name.get("verdict") not in (None, "right")}
    if any(name["start"] is None for name in names):
        found.add("extra")
    return [kind for kind in ("missed", "extra", "kind", "part") if kind in found]


@router.get(
    "/api/labels/disagreements",
    responses=failures(
        {
            401: "not_signed_in: no session, or it ended",
            403: "forbidden: only admins see this; must_change_password: the temporary password isn't changed yet",
            422: "invalid_request: a parameter is out of its range",
        }
    ),
)
async def disagreements(
    request: Request,
    _: Admin,
    source: Annotated[
        Literal["claude", "gemma"], Query(description="Whose names are compared with the hand's")
    ] = "gemma",
    platform: Annotated[Platform | None, Query(description="Only the texts from here")] = None,
    difference: Annotated[Difference | None, Query(description="Only the texts with this kind of difference")] = None,
    page: Annotated[int, Query(ge=1, le=100, description=f"{PAGE_SIZE} texts to a page")] = 1,
) -> Disagreements:
    """The labelled texts, Telegram's then YouTube's, the biggest channels first, where the source's names differ from
    the hand's: each with the source's names compared with the hand's, and what kinds of difference it has; with how
    many texts there are of each platform and each kind of difference."""
    async with request.state.pool.connection() as conn:
        cursor = conn.cursor(row_factory=dict_row)
        texts = []
        for row in await (await cursor.execute(NAMES, {"source": source})).fetchall():
            names = compared(row["names"], row["hand"])
            found = differences(names)
            if found:
                texts.append((row, names, found))
        platforms, kinds = {}, {}
        for row, _, found in texts:
            if difference is None or difference in found:
                platforms[row["platform"]] = platforms.get(row["platform"], 0) + 1
            if platform is None or row["platform"] == platform:
                for kind in found:
                    kinds[kind] = kinds.get(kind, 0) + 1
        chosen = [
            (row, names, found)
            for row, names, found in texts
            if (platform is None or row["platform"] == platform) and (difference is None or difference in found)
        ]
        shown = chosen[(page - 1) * PAGE_SIZE : page * PAGE_SIZE]
        posts = [row for row, _, _ in shown if row["platform"] == "telegram"]
        videos = [row for row, _, _ in shown if row["platform"] != "telegram"]
        read = []
        if posts:
            query = {"channels": [int(r["channel_id"]) for r in posts], "messages": [r["message_id"] for r in posts]}
            read += await (await cursor.execute(TELEGRAM_TEXTS, query)).fetchall()
        if videos:
            query = {"videos": [r["video_id"] for r in videos], "comments": [r["comment_id"] for r in videos]}
            read += await (await cursor.execute(YOUTUBE_TEXTS, query)).fetchall()
    read = {place(text): text for text in read}
    return Disagreements(
        texts=[
            DisagreementText(
                platform=row["platform"],
                channel_id=row["channel_id"],
                channel_title=read[place(row)]["channel_title"],
                message_id=row["message_id"],
                video_id=row["video_id"],
                comment_id=row["comment_id"] or None,
                video_title=read[place(row)].get("video_title"),
                text=read[place(row)]["text"],
                names=in_utf16(read[place(row)]["text"], names),
                differences=found,
                checked_at=row["checked_at"],
            )
            for row, names, found in shown
        ],
        total=len(chosen),
        page_size=PAGE_SIZE,
        platforms=platforms,
        differences=kinds,
    )
