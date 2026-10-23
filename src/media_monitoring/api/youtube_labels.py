"""The names labelled in YouTube texts (app.youtube_labels), for admins to check as they check Telegram's (telegram.py):
a channel's labelled texts, its videos' titles and descriptions and comments under its videos, with the names labelled
by hand, or another labeller's compared with them (GET /api/youtube/channels/{channel_id}/labelled); the hand's names
set again (PUT /api/youtube/videos/{video_id}/names, .../comments/{comment_id}/names) or marked checked (.../checked);
and how far the checking has got (GET /api/youtube/labelled). The channel list keeps to the labelled channels with
?labelled (youtube.py). A video's text is its title, then, if it has a description, a blank line and the description,
as the names were labelled in it; a comment's is its own."""

import logging
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Path, Query, Request
from psycopg.rows import dict_row
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
from media_monitoring.api.youtube import CHANNEL_ID, VIDEO_ID

COMMENT_ID = r"^[A-Za-z0-9_.-]{1,100}$"  # YouTube's: Ug… and 20-odd more characters; a reply's, a dot and more

log = logging.getLogger("media_monitoring.api")
router = APIRouter()


class LabelledText(BaseModel):
    video_id: str
    comment_id: str | None  # None for the video's own text
    kind: Literal["video", "short", "comment"]  # the video's kind, or a comment under it
    video_title: str | None  # the video's, for a comment too
    published_at: datetime | None  # the video's
    text: str  # as name finders read it (see the module)
    # The names labelled by hand, or the source's, each compared with the hand's (see LabelledName.verdict), in order
    names: list[LabelledName]
    checked_at: datetime | None  # when an admin marked its names labelled by hand checked


class LabelledTexts(BaseModel):
    texts: list[LabelledText]


# A text of video v, or of comment c under it, as its names were labelled in it
TEXT = r"""CASE WHEN c.comment_id IS NULL THEN coalesce(v.title, '') || CASE WHEN coalesce(v.description, '') <> ''
    THEN E'\n\n' || v.description ELSE '' END ELSE c.text END"""
# A channel's texts labelled by hand that the source labelled too, the newest videos first, each video's own text
# before its comments
TEXTS = f"""
    SELECT h.video_id, nullif(h.comment_id, '') AS comment_id,
        CASE WHEN h.comment_id <> '' THEN 'comment' WHEN v.kind = 'short' THEN 'short' ELSE 'video' END AS kind,
        v.title AS video_title, v.published_at, {TEXT} AS text, l.names, h.names AS hand, h.checked_at
    FROM app.youtube_labels AS h
    JOIN youtube_videos AS v USING (video_id)
    LEFT JOIN youtube_comments AS c ON h.comment_id <> '' AND c.video_id = h.video_id AND c.comment_id = h.comment_id
    JOIN app.youtube_labels AS l ON l.video_id = h.video_id AND l.comment_id = h.comment_id AND l.source = %(source)s
    WHERE h.source = 'hand' AND v.channel_id = %(channel)s
    ORDER BY v.published_at DESC NULLS LAST, h.video_id, h.comment_id
"""


@router.get(
    "/api/youtube/channels/{channel_id}/labelled",
    responses=failures(
        {
            401: "not_signed_in: no session, or it ended",
            403: "forbidden: only admins see this; must_change_password: the temporary password isn't changed yet",
            422: "invalid_request: that isn't a channel's ID",
        }
    ),
)
async def youtube_labelled_texts(
    request: Request,
    _: Admin,
    channel_id: Annotated[str, Path(pattern=CHANNEL_ID)],
    source: Annotated[
        Labeller,
        Query(
            description="Whose names come with the texts: labelled by hand (as admins correct them), Claude's as "
            "first made, or Gemma 4 26B's"
        ),
    ] = "hand",
) -> LabelledTexts:
    """A channel's labelled texts, its videos' and the comments under them (a few, at most a dozen), with the names
    labelled by hand in them, or another labeller's, compared with the hand's; none for a channel with no labelled
    text."""
    async with request.state.pool.connection() as conn:
        cursor = conn.cursor(row_factory=dict_row)
        rows = await (await cursor.execute(TEXTS, {"channel": channel_id, "source": source})).fetchall()
    texts = []
    for row in rows:
        names, hand = row.pop("names"), row.pop("hand")
        if source != "hand":
            names = compared(names, hand)
        texts.append(LabelledText(**row, names=in_utf16(row["text"], names)))
    return LabelledTexts(texts=texts)


VIDEO_TEXT = f"""
    SELECT {TEXT} FROM youtube_videos AS v
    LEFT JOIN youtube_comments AS c ON %(comment)s <> '' AND c.video_id = v.video_id AND c.comment_id = %(comment)s
    WHERE v.video_id = %(video)s AND (%(comment)s = '' OR c.comment_id IS NOT NULL)
"""
SAVE_NAMES = """
    INSERT INTO app.youtube_labels (video_id, comment_id, source, names) VALUES (%s, %s, 'hand', %s)
    ON CONFLICT (video_id, comment_id, source) DO UPDATE SET names = EXCLUDED.names
"""


async def label(request: Request, user: Admin, video: str, comment: str, body: NamesChange) -> list[LabelledName]:
    """Sets the names labelled by hand in a video's text, or a comment's (comment not ''), all of them at once"""
    async with request.state.pool.connection() as conn, conn.transaction():
        row = await (await conn.execute(VIDEO_TEXT, {"video": video, "comment": comment})).fetchone()
        if row is None:
            raise Failure(404, "not_found", "No such video or comment is saved")
        text = row[0]
        names = placed(text, body.names)
        await conn.execute(SAVE_NAMES, [video, comment, Jsonb(names)])
    log.info(
        "youtube text labelled",
        extra={"fields": {"video": video, "comment": comment, "names": len(names), "user": user.id}},
    )
    return [LabelledName(**name) for name in in_utf16(text, names)]


