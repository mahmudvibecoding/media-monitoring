"""The collected YouTube data, for admins: the monitored channels a page at a time, searched and in the order the
site's channels page asks for (GET /api/youtube/channels), a channel's details (.../{channel_id}), and its videos,
newest, most viewed or oldest first (.../{channel_id}/videos); a video's details (GET /api/youtube/videos/{video_id})
and its comments, newest first (.../{video_id}/comments). The column and the indexes the channel list reads them by are
in app.sql; a channel's videos come by the collectors' own index, by channel and day, and a video's comments by the
comments table's key."""

import asyncio
import re
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Path, Query, Request
from psycopg import sql
from psycopg.rows import class_row, dict_row
from pydantic import BaseModel

from media_monitoring.api.accounts import Admin
from media_monitoring.api.errors import Failure, failures
from media_monitoring.api.lists import LAST_PAGE, PAGE_SIZE, SEARCH_MAX, anywhere

CHANNEL_ID = r"^UC[A-Za-z0-9_-]{22}$"  # YouTube's: UC and 22 more characters
VIDEO_ID = r"^[A-Za-z0-9_-]{11}$"  # YouTube's: 11 characters

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


class VideoCounts(BaseModel):
    all: int
    video: int  # what YouTube calls videos, Shorts aside
    short: int  # its Shorts


class YouTubeChannelDetails(YouTubeChannel):
    description: str | None
    videos: VideoCounts  # how many of the channel's videos have been collected, of each kind


class YouTubeVideo(BaseModel):
    id: str
    title: str | None  # None until the details collector has fetched the video's details
    published_at: datetime | None  # None for a stream or a premiere that hasn't started yet
    duration: int | None  # seconds; None while a stream is live or upcoming
    kind: Literal["video", "short"] | None
    available: bool  # False once YouTube shows no video
    views: int | None  # None until the stats collector has been to it, or while a stream is live
    likes: int | None  # None when the video's likes are off
    comments: int | None  # how many YouTube shows, replies included


class YouTubeVideos(BaseModel):
    videos: list[YouTubeVideo]  # this page's: fewer than page_size on the last one
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
# Only the channels with a video (app.sql), and with a search, those it matches: lowercase, apostrophes left out
LISTED = sql.SQL("WHERE has_videos")
SEARCHED = sql.SQL("WHERE has_videos AND search_text LIKE app.searchable(%(pattern)s)")
# The biggest first; the channel's ID last, so that channels that tie keep their places from one page to the next
ORDER = sql.SQL("subscriber_count DESC NULLS LAST, channel_id")
MOST_TO_A_PAGE = 100  # the site asks for as many channels as fit its grid on the screen


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
    page: Annotated[int, Query(ge=1, le=LAST_PAGE)] = 1,
    size: Annotated[
        int, Query(ge=1, le=MOST_TO_A_PAGE, description="Channels to a page: as many as fit the screen")
    ] = (PAGE_SIZE),
) -> YouTubeChannels:
    """The monitored channels that have a video collected, a page at a time, the biggest first. With a search, only the
    channels whose name or handle has it in them, whatever the case of its letters, and apostrophes aside: zor finds
    Zo‘r."""
    search = " ".join(search.split())
    where = SEARCHED if search else LISTED
    values = {"pattern": anywhere(search), "limit": size, "offset": (page - 1) * size}

    # Both queries are planned for the search they're given (prepare=False): a plan made once for any search would
    # look up a single letter in the trigram index, which can't narrow it down
    async def channels() -> list[YouTubeChannel]:
        async with request.state.pool.connection() as conn:
            cursor = conn.cursor(row_factory=class_row(YouTubeChannel))
            query = PAGE.format(where=where, order=ORDER)
            return await (await cursor.execute(query, values, prepare=False)).fetchall()

    async def total() -> int:
        async with request.state.pool.connection() as conn:
            (count,) = await (await conn.execute(COUNT.format(where=where), values, prepare=False)).fetchone()
            return count

    # Each on a connection of its own, at the same time: counting every match takes the longer, up to 50 ms
    found, count = await asyncio.gather(channels(), total())
    return YouTubeChannels(channels=found, total=count, page_size=size)


CHANNEL = """
    SELECT channel_id AS id, title, handle, description, avatar_url, subscriber_count AS subscribers
    FROM youtube_channels WHERE channel_id = %(channel)s
"""
COUNTS = """
    SELECT count(*), count(*) FILTER (WHERE kind = 'video'), count(*) FILTER (WHERE kind = 'short')
    FROM youtube_videos WHERE channel_id = %(channel)s
"""


