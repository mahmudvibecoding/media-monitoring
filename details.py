"""Fetch the details of every video that doesn't have them yet: title, description and upload day, from the
video's page. Run videos.py first, so new videos are in youtube_videos.

Run it while singbox_runner.py is running: the pool tests the proxies by itself (see pool.py).
"""
import asyncio
import math
import os
import re
import sys
import time
from collections import Counter
from concurrent.futures import ProcessPoolExecutor, wait
from datetime import datetime
from functools import partial
from multiprocessing import get_context

import psycopg
from curl_cffi import AsyncSession

from pool import API, ATTEMPTS, CONTEXT, NoProxiesLeft, Pool, call, load_proxies, raise_open_files_limit

DATABASE_URL = os.environ.get("DATABASE_URL", "dbname=media_monitoring_v2")
# Saves don't wait for the disk to confirm them: a crash loses at most the last second of saves, which the next
# run fetches again
NO_WAIT = "-c synchronous_commit=off"
PROCESSES = max(1, os.cpu_count() - 4)  # each runs its own event loop; a few cores stay free for sing-box
CONCURRENCY = 500  # videos in progress at a time, per process
FIELDS = ("contents/twoColumnWatchNextResults/results/results/contents(videoPrimaryInfoRenderer(title/runs/text,"
          "dateText/simpleText),videoSecondaryInfoRenderer/attributedDescription/content)")
URL = API + "next?prettyPrint=false&fields=" + FIELDS
# The day in "Oct 11, 2026", "Premiered Mar 3, 2026", "Streamed live on Sep 4, 2022", "Scheduled for ..."
DAY = re.compile(r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}")

DETAILS = """CREATE TEMP TABLE details (video_id text, title text, description text, upload_date date)
             ON COMMIT DELETE ROWS"""
SAVE = """UPDATE youtube_videos AS v
          SET title = d.title, description = d.description, upload_date = d.upload_date, status = 'available'
          FROM details AS d WHERE v.video_id = d.video_id"""
# Still retried every run: a video can be blocked only where one proxy is, or come back later
MARK_UNAVAILABLE = "UPDATE youtube_videos SET status = 'unavailable' WHERE video_id = ANY(%s)"
COUNT = "SELECT count(*) FROM youtube_videos WHERE title IS NULL"


def text(value):
    """Text as PostgreSQL can store it: without NUL characters."""
    return value.replace("\x00", "") if value else value


def upload_day(date_text):
    """The day written on the video page, or None (e.g. "Live stream currently offline")."""
    match = DAY.search(date_text or "")
    return datetime.strptime(match.group(), "%b %d, %Y").date() if match else None


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
        items = data["contents"]["twoColumnWatchNextResults"]["results"]["results"]["contents"]
    except (KeyError, TypeError):
        return "youtube error", None  # now and then YouTube answers without the page; the next try gets it
    primary = next((item["videoPrimaryInfoRenderer"] for item in items if "videoPrimaryInfoRenderer" in item), None)
    if primary is None:
        return "gone", None  # removed, private, or blocked where the proxy is
    secondary = next((item["videoSecondaryInfoRenderer"] for item in items if "videoSecondaryInfoRenderer" in item), {})
    title = "".join(run.get("text", "") for run in (primary.get("title") or {}).get("runs", []))
    description = (secondary.get("attributedDescription") or {}).get("content")
    day = upload_day((primary.get("dateText") or {}).get("simpleText"))
    return "ok", (video_id, text(title), text(description), day)


async def save_rows(conn, pending, unavailable):
    """Write the collected details to the database and empty the lists."""
    rows, gone = pending[:], unavailable[:]
    pending.clear()
    unavailable.clear()
    if rows or gone:
        async with conn.transaction(), conn.cursor() as cur:
            if rows:
                async with cur.copy("COPY details FROM STDIN") as copy:
                    for row in rows:
                        await copy.write_row(row)
                await cur.execute(SAVE)
            if gone:
                await cur.execute(MARK_UNAVAILABLE, (gone,))


async def collect_share(video_ids, proxies):
    """One process: fetch its share of the videos through its share of the proxies, saving every 2 seconds."""
    raise_open_files_limit()
    pool = Pool(proxies)
    results, pending, unavailable = Counter(), [], []
    async with await psycopg.AsyncConnection.connect(DATABASE_URL, autocommit=True, options=NO_WAIT) as conn:
        await conn.execute(DETAILS)
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
                    elif result == "gone":
                        unavailable.append(video_id)
                pool.draining = True  # no new videos left: idle capacity goes to the slowest requests

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
                    await save_rows(conn, pending, unavailable)
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


def run_share(video_ids, proxies):
    """Entry point of each worker process: it runs its own event loop."""
    return asyncio.run(collect_share(video_ids, proxies))


def main():
    sys.stdout.reconfigure(line_buffering=True)  # print each line right away, also into a log file
    with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
        video_ids = [row[0] for row in conn.execute("SELECT video_id FROM youtube_videos WHERE title IS NULL")]
    proxies = load_proxies()
    print(f"{len(video_ids)} videos without details, {len(proxies)} proxies")
    if not video_ids or not proxies:
        return

    processes = max(1, min(PROCESSES, len(proxies) // 50, math.ceil(len(video_ids) / 1000)))
    print(f"fetching with {processes} processes...")
    started = time.monotonic()
    results, outcomes, working = Counter(), Counter(), 0
    with ProcessPoolExecutor(processes, mp_context=get_context("spawn")) as executor:
        futures = [executor.submit(run_share, video_ids[i::processes], proxies[i::processes])
                   for i in range(processes)]
        with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
            while not all(f.done() for f in futures):
                wait(futures, timeout=10)
                left = conn.execute(COUNT).fetchone()[0]
                print(f"{time.monotonic() - started:5.0f} s  {len(video_ids) - left} of {len(video_ids)} done")
        for future in futures:
            share_results, share_outcomes, share_working = future.result()
            results += share_results
            outcomes += share_outcomes
            working += share_working
    print(f"\nfinished in {time.monotonic() - started:.0f} s: {results['ok']} videos with details, "
          f"{results['gone']} unavailable (tried again next run), {results['failed']} failed")
    print(f"requests: {dict(outcomes)}")
    print(f"{working} proxies working at the end")


# Needed for multiple processes: each worker process imports this file and must not run main() again.
if __name__ == "__main__":
    main()
