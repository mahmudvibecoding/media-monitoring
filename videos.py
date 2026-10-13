"""Find new videos: read every channel's uploads list, newest first, until reaching a video already in
youtube_videos, and save the new ones with their length. A channel's first run reads its whole history.

Run it while singbox_runner.py is running: the pool tests the proxies by itself (see pool.py).
"""
import asyncio
import math
import os
import random
import re
import sys
import time
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor, wait
from functools import partial
from multiprocessing import get_context

import psycopg
from curl_cffi import AsyncSession

from pool import API, ATTEMPTS, CONTEXT, NoProxiesLeft, Pool, call, load_proxies, raise_open_files_limit

DATABASE_URL = os.environ.get("DATABASE_URL", "dbname=media_monitoring")
# Saves don't wait for the disk to confirm them: a crash loses at most the last second of saves, which the next
# run fetches again
NO_WAIT = "-c synchronous_commit=off"
PROCESSES = max(1, os.cpu_count() - 4)  # each runs its own event loop; a few cores stay free for sing-box
CONCURRENCY = 500  # channels in progress at a time, per process
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
NEXT_PAGES = URL + f"alerts,onResponseReceivedActions/appendContinuationItemsAction/continuationItems({VIDEO},{SHORT},{NEXT})"
# Channels that post only Shorts show them in the uploads list as a grid of the newest 100, with no lengths and
# no further pages. A channel's first run reads its Shorts tab instead, which pages through all of them.
SHORTS_TAB = "EgZzaG9ydHPyBgUKA5oBAA%3D%3D"
LENGTH = re.compile(r"(?:(\d+):)?(\d+):(\d\d)")  # "8:26" or "1:02:03"

LOAD_KNOWN = "SELECT channel_id, video_id FROM youtube_videos WHERE channel_id = ANY(%s)"
NEW_VIDEOS = "CREATE TEMP TABLE new_videos (video_id text, channel_id text, duration_seconds integer) ON COMMIT DELETE ROWS"
SAVE = """INSERT INTO youtube_videos (video_id, channel_id, duration_seconds)
          SELECT video_id, channel_id, duration_seconds FROM new_videos
          ON CONFLICT (video_id) DO NOTHING"""
COUNT = "SELECT count(*) FROM youtube_videos"


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


async def save_rows(conn, pending):
    """Write the new videos to the database and empty the list."""
    if pending:
        rows = pending[:]
        pending.clear()
        async with conn.transaction(), conn.cursor() as cur:
            async with cur.copy("COPY new_videos FROM STDIN") as copy:
                for row in rows:
                    await copy.write_row(row)
            await cur.execute(SAVE)


async def collect_share(channel_ids, proxies):
    """One process: check its share of the channels through its share of the proxies, saving every 2 seconds."""
    raise_open_files_limit()
    pool = Pool(proxies)
    results, pending, known = Counter(), [], defaultdict(set)
    async with await psycopg.AsyncConnection.connect(DATABASE_URL, autocommit=True, options=NO_WAIT) as conn:
        async with conn.cursor() as cur:  # the videos already saved for this process's channels, loaded once
            await cur.execute(LOAD_KNOWN, (channel_ids,))
            async for channel_id, video_id in cur:
                known[channel_id].add(video_id)
        await conn.execute(NEW_VIDEOS)
        # verify=False: no certificate checks through proxies (all the data is public)
        async with AsyncSession(impersonate="chrome", verify=False, max_clients=CONCURRENCY * ATTEMPTS) as session:
            remaining = iter(channel_ids)

            async def worker():
                for channel_id in remaining:  # all workers share one iterator
                    first = not known[channel_id]
                    try:
                        outcome, videos = await check_channel(pool, session, channel_id, known[channel_id])
                    except NoProxiesLeft:
                        return  # this process's proxies all broke; its other channels wait for the next run
                    results[outcome] += 1
                    results["first runs"] += first and outcome == "ok"
                    results["new videos"] += len(videos)
                    pending.extend((video_id, channel_id, length) for video_id, length in videos)
                pool.draining = True  # no new channels left: idle capacity goes to the slowest requests

            stop = asyncio.Event()

            async def saver():
                """Saves every 2 seconds until stopped, then once more. Only this touches the database, so a save
                is never interrupted halfway."""
                while True:
                    try:
                        await asyncio.wait_for(stop.wait(), timeout=2)
                    except TimeoutError:
                        pass
                    stopped = stop.is_set()  # checked before saving: rows added during this save get the next one
                    await save_rows(conn, pending)
                    if stopped:
                        return

            saving = asyncio.create_task(saver())
            try:
                await asyncio.gather(*(worker() for _ in range(min(CONCURRENCY, len(channel_ids)))))
            finally:
                await pool.close()
                stop.set()  # also on Ctrl+C or an error: save what we have
                await saving
    return results, pool.outcomes, len(pool.proven)


def run_share(channel_ids, proxies):
    """Entry point of each worker process: it runs its own event loop."""
    return asyncio.run(collect_share(channel_ids, proxies))


def main():
    sys.stdout.reconfigure(line_buffering=True)  # print each line right away, also into a log file
    with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
        channel_ids = [row[0] for row in conn.execute("SELECT channel_id FROM youtube_channels")]
        before = conn.execute(COUNT).fetchone()[0]
    proxies = load_proxies()
    print(f"checking {len(channel_ids)} channels for new videos ({before} videos saved so far), {len(proxies)} proxies")
    if not channel_ids or not proxies:
        return

    # Each process gets an equal mix of big and small channels, and a share of the proxies
    random.shuffle(channel_ids)
    processes = max(1, min(PROCESSES, len(proxies) // 50, math.ceil(len(channel_ids) / 1000)))
    print(f"checking with {processes} processes...")
    started = time.monotonic()
    results, outcomes, working = Counter(), Counter(), 0
    with ProcessPoolExecutor(processes, mp_context=get_context("spawn")) as executor:
        futures = [executor.submit(run_share, channel_ids[i::processes], proxies[i::processes])
                   for i in range(processes)]
        with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
            while not all(f.done() for f in futures):
                wait(futures, timeout=5)
                now = conn.execute(COUNT).fetchone()[0]
                print(f"{time.monotonic() - started:5.0f} s  {now - before} new videos saved")
        for future in futures:
            share_results, share_outcomes, share_working = future.result()
            results += share_results
            outcomes += share_outcomes
            working += share_working
    print(f"\nfinished in {time.monotonic() - started:.0f} s: {results['ok']} channels checked "
          f"({results['first runs']} first runs), {results['gone']} without videos, {results['failed']} failed; "
          f"{results['new videos']} new videos")
    print(f"requests: {dict(outcomes)}")
    print(f"{working} proxies working at the end")


# Needed for multiple processes: each worker process imports this file and must not run main() again.
if __name__ == "__main__":
    main()