@router.get(
    "/api/youtube/channels/{channel_id}",
    responses=failures(
        {
            401: "not_signed_in: no session, or it ended",
            403: "forbidden: only admins see this; must_change_password: the temporary password isn't changed yet",
            404: "not_found: no channel with that ID is monitored",
            422: "invalid_request: that isn't a channel's ID",
        }
    ),
)
async def youtube_channel(
    request: Request, _: Admin, channel_id: Annotated[str, Path(pattern=CHANNEL_ID)]
) -> YouTubeChannelDetails:
    """A monitored channel's details, and how many of its videos have been collected, of each kind. Counting takes a
    few milliseconds for most channels, and 50 ms for the one with the most videos (20,176)."""

    async def details() -> dict | None:
        async with request.state.pool.connection() as conn:
            cursor = conn.cursor(row_factory=dict_row)
            return await (await cursor.execute(CHANNEL, {"channel": channel_id})).fetchone()

    async def counts() -> VideoCounts:
        async with request.state.pool.connection() as conn:
            every, video, short = await (await conn.execute(COUNTS, {"channel": channel_id})).fetchone()
            return VideoCounts(all=every, video=video, short=short)

    channel, videos = await asyncio.gather(details(), counts())  # each on a connection of its own, at the same time
    if channel is None:
        raise Failure(404, "not_found", "No channel with that ID is monitored")
    return YouTubeChannelDetails(**channel, videos=videos)


# A page of a channel's videos: its videos are picked first, and only those 50 are read with their stats. The newest or
# the oldest first come by the collectors' index, which gives a channel's videos by the day they came out (sorted by
# the time within each day): a millisecond. The most viewed first read every video's views: a few milliseconds for most
# channels, 0.25 s for the biggest (20,176 videos), as the stats are a table of their own.
VIDEOS = sql.SQL("""
    SELECT v.video_id AS id, v.title, v.published_at, v.duration_seconds AS duration, v.kind,
        v.status = 'available' AS available, s.views, s.likes, s.comments
    FROM ({page}) AS page
    JOIN youtube_videos AS v USING (video_id)
    LEFT JOIN youtube_video_stats AS s USING (video_id)
    ORDER BY {order}
""")
BY_DAY = sql.SQL("""
    SELECT video_id FROM youtube_videos AS v WHERE channel_id = %(channel)s {kind}
    ORDER BY {order} LIMIT %(limit)s OFFSET %(offset)s
""")
BY_VIEWS = sql.SQL("""
    SELECT v.video_id FROM youtube_videos AS v LEFT JOIN youtube_video_stats AS s USING (video_id)
    WHERE v.channel_id = %(channel)s {kind}
    ORDER BY {order} LIMIT %(limit)s OFFSET %(offset)s
""")
# Each order ends with the video's ID, so that videos that tie keep their places from one page to the next
ORDERS = {
    "newest": sql.SQL("v.upload_date DESC NULLS FIRST, v.published_at DESC NULLS LAST, v.video_id"),
    "popular": sql.SQL("s.views DESC NULLS LAST, v.video_id"),
    "oldest": sql.SQL("v.upload_date ASC NULLS LAST, v.published_at ASC NULLS LAST, v.video_id"),
}
OF_KIND = sql.SQL("AND v.kind = %(kind)s")


@router.get(
    "/api/youtube/channels/{channel_id}/videos",
    responses=failures(
        {
            401: "not_signed_in: no session, or it ended",
            403: "forbidden: only admins see this; must_change_password: the temporary password isn't changed yet",
            422: "invalid_request: that isn't a channel's ID, or a parameter is out of its range",
        }
    ),
)
async def youtube_channel_videos(
    request: Request,
    _: Admin,
    channel_id: Annotated[str, Path(pattern=CHANNEL_ID)],
    kind: Annotated[Literal["video", "short"] | None, Query(description="Only videos, or only Shorts")] = None,
    sort: Annotated[
        Literal["newest", "popular", "oldest"], Query(description="Newest, most viewed, or oldest first")
    ] = "newest",
    page: Annotated[int, Query(ge=1, le=LAST_PAGE, description=f"{PAGE_SIZE} videos to a page")] = 1,
) -> YouTubeVideos:
    """A channel's collected videos, newest first (or the most viewed, or the oldest), a page at a time, with their
    views, likes and comments (a channel that isn't monitored has none). How many there are of each kind is in the
    channel's details: counted again for every page, they'd take 50 ms of each page of the biggest channel."""
    values = {"channel": channel_id, "kind": kind, "limit": PAGE_SIZE, "offset": (page - 1) * PAGE_SIZE}
    order = ORDERS[sort]
    picked = (BY_VIEWS if sort == "popular" else BY_DAY).format(kind=OF_KIND if kind else sql.SQL(""), order=order)
    async with request.state.pool.connection() as conn:
        cursor = conn.cursor(row_factory=class_row(YouTubeVideo))
        videos = await (await cursor.execute(VIDEOS.format(page=picked, order=order), values)).fetchall()
    return YouTubeVideos(videos=videos, page_size=PAGE_SIZE)


class YouTubeVideoDetails(YouTubeVideo):
    description: str | None
    channel_id: str
    channel_title: str | None
    channel_avatar_url: str | None  # its channel's picture, as saved (900 px)
    channel_subscribers: int | None  # its channel's subscribers; None when hidden
    stats_updated_at: datetime | None  # when its views, likes and comment count were last read
    comments_collected: int  # its comments collected: YouTube's count has the replies too, which aren't
    comments_complete: bool  # its whole comment list has been read once; new comments are read as they come


