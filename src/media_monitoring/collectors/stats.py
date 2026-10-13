"""Refresh the views and likes of recent videos: each video has one row in youtube_video_stats with its latest
numbers, overwritten on every refresh.

"uv run stats" refreshes the videos uploaded in the last DAYS days, "uv run stats 30" the last 30 days, and
"uv run stats all" every video. Run details first, so new videos have their upload day, and run it while
singbox-runner is running: the pool tests the proxies by itself (see pool.py).
"""
from functools import partial

from media_monitoring.parallel import Collector, run
from media_monitoring.youtube import API, CONTEXT, call

DAYS = 90  # by default, refresh the videos uploaded in the last DAYS days
# updated_metadata is what a watch page calls to refresh its counts: the lightest answer, with exact numbers
FIELDS = ("actions/updateViewershipAction/viewCount/videoViewCountRenderer(originalViewCount,isLive),"
          "frameworkUpdates/entityBatchUpdate/mutations/payload/likeCountEntity/likeCountIfIndifferentNumber")
URL = API + "updated_metadata?prettyPrint=false&fields=" + FIELDS

STATS = "CREATE TEMP TABLE stats (video_id text, views bigint, likes bigint) ON COMMIT DELETE ROWS"
SAVE = """INSERT INTO youtube_video_stats (video_id, views, likes, updated_at)
          SELECT video_id, views, likes, now() FROM stats
          ON CONFLICT (video_id) DO UPDATE SET views = excluded.views, likes = excluded.likes,
                                               updated_at = excluded.updated_at"""

def counts(data):
    """(views, likes) from updated_metadata's answer, None for what it doesn't show; None if it shows no counts."""
    viewership = [action["updateViewershipAction"]["viewCount"]["videoViewCountRenderer"]
                  for action in data.get("actions") or [] if "updateViewershipAction" in action]
    if not viewership:
        return None
    views = likes = None
    if not viewership[0].get("isLive"):  # a live or upcoming stream shows the viewers watching or waiting instead
        views = int(viewership[0]["originalViewCount"]) if "originalViewCount" in viewership[0] else None
    for mutation in data.get("frameworkUpdates", {}).get("entityBatchUpdate", {}).get("mutations") or []:
        entity = mutation.get("payload", {}).get("likeCountEntity") or {}
        if "likeCountIfIndifferentNumber" in entity:  # missing when likes are off, e.g. on videos made for kids
            likes = int(entity["likeCountIfIndifferentNumber"])
    return views, likes


async def fetch(session, video_id, proxy):
    """One video's views and likes through one proxy. Returns (outcome, (video_id, views, likes))."""
    problem, response = await call(session, proxy, "POST", URL, json={"context": CONTEXT, "videoId": video_id})
    if problem:
        return problem, None
    try:
        data = response.json()
    except Exception:
        return "broken", None  # not YouTube's answer: the proxy mangled it
    try:
        numbers = counts(data)
    except (KeyError, TypeError, ValueError, AttributeError):
        return "youtube error", None  # an answer in an unexpected shape; the next try gets it
    if numbers is None:
        return "gone", None  # no counts: removed, private, or blocked where the proxy is
    return "ok", (video_id, *numbers)


class Stats(Collector):
    item_name = "videos"
    saved_name = "refreshed"

    def load(self, conn, argument):
        days = argument or str(DAYS)
        if days == "all":
            return [row[0] for row in conn.execute("SELECT video_id FROM youtube_videos")]
        return [row[0] for row in conn.execute(
            "SELECT video_id FROM youtube_videos WHERE upload_date >= current_date - %s::int", (int(days),))]

    def describe(self, argument):
        days = argument or str(DAYS)
        return "videos to refresh (" + ("every video" if days == "all" else f"uploaded in the last {days} days") + ")"

    async def prepare(self, conn, video_ids):
        self.pending = []
        await conn.execute(STATS)

    async def handle(self, pool, session, video_id):
        outcome, row = await pool.run(partial(fetch, session, video_id))
        if row:
            self.pending.append(row)
        return outcome

    async def save(self, conn):
        """Returns how many videos' numbers were saved."""
        rows = self.pending[:]
        self.pending.clear()
        if rows:
            async with conn.transaction(), conn.cursor() as cur:
                async with cur.copy("COPY stats FROM STDIN") as copy:
                    for row in rows:
                        await copy.write_row(row)
                await cur.execute(SAVE)
        return len(rows)

    def summary(self, results, saved):
        return (f"{results['ok']} refreshed, {results['gone']} without counts (removed, private, or blocked where the "
                f"proxy is), {results['failed']} failed")


def main():
    run(Stats)
