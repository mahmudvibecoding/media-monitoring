"""Refresh every channel's details in youtube_channels (title, handle, description, avatar_url, subscriber_count)
from InnerTube, as fast as the proxies answer. Only channels whose details changed are written.

Run it while singbox_runner.py is running: the pool tests the proxies by itself (see pool.py).
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

DATABASE_URL = os.environ.get("DATABASE_URL", "dbname=media_monitoring")
# Saves don't wait for the disk to confirm them: a crash loses at most the last second of saves, which the next
# run fetches again
NO_WAIT = "-c synchronous_commit=off"
URL = API + "browse?prettyPrint=false"
PROCESSES = max(1, os.cpu_count() - 4)  # each runs its own event loop; a few cores stay free for sing-box
CONCURRENCY = 500  # channels in progress at a time, per process
PROFILE = "microformat.microformatDataRenderer.channelProfileMicroformatDetails.profilePage.mainEntity"
FIELD_MASK = ",".join([
    "metadata.channelMetadataRenderer.title",
    "metadata.channelMetadataRenderer.description",
    "metadata.channelMetadataRenderer.avatar",
    f"{PROFILE}.alternateName",
    f"{PROFILE}.interactionStatistic",
    "alerts",  # YouTube's message when a channel doesn't exist
])
CHANNELS = """CREATE TEMP TABLE channels (title text, handle text, description text, avatar_url text,
              subscriber_count bigint, channel_id text) ON COMMIT DELETE ROWS"""
# Only rows whose details changed are written: the others would just be rewritten with the same values
SAVE = """UPDATE youtube_channels AS c
          SET title = n.title, handle = n.handle, description = n.description, avatar_url = n.avatar_url,
              subscriber_count = n.subscriber_count
          FROM channels AS n
          WHERE c.channel_id = n.channel_id
            AND (c.title, c.handle, c.description, c.avatar_url, c.subscriber_count)
                IS DISTINCT FROM (n.title, n.handle, n.description, n.avatar_url, n.subscriber_count)"""

done = None  # in each worker process: [channels finished, channels changed], counted by all processes together


def text(value):
    """Text as PostgreSQL can store it: without NUL characters."""
    return value.replace("\x00", "") if value else value


def parse(data):
    """(title, handle, description, avatar_url, subscriber_count) from InnerTube's answer."""
    meta = data["metadata"]["channelMetadataRenderer"]
    try:
        profile = data["microformat"]["microformatDataRenderer"]["channelProfileMicroformatDetails"][
            "profilePage"]["mainEntity"]
    except (KeyError, TypeError):
        profile = {}
    stats = profile.get("interactionStatistic") or []
    subscribers = int(stats[0]["userInteractionCount"]) if stats else None  # hidden counts are missing
    avatars = (meta.get("avatar") or {}).get("thumbnails") or [{}]
    return (text(meta.get("title")), text(profile.get("alternateName")), text(meta.get("description")),
            avatars[0].get("url"), subscribers)


async def fetch(session, channel_id, proxy):
    """Ask InnerTube for one channel through one proxy. Returns (outcome, row); row is set for "ok"."""
    problem, response = await call(session, proxy, "POST", URL, json={"context": CONTEXT, "browseId": channel_id},
                                   headers={"X-Goog-FieldMask": FIELD_MASK})
    if problem:
        return problem, None
    try:
        data = response.json()
    except Exception:
        return "broken", None  # not YouTube's answer: the proxy mangled it
    try:
        if "metadata" in data:
            return "ok", parse(data) + (channel_id,)
        if data.get("alerts"):  # e.g. "This channel does not exist."
            return "gone", None
    except Exception:
        pass
    return "youtube error", None  # now and then YouTube answers without the page; the next try gets it


async def save_rows(conn, pending):
    """Write the collected rows to the database and empty the list. Returns how many channels changed."""
    if not pending:
        return 0
    rows = pending[:]
    pending.clear()
    async with conn.transaction(), conn.cursor() as cur:
        async with cur.copy("COPY channels FROM STDIN") as copy:
            for row in rows:
                await copy.write_row(row)
        await cur.execute(SAVE)
        return cur.rowcount


async def collect_share(channel_ids, proxies):
    """One process: fetch its share of the channels through its share of the proxies, saving every 2 seconds."""
    raise_open_files_limit()
    pool = Pool(proxies)
    results, pending = Counter(), []
    async with await psycopg.AsyncConnection.connect(DATABASE_URL, autocommit=True, options=NO_WAIT) as conn:
        await conn.execute(CHANNELS)
        # verify=False: no certificate checks through proxies (all the data is public)
        async with AsyncSession(impersonate="chrome", verify=False, max_clients=CONCURRENCY * ATTEMPTS) as session:
            remaining = iter(channel_ids)

            async def worker():
                for channel_id in remaining:  # all workers share one iterator
                    try:
                        result, row = await pool.run(partial(fetch, session, channel_id))
                    except NoProxiesLeft:
                        return  # this process's proxies all broke; its other channels wait for the next run
                    results[result] += 1
                    if row:
                        pending.append(row)
                pool.draining = True  # no new channels left: idle capacity goes to the slowest requests

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
                    finished = results["ok"] + results["gone"] + results["failed"]
                    changed = await save_rows(conn, pending)
                    results["changed"] += changed
                    with done.get_lock():
                        done[0] += finished - counted
                        done[1] += changed
                    counted = finished
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


def share_counter(counter):
    """Runs first in each worker process."""
    global done
    done = counter


def run_share(channel_ids, proxies):
    """Entry point of each worker process: it runs its own event loop."""
    return asyncio.run(collect_share(channel_ids, proxies))


def main():
    sys.stdout.reconfigure(line_buffering=True)  # print each line right away, also into a log file
    with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
        channel_ids = [row[0] for row in conn.execute("SELECT channel_id FROM youtube_channels")]
    proxies = load_proxies()
    print(f"{len(channel_ids)} channels to refresh, {len(proxies)} proxies")
    if not channel_ids or not proxies:
        return

    # Each process gets a share of the channels and of the proxies
    processes = max(1, min(PROCESSES, len(proxies) // 50, math.ceil(len(channel_ids) / 1000)))
    print(f"fetching with {processes} processes...")
    context = get_context("spawn")
    counter = context.Array("q", 2)  # [channels finished, channels changed], counted by the worker processes
    started = time.monotonic()
    results, outcomes, working = Counter(), Counter(), 0
    with ProcessPoolExecutor(processes, mp_context=context, initializer=share_counter,
                             initargs=(counter,)) as executor:
        futures = [executor.submit(run_share, channel_ids[i::processes], proxies[i::processes])
                   for i in range(processes)]
        while not all(f.done() for f in futures):
            wait(futures, timeout=2)
            finished, changed = counter[:]
            print(f"{time.monotonic() - started:5.0f} s  {finished} of {len(channel_ids)} channels refreshed, "
                  f"{changed} changed")
        for future in futures:
            share_results, share_outcomes, share_working = future.result()
            results += share_results
            outcomes += share_outcomes
            working += share_working
    print(f"\nfinished in {time.monotonic() - started:.0f} s: {results['ok']} channels refreshed ({results['changed']} "
          f"changed), {results['gone']} gone (YouTube says they don't exist), {results['failed']} failed")
    print(f"requests: {dict(outcomes)}")
    print(f"{working} proxies working at the end")


# Needed for multiple processes: each worker process imports this file and must not run main() again.
if __name__ == "__main__":
    main()
