"""Refresh the views and likes of recent videos and keep every refresh as history: the latest numbers go into
youtube_videos, and each refresh also adds a row to youtube_video_stats.

"uv run stats.py" refreshes the videos uploaded in the last DAYS days, "uv run stats.py 30" the last 30 days,
and "uv run stats.py all" every video. Run details.py first, so new videos have their upload day, and run it
while singbox_runner.py is running: the pool tests the proxies by itself (see pool.py).
"""
import asyncio
import math
import os
import sys
import time
from collections import Counter
from concurrent.futures import ProcessPoolExecutor, wait
from functools import partial
from multiprocessing import get_context

import psycopg
from curl_cffi import AsyncSession

from pool import API, ATTEMPTS, CONTEXT, NoProxiesLeft, Pool, call, load_proxies, raise_open_files_limit

DATABASE_URL = os.environ.get("DATABASE_URL", "dbname=media_monitoring_v2")
PROCESSES = max(1, os.cpu_count() - 4)  # each runs its own event loop; a few cores stay free for sing-box
CONCURRENCY = 500  # videos in progress at a time, per process
DAYS = 90  # by default, refresh the videos uploaded in the last DAYS days
# updated_metadata is what a watch page calls to refresh its counts: the lightest answer, with exact numbers
FIELDS = ("actions/updateViewershipAction/viewCount/videoViewCountRenderer(originalViewCount,isLive),"
          "frameworkUpdates/entityBatchUpdate/mutations/payload/likeCountEntity/likeCountIfIndifferentNumber")
URL = API + "updated_metadata?prettyPrint=false&fields=" + FIELDS

STATS = "CREATE TEMP TABLE stats (video_id text, views bigint, likes bigint) ON COMMIT DELETE ROWS"
SAVE = """UPDATE youtube_videos AS v SET views = s.views, likes = s.likes, stats_at = now()
          FROM stats AS s WHERE v.video_id = s.video_id"""
KEEP = "INSERT INTO youtube_video_stats (video_id, at, views, likes) SELECT video_id, now(), views, likes FROM stats"

finished = None  # in each worker process: how many videos all processes have finished, shared with the main one


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


async def save_rows(conn, pending):
    """Write the collected numbers to the database and empty the list."""
    if pending:
        rows = pending[:]
        pending.clear()
        async with conn.transaction(), conn.cursor() as cur:
            async with cur.copy("COPY stats FROM STDIN") as copy:
                for row in rows:
                    await copy.write_row(row)
            await cur.execute(SAVE)
            await cur.execute(KEEP)


async def collect_share(video_ids, proxies):
    """One process: fetch its share of the videos through its share of the proxies, saving every 2 seconds."""
    raise_open_files_limit()
    pool = Pool(proxies)
    results, pending = Counter(), []
    async with await psycopg.AsyncConnection.connect(DATABASE_URL, autocommit=True) as conn:
        await conn.execute(STATS)
        # verify=False: no certificate checks through proxies (all the data is public)
        async with AsyncSession(impersonate="chrome", verify=False, max_clients=CONCURRENCY * ATTEMPTS) as session:
            remaining = iter(video_ids)

            async def worker():
                for video_id in remaining:  # all workers share one iterator
                    try:
                        result, row = await pool.run(partial(fetch, session, video_id))
                    except NoProxiesLeft:
                        return  # this process's proxies all broke; its other videos wait for the next run
                    results[result] += 1
                    if row:
                        pending.append(row)
                pool.draining = True  # no new videos left: idle capacity goes to the slowest requests

            stop = asyncio.Event()

            async def saver():
                """Saves every 2 seconds until stopped, then once more. Only this touches the database, so a save
                is never interrupted halfway."""
                counted = 0
                while True:
                    try:
                        await asyncio.wait_for(stop.wait(), timeout=2)
                    except TimeoutError:
                        pass
                    stopped = stop.is_set()  # checked before saving: rows added during this save get the next one
                    done = results.total()
                    await save_rows(conn, pending)
                    with finished.get_lock():
                        finished.value += done - counted
                    counted = done
                    if stopped:
                        return

            saving = asyncio.create_task(saver())
            try:
                await asyncio.gather(*(worker() for _ in range(min(CONCURRENCY, len(video_ids)))))
            finally:
                await pool.close()
                stop.set()  # also on Ctrl+C or an error: save what we have
                await saving
    return results, pool.outcomes, len(pool.proven)


def share_counter(counter):
    """Runs first in each worker process."""
    global finished
    finished = counter


def run_share(video_ids, proxies):
    """Entry point of each worker process: it runs its own event loop."""
    return asyncio.run(collect_share(video_ids, proxies))


def main():
    sys.stdout.reconfigure(line_buffering=True)  # print each line right away, also into a log file
    days = sys.argv[1] if len(sys.argv) > 1 else str(DAYS)
    with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
        if days == "all":
            video_ids = [row[0] for row in conn.execute("SELECT video_id FROM youtube_videos")]
        else:
            video_ids = [row[0] for row in conn.execute(
                "SELECT video_id FROM youtube_videos WHERE upload_date >= current_date - %s::int", (int(days),))]
    proxies = load_proxies()
    window = "every video" if days == "all" else f"uploaded in the last {days} days"
    print(f"{len(video_ids)} videos to refresh ({window}), {len(proxies)} proxies")
    if not video_ids or not proxies:
        return

    processes = max(1, min(PROCESSES, len(proxies) // 50, math.ceil(len(video_ids) / 1000)))
    print(f"fetching with {processes} processes...")
    context = get_context("spawn")
    done = context.Value("q", 0)  # videos finished and saved, counted by the worker processes
    started = time.monotonic()
    results, outcomes, working = Counter(), Counter(), 0
    with ProcessPoolExecutor(processes, mp_context=context, initializer=share_counter, initargs=(done,)) as executor:
        futures = [executor.submit(run_share, video_ids[i::processes], proxies[i::processes])
                   for i in range(processes)]
        before, then = 0, started
        while not all(f.done() for f in futures):
            wait(futures, timeout=10)
            now, count = time.monotonic(), done.value
            print(f"{now - started:5.0f} s  {count} of {len(video_ids)} done, {(count - before) / (now - then):,.0f}/s")
            before, then = count, now
        for future in futures:
            share_results, share_outcomes, share_working = future.result()
            results += share_results
            outcomes += share_outcomes
            working += share_working
    took = time.monotonic() - started
    print(f"\nfinished in {took:.0f} s ({results.total() / took:,.0f} videos/s): {results['ok']} refreshed, "
          f"{results['gone']} without counts (removed, private, or blocked where the proxy is), "
          f"{results['failed']} failed")
    print(f"requests: {dict(outcomes)}")
    print(f"{working} proxies working at the end")


# Needed for multiple processes: each worker process imports this file and must not run main() again.
if __name__ == "__main__":
    main()