class YouTubeComment(BaseModel):
    id: str
    author_name: str | None  # as YouTube shows it, most often the author's handle
    author_channel_id: str | None
    text: str | None
    # YouTube says only how long ago a comment was written ("2 months ago"), and the collector counts that back from
    # when it read the comment: written_at is as precise as the unit YouTube said it in
    written_at: datetime | None
    precision: Literal["second", "minute", "hour", "day", "week", "month", "year"] | None
    edited: bool


class YouTubeComments(BaseModel):
    comments: list[YouTubeComment]  # this page's: fewer than page_size on the last one
    page_size: int


VIDEO = """
    SELECT v.video_id AS id, v.title, v.description, v.published_at, v.duration_seconds AS duration, v.kind,
        v.status = 'available' AS available, v.channel_id, c.title AS channel_title, c.avatar_url AS channel_avatar_url,
        c.subscriber_count AS channel_subscribers, s.views, s.likes, s.comments,
        s.updated_at AS stats_updated_at, coalesce(s.comments_complete, false) AS comments_complete
    FROM youtube_videos AS v
    JOIN youtube_channels AS c USING (channel_id)
    LEFT JOIN youtube_video_stats AS s USING (video_id)
    WHERE v.video_id = %(video)s
"""
COMMENT_COUNT = "SELECT count(*) FROM youtube_comments WHERE video_id = %(video)s"


@router.get(
    "/api/youtube/videos/{video_id}",
    responses=failures(
        {
            401: "not_signed_in: no session, or it ended",
            403: "forbidden: only admins see this; must_change_password: the temporary password isn't changed yet",
            404: "not_found: no video with that ID has been collected",
            422: "invalid_request: that isn't a video's ID",
        }
    ),
)
async def youtube_video(
    request: Request, _: Admin, video_id: Annotated[str, Path(pattern=VIDEO_ID)]
) -> YouTubeVideoDetails:
    """A collected video's details, its channel, and how many of its comments have been collected. Counting takes a
    few milliseconds for most videos (5 comments, the median), and up to 150 ms for the one with the most (128,669)."""

    async def details() -> dict | None:
        async with request.state.pool.connection() as conn:
            cursor = conn.cursor(row_factory=dict_row)
            return await (await cursor.execute(VIDEO, {"video": video_id})).fetchone()

    async def collected() -> int:
        async with request.state.pool.connection() as conn:
            (count,) = await (await conn.execute(COMMENT_COUNT, {"video": video_id})).fetchone()
            return count

    video, count = await asyncio.gather(details(), collected())  # each on a connection of its own, at the same time
    if video is None:
        raise Failure(404, "not_found", "No video with that ID has been collected")
    return YouTubeVideoDetails(**video, comments_collected=count)


# Newest first, by the estimated time, which every comment of a video is sorted by on each request: a few milliseconds
# for most videos, 0.23 s for the one with the most comments (1.3 s the first time, from disk)
COMMENTS = """
    SELECT comment_id AS id, author_name, author_channel_id, text, published_text, published_at AS written_at
    FROM youtube_comments WHERE video_id = %(video)s
    ORDER BY published_at DESC NULLS LAST, comment_id
    LIMIT %(limit)s OFFSET %(offset)s
"""
# How YouTube words a comment's age: "3 hours ago", "1 year ago", "2 months ago (edited)"
AGE = re.compile(r"\d+ (second|minute|hour|day|week|month|year)s? ago( \(edited\))?")


@router.get(
    "/api/youtube/videos/{video_id}/comments",
    responses=failures(
        {
            401: "not_signed_in: no session, or it ended",
            403: "forbidden: only admins see this; must_change_password: the temporary password isn't changed yet",
            422: "invalid_request: that isn't a video's ID, or a parameter is out of its range",
        }
    ),
)
async def youtube_video_comments(
    request: Request,
    _: Admin,
    video_id: Annotated[str, Path(pattern=VIDEO_ID)],
    page: Annotated[int, Query(ge=1, le=LAST_PAGE, description=f"{PAGE_SIZE} comments to a page")] = 1,
) -> YouTubeComments:
    """A video's collected comments (not their replies), newest first, a page at a time (a video that hasn't been
    collected has none). How many there are is in the video's details, so that a page isn't counted again."""
    values = {"video": video_id, "limit": PAGE_SIZE, "offset": (page - 1) * PAGE_SIZE}
    async with request.state.pool.connection() as conn:
        cursor = conn.cursor(row_factory=dict_row)
        rows = await (await cursor.execute(COMMENTS, values)).fetchall()
    comments = []
    for row in rows:
        age = AGE.fullmatch(row.pop("published_text") or "")
        precision, edited = (age.group(1), age.group(2) is not None) if age else (None, False)
        comments.append(YouTubeComment(**row, precision=precision, edited=edited))
    return YouTubeComments(comments=comments, page_size=PAGE_SIZE)
