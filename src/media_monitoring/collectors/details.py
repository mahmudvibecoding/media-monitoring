"""Fetch the details of every video that doesn't have them yet: title, description and upload day, from the
video's page. Run videos first, so new videos are in youtube_videos.

Video pages come from YouTube's next endpoint, which blocks busy addresses for a while, so failed proxies rest
longer, and once the VPN proxies are blocked the free ones come in (see Pool). Run it after "uv run proxies"
(see pool.py).
"""
import re
from datetime import datetime, timedelta, timezone
from functools import partial

from media_monitoring.parallel import Collector, run
from media_monitoring.pool import LONG_REST
from media_monitoring.youtube import API, CONTEXT, call

FIELDS = ("contents/twoColumnWatchNextResults/results/results/contents(videoPrimaryInfoRenderer(title/runs/text,"
          "dateText/simpleText),videoSecondaryInfoRenderer/attributedDescription/content)")
URL = API + "next?prettyPrint=false&fields=" + FIELDS
# The day in "Oct 11, 2026", "Premiered Mar 3, 2026", "Streamed live on Sep 4, 2022", "Scheduled for ..."
DAY = re.compile(r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}")
# Streams and premieres of the last day show how long ago they started instead: "Started streaming 12 minutes ago",
# "Streamed live 3 hours ago", "Premiered 45 minutes ago", "Premiere in progress. Started 5 minutes ago"
AGO = re.compile(r"(\d+) (second|minute|hour|day|week)s? ago")
SECONDS = {"second": 1, "minute": 60, "hour": 3600, "day": 86400, "week": 7 * 86400}

DETAILS = """CREATE TEMP TABLE details (video_id text, title text, description text, upload_date date)
             ON COMMIT DELETE ROWS"""
SAVE = """UPDATE youtube_videos AS v
          SET title = d.title, description = d.description, upload_date = d.upload_date, status = 'available'
          FROM details AS d WHERE v.video_id = d.video_id"""
# Still retried every run: a video can be blocked only where one proxy is, or come back later
MARK_UNAVAILABLE = "UPDATE youtube_videos SET status = 'unavailable' WHERE video_id = ANY(%s)"


def text(value):
    """Text as PostgreSQL can store it: without NUL characters."""
    return value.replace("\x00", "") if value else value


def upload_day(date_text):
    """The day written on the video page, or counted back from "... ago" (in UTC); None if the page shows neither
    (e.g. "Live stream currently offline")."""
    match = DAY.search(date_text or "")
    if match:
        return datetime.strptime(match.group(), "%b %d, %Y").date()
    match = AGO.search(date_text or "")
    if match:
        return (datetime.now(timezone.utc) - timedelta(seconds=int(match.group(1)) * SECONDS[match.group(2)])).date()
    return None


async def fetch(session, video_id, proxy):
    """One video's page through one proxy. Returns (outcome, (video_id, title, description, upload_day))."""
    problem, response = await call(session, proxy, "POST", URL, json={"context": CONTEXT, "videoId": video_id})
    if problem:
        return problem, None
    try:
        data = response.json()
    except Exception:
        return "broken", None  # not YouTube's answer: the proxy mangled it
    try:
        # A private video's page has no contents at all
        items = data["contents"]["twoColumnWatchNextResults"]["results"]["results"].get("contents") or []
    except (KeyError, TypeError, AttributeError):
        return "youtube error", None  # now and then YouTube answers without the page; the next try gets it
    primary = next((item["videoPrimaryInfoRenderer"] for item in items if "videoPrimaryInfoRenderer" in item), None)
    if primary is None:
        return "gone", None  # removed, private, or blocked where the proxy is
    secondary = next((item["videoSecondaryInfoRenderer"] for item in items if "videoSecondaryInfoRenderer" in item), {})
    title = "".join(run.get("text", "") for run in (primary.get("title") or {}).get("runs", []))
    description = (secondary.get("attributedDescription") or {}).get("content")
    day = upload_day((primary.get("dateText") or {}).get("simpleText"))
    return "ok", (video_id, text(title), text(description), day)


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