LABEL_FAILURES = failures(
    {
        401: "not_signed_in: no session, or it ended",
        403: "forbidden: only admins do this; must_change_password: the temporary password isn't changed yet",
        404: "not_found: no such video or comment is saved",
        422: "invalid_request: that isn't a video's or a comment's ID; invalid_names: a name is out of the text, "
        "splits a character, has no letters, or overlaps another",
    }
)


@router.put("/api/youtube/videos/{video_id}/names", responses=LABEL_FAILURES)
async def label_video(
    request: Request, user: Admin, video_id: Annotated[str, Path(pattern=VIDEO_ID)], body: NamesChange
) -> list[LabelledName]:
    """Sets the names labelled by hand in a video's text (its title and description), all of them at once: each its
    kind and where it is in the text, as the labelled texts give them (in UTF-16 units). Gives the names back as saved,
    in order."""
    return await label(request, user, video_id, "", body)


@router.put("/api/youtube/videos/{video_id}/comments/{comment_id}/names", responses=LABEL_FAILURES)
async def label_comment(
    request: Request,
    user: Admin,
    video_id: Annotated[str, Path(pattern=VIDEO_ID)],
    comment_id: Annotated[str, Path(pattern=COMMENT_ID)],
    body: NamesChange,
) -> list[LabelledName]:
    """Sets the names labelled by hand in a comment, as in a video's text."""
    return await label(request, user, video_id, comment_id, body)


CHECK = """
    UPDATE app.youtube_labels SET checked_at = CASE WHEN %(checked)s THEN now() END
    WHERE video_id = %(video)s AND comment_id = %(comment)s AND source = 'hand'
    RETURNING checked_at
"""


async def check(request: Request, user: Admin, video: str, comment: str, body: CheckChange) -> LabelCheck:
    async with request.state.pool.connection() as conn:
        values = {"checked": body.checked, "video": video, "comment": comment}
        row = await (await conn.execute(CHECK, values)).fetchone()
    if row is None:
        raise Failure(404, "not_found", "The text isn't labelled by hand")
    log.info(
        "youtube text checked",
        extra={"fields": {"video": video, "comment": comment, "checked": body.checked, "user": user.id}},
    )
    return LabelCheck(checked_at=row[0])


CHECK_FAILURES = failures(
    {
        401: "not_signed_in: no session, or it ended",
        403: "forbidden: only admins do this; must_change_password: the temporary password isn't changed yet",
        404: "not_found: the text isn't labelled by hand",
        422: "invalid_request: that isn't a video's or a comment's ID",
    }
)


@router.put("/api/youtube/videos/{video_id}/checked", responses=CHECK_FAILURES)
async def check_video(
    request: Request, user: Admin, video_id: Annotated[str, Path(pattern=VIDEO_ID)], body: CheckChange
) -> LabelCheck:
    """Marks the names labelled by hand in a video's text checked (or not any more), so that what's left shows."""
    return await check(request, user, video_id, "", body)


@router.put("/api/youtube/videos/{video_id}/comments/{comment_id}/checked", responses=CHECK_FAILURES)
async def check_comment(
    request: Request,
    user: Admin,
    video_id: Annotated[str, Path(pattern=VIDEO_ID)],
    comment_id: Annotated[str, Path(pattern=COMMENT_ID)],
    body: CheckChange,
) -> LabelCheck:
    """Marks the names labelled by hand in a comment checked (or not any more)."""
    return await check(request, user, video_id, comment_id, body)


class YouTubeLabelProgress(BaseModel):
    texts: int  # the texts labelled by hand (with names, or as having none)
    checked: int  # of them, those marked checked
    next: str | None  # the next channel with a text to check, in the labelled list's order; None when all are


# Each channel with texts labelled by hand, in the channel list's order (the biggest first), with how many there are
# and how many are checked: some 500 channels
PROGRESS = """
    SELECT v.channel_id, count(*) AS texts, count(l.checked_at) AS checked
    FROM app.youtube_labels AS l JOIN youtube_videos AS v USING (video_id) JOIN youtube_channels AS c USING (channel_id)
    WHERE l.source = 'hand'
    GROUP BY v.channel_id, c.subscriber_count
    ORDER BY c.subscriber_count DESC NULLS LAST, v.channel_id
"""


@router.get(
    "/api/youtube/labelled",
    responses=failures(
        {
            401: "not_signed_in: no session, or it ended",
            403: "forbidden: only admins see this; must_change_password: the temporary password isn't changed yet",
            422: "invalid_request: that isn't a channel's ID",
        }
    ),
)
async def youtube_labelled_progress(
    request: Request,
    _: Admin,
    after: Annotated[
        str | None,
        Query(pattern=CHANNEL_ID, description="The channel open: the next one is after it, else from the first"),
    ] = None,
) -> YouTubeLabelProgress:
    """How far the checking of the names labelled by hand in YouTube texts has got: the texts with them, how many are
    checked, and the next channel with a text still to check (after the one given, in the labelled list's order,
    round to the first)."""
    async with request.state.pool.connection() as conn:
        rows = await (await conn.execute(PROGRESS)).fetchall()
    left = {channel for channel, texts, checked in rows if checked < texts}
    ids = [channel for channel, _, _ in rows]
    start = ids.index(after) + 1 if after in ids else 0
    following = [channel for channel in ids[start:] + ids[:start] if channel in left]
    return YouTubeLabelProgress(
        texts=sum(row[1] for row in rows),
        checked=sum(row[2] for row in rows),
        next=next((channel for channel in following if channel != after), None),
    )
