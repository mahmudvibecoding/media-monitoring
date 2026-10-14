"""Fetch the details of every video that doesn't have them yet, from the player answer YouTube's own video page
uses: its title and description as the creator wrote them (not a translation), its upload day, its exact length, and
whether it's a Short. Run videos first, so new videos are in youtube_videos.

YouTube checks for bots when that request comes in bulk, so it suits the new videos of each round, a few thousand a
day: a refused request goes out again through another proxy, and a video refused every time is tried again next
round. Failed proxies rest longer, and once the VPN proxies are blocked the free ones come in (see Pool). Run it after
"uv run proxies" (see pool.py).
"""
from datetime import datetime, timezone
from functools import partial

from media_monitoring.parallel import Collector, run
from media_monitoring.pool import LONG_REST
from media_monitoring.youtube import API, CONTEXT, call

FIELDS = ("playabilityStatus(status,reason),videoDetails(title,shortDescription,lengthSeconds),"
          "microformat/playerMicroformatRenderer(publishDate,isShortsEligible)")
URL = API + "player?prettyPrint=false&fields=" + FIELDS

DETAILS = """CREATE TEMP TABLE details (video_id text, title text, description text, upload_date date,
                                        duration_seconds integer, kind text) ON COMMIT DELETE ROWS"""
# The length from the player answer is exact: the uploads list's badge is rounded, and Shorts have none there
SAVE = """UPDATE youtube_videos AS v
          SET title = d.title, description = d.description, upload_date = d.upload_date,
              duration_seconds = coalesce(d.duration_seconds, v.duration_seconds), kind = d.kind,
              status = 'available'
          FROM details AS d WHERE v.video_id = d.video_id"""
# Still retried every run: a video can be blocked only where one proxy is, or come back later
MARK_UNAVAILABLE = "UPDATE youtube_videos SET status = 'unavailable' WHERE video_id = ANY(%s)"


def text(value):
    """Text as PostgreSQL can store it: without NUL characters."""
    return value.replace("\x00", "") if value else value


def upload_day(published):
    """The day of the upload time YouTube gives ("2026-10-13T04:51:23-07:00"), in UTC; None if it gives none."""
    try:
        moment = datetime.fromisoformat(published)
    except (TypeError, ValueError):
        return None
    return (moment.astimezone(timezone.utc) if moment.tzinfo else moment).date()


def parse(video_id, data):
    """(video_id, title, description, upload day, length, kind) from a player answer with the video's details. They
    come even when YouTube won't play the video to us (UNPLAYABLE)."""
    details = data["videoDetails"]
    micro = (data.get("microformat") or {}).get("playerMicroformatRenderer") or {}
    shorts = micro.get("isShortsEligible")  # YouTube's own word: it matches whether youtube.com/shorts/<id> opens
    return (video_id, text(details.get("title")), text(details.get("shortDescription")),
            upload_day(micro.get("publishDate")),
            int(details.get("lengthSeconds") or 0) or None,  # 0 while a stream is live or upcoming
            None if shorts is None else "short" if shorts else "video")


async def fetch(session, video_id, proxy):
    """One video's player answer through one proxy. Returns (outcome, row); row is set for "ok" (see parse)."""
    problem, response = await call(session, proxy, "POST", URL, json={
        "context": CONTEXT, "videoId": video_id, "contentCheckOk": True, "racyCheckOk": True})
    if problem:
        return problem, None
    try:
        data = response.json()
    except Exception:
        return "broken", None  # not YouTube's answer: the proxy mangled it
    if not data.get("videoDetails"):
        playability = data.get("playabilityStatus") or {}
        status, reason = playability.get("status"), playability.get("reason") or ""
        if status == "LOGIN_REQUIRED" and "bot" in reason:
            return "blocked", None  # "confirm you're not a bot": another proxy usually gets through
        if status in ("ERROR", "LOGIN_REQUIRED", "UNPLAYABLE"):
            return "gone", None  # removed, private, or blocked where the proxy is
        return "youtube error", None  # an answer in an unexpected shape; the next try gets it
    try:
        return "ok", parse(video_id, data)
    except (KeyError, TypeError, ValueError, AttributeError):
        return "youtube error", None


class Details(Collector):
    rest = LONG_REST
    item_name = "videos"
    saved_name = "with details"

    def load(self, conn, argument):
        return [row[0] for row in conn.execute("SELECT video_id FROM youtube_videos WHERE title IS NULL")]

    def describe(self, argument):
        return "videos without details"

    async def prepare(self, conn, video_ids):
        self.pending, self.unavailable = [], []
        await conn.execute(DETAILS)

    async def handle(self, pool, session, video_id):
        outcome, row = await pool.run(partial(fetch, session, video_id))
        if row:
            self.pending.append(row)
        elif outcome == "gone":
            self.unavailable.append(video_id)
        return outcome

    async def save(self, conn):
        """Returns how many videos got their details."""
        rows, gone = self.pending[:], self.unavailable[:]
        self.pending.clear()
        self.unavailable.clear()
        if rows or gone:
            async with conn.transaction(), conn.cursor() as cur:
                if rows:
                    async with cur.copy("COPY details FROM STDIN") as copy:
                        for row in rows:
                            await copy.write_row(row)
                    await cur.execute(SAVE)
                if gone:
                    await cur.execute(MARK_UNAVAILABLE, (gone,))
        return len(rows)

    def summary(self, results, saved):
        return (f"{results['ok']} videos with details, {results['gone']} unavailable (tried again next run), "
                f"{results['failed']} failed")


def main():
    run(Details)
