"""Find new videos: read every channel's uploads list, newest first, until reaching a video already in
youtube_videos, and save the new ones with their length. A channel's first run reads its whole history.

Run it after "uv run proxies": the pool tests the proxies by itself (see pool.py).
"""
import random
import re
from collections import defaultdict
from functools import partial

from media_monitoring.parallel import Collector, run
from media_monitoring.youtube import API, CONTEXT, call

URL = API + "browse?prettyPrint=false&fields="
BADGE = "contentImage/thumbnailViewModel/overlays/thumbnailBottomOverlayViewModel/badges/thumbnailBadgeViewModel/text"
VIDEO = f"lockupViewModel(contentId,{BADGE})"  # a video in the list: its ID and the length shown on it
SHORT = "richItemRenderer/content/shortsLockupViewModel/onTap/innertubeCommand/reelWatchEndpoint/videoId"
NEXT = ("continuationItemViewModel/continuationCommand/innertubeCommand/continuationCommand/token,"
        "continuationItemRenderer/continuationEndpoint/continuationCommand/token")
# The first page of an uploads list or Shorts tab, and the pages after it: only IDs, lengths and the next page
FIRST_PAGE = URL + ("alerts,contents/twoColumnBrowseResultsRenderer/tabs/tabRenderer/content(sectionListRenderer"
                    f"/contents(itemSectionRenderer/contents({VIDEO},{NEXT},richGridRenderer/contents({VIDEO},{SHORT},"
                    f"{NEXT})),{VIDEO},{NEXT}),richGridRenderer/contents({VIDEO},{SHORT},{NEXT}))")
NEXT_PAGES = URL + ("alerts,onResponseReceivedActions/appendContinuationItemsAction/continuationItems("
                    f"{VIDEO},{SHORT},{NEXT})")
# Channels that post only Shorts show them in the uploads list as a grid of the newest 100, with no lengths and
# no further pages. A channel's first run reads its Shorts tab instead, which pages through all of them.
SHORTS_TAB = "EgZzaG9ydHPyBgUKA5oBAA%3D%3D"
LENGTH = re.compile(r"(?:(\d+):)?(\d+):(\d\d)")  # "8:26" or "1:02:03"

LOAD_KNOWN = "SELECT channel_id, video_id FROM youtube_videos WHERE channel_id = ANY(%s)"
NEW_VIDEOS = """CREATE TEMP TABLE new_videos (video_id text, channel_id text, duration_seconds integer)
                ON COMMIT DELETE ROWS"""
SAVE = """INSERT INTO youtube_videos (video_id, channel_id, duration_seconds)
          SELECT video_id, channel_id, duration_seconds FROM new_videos
          ON CONFLICT (video_id) DO NOTHING"""


def walk(node):
    """Every dict inside a JSON answer, in order."""
    if isinstance(node, dict):
        yield node
        for value in node.values():
            yield from walk(value)
    elif isinstance(node, list):
        for value in node:
            yield from walk(value)


def seconds(text):
    """A length shown on a video, like "8:26", in seconds; None for other labels, like LIVE."""
    match = LENGTH.fullmatch(text or "")
    if not match:
        return None
    hours, minutes, secs = match.groups()
    return int(hours or 0) * 3600 + int(minutes) * 60 + int(secs)


def parse_page(data):
    """A page of a list: its videos, newest first, as (video_id, length or None); the next page's token; and
    whether it showed Shorts in a grid."""
    videos, token, grid = [], None, False
    for node in walk(data):
        if "lockupViewModel" in node:
            lockup = node["lockupViewModel"]
            labels = [label["text"] for label in walk(lockup) if "text" in label]
            videos.append((lockup.get("contentId"), seconds(labels[0]) if labels else None))
        elif "reelWatchEndpoint" in node:
            videos.append((node["reelWatchEndpoint"].get("videoId"), None))
            grid = True
        elif "continuationCommand" in node and "token" in node["continuationCommand"]:
            token = node["continuationCommand"]["token"]
    return [video for video in videos if video[0]], token, grid


async def fetch_page(session, url, body, proxy):
    """One page of a list through one proxy. Returns (outcome, (videos, token, grid))."""
    problem, response = await call(session, proxy, "POST", url, json={"context": CONTEXT, **body})
    if problem:
        return problem, None
    try:
        data = response.json()
    except Exception:
        return "broken", None  # not YouTube's answer: the proxy mangled it
    # An ERROR alert means there's no such list: the channel has no videos, or is gone. Other alerts, like
    # "Unavailable videos are hidden" (videos removed, or blocked in the proxy's country), come with good pages.
    if any(isinstance(alert, dict) and alert.get("type") == "ERROR"
           for alerts in data.get("alerts") or [] for alert in alerts.values()):
        return "gone", None
    return "ok", parse_page(data)


async def read_list(pool, session, body, known):
    """Read a list page by page, newest first, until a page has a video in `known` (an empty set reads it all).
    Returns (outcome, videos, whether it showed Shorts in a grid)."""
    url, videos, grid = FIRST_PAGE, [], False
    while True:
        outcome, page = await pool.run(partial(fetch_page, session, url, body))
        if outcome != "ok":
            return outcome, videos, grid
        page_videos, token, page_grid = page
        videos += page_videos
        grid = grid or page_grid
        if not token or not page_videos or any(video_id in known for video_id, _ in page_videos):
            return "ok", videos, grid
        url, body = NEXT_PAGES, {"continuation": token}


async def check_channel(pool, session, channel_id, known):
    """A channel's videos that aren't in `known` (its saved videos), as (outcome, [(video_id, length)]).
    With nothing known yet, this is the channel's first run, which reads its whole history."""
    outcome, videos, grid = await read_list(pool, session, {"browseId": "VLUU" + channel_id[2:]}, known)
    if outcome == "ok" and grid and not known:  # Shorts in a grid: the whole history is in the Shorts tab
        outcome, shorts, _ = await read_list(pool, session, {"browseId": channel_id, "params": SHORTS_TAB}, known)
        videos += shorts
        if outcome == "gone":  # no Shorts tab after all: the grid's videos are all there is
            outcome = "ok"
    if outcome != "ok":
        return outcome, []  # nothing is saved, so the next run tries the whole channel again
    new = {}
    for video_id, length in videos:
        if video_id not in known:
            new.setdefault(video_id, length)
    return "ok", list(new.items())


class Videos(Collector):
    item_name = "channels"
    saved_name = "new videos"

    def load(self, conn, argument):
        channel_ids = [row[0] for row in conn.execute("SELECT channel_id FROM youtube_channels")]
        random.shuffle(channel_ids)  # each process gets an equal mix of big and small channels
        return channel_ids

    def describe(self, argument):
        return "channels to check for new videos"

    async def prepare(self, conn, channel_ids):
        self.pending, self.known = [], defaultdict(set)
        async with conn.cursor() as cur:  # the videos already saved for this process's channels, loaded once
            await cur.execute(LOAD_KNOWN, (channel_ids,))
            async for channel_id, video_id in cur:
                self.known[channel_id].add(video_id)
        await conn.execute(NEW_VIDEOS)

    async def handle(self, pool, session, channel_id):
        first = not self.known[channel_id]
        outcome, videos = await check_channel(pool, session, channel_id, self.known[channel_id])
        self.results["first runs"] += first and outcome == "ok"
        self.pending.extend((video_id, channel_id, length) for video_id, length in videos)
        return outcome

    async def save(self, conn):
        """Returns how many new videos were saved."""
        rows = self.pending[:]
        self.pending.clear()
        if not rows:
            return 0
        async with conn.transaction(), conn.cursor() as cur:
            async with cur.copy("COPY new_videos FROM STDIN") as copy:
                for row in rows:
                    await copy.write_row(row)
            await cur.execute(SAVE)
            return cur.rowcount

    def summary(self, results, saved):
        return (f"{results['ok']} channels checked ({results['first runs']} first runs), {results['gone']} without "
                f"videos, {results['failed']} failed; {saved} new videos")


def main():
    run(Videos)
