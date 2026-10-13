"""Run a collector across processes, as fast as the proxies answer. Each worker process takes an equal share of the
items and of the proxies, works through its items `concurrency` at a time, and saves what it collects every
SAVE_EVERY seconds. A collector (channels, videos, details, stats, comments) only describes its own part: see
Collector.

Every collector goes through the VPN proxies run by sing-box. Each process also holds its share of the free proxies
in reserve, and brings them in once its VPN proxies stop working: YouTube's next endpoint (details, comments) blocks
busy addresses for a while, and the free proxies are many more addresses (see Pool).
"""
import argparse
import asyncio
import math
import os
import sys
import time
from collections import Counter
from concurrent.futures import ProcessPoolExecutor, wait
from multiprocessing import get_context

import psycopg
from curl_cffi import AsyncSession

from media_monitoring import db
from media_monitoring.pool import (ATTEMPTS, PLAIN_PROXY_FILE, PROXY_FILE, NoProxiesLeft, Pool, load_proxies,
                                   load_share, raise_open_files_limit)

PROCESSES = max(1, os.cpu_count() - 4)  # each runs its own event loop; a few cores stay free for sing-box
SAVE_EVERY = 2  # seconds
FOLLOW_EVERY = 60  # seconds between looks at the proxy lists, for collectors that follow them

# In each worker process: [items finished, items saved, processes ready, processes that brought in the free proxies],
# counted by all processes together
progress = None


class Collector:
    """One collector's own part; run() does the rest. In each worker process one instance works through that
    process's share of the items: prepare() once, then handle() for each item, while save() writes what has been
    collected every SAVE_EVERY seconds. self.results counts the items' outcomes; handle() may add counts of its own."""
    concurrency = 500  # items in progress at a time, per process
    rest = None  # how long a failed proxy rests (see Pool)
    give_up = True  # end the run when every proxy rests at once (see Pool)
    follow_lists = False  # take in refreshed proxy lists while running
    report_every = 10  # seconds between progress lines
    item_name = "items"
    saved_name = "saved"

    def load(self, conn, argument):
        """In the main process: the items to work on. argument is the command line's, or None."""
        raise NotImplementedError

    def describe(self, argument):
        """In the main process: what the items are, for the first line."""
        return self.item_name

    async def prepare(self, conn, items):
        """In each worker process, before the work: e.g. temporary tables, or what's already saved."""

    async def handle(self, pool, session, item):
        """One item: fetch it through pool.run and keep what should be saved. Returns its outcome, e.g. "ok"."""
        raise NotImplementedError

    async def save(self, conn):
        """Write what has been collected since the last save. Returns how many items it counts as saved."""
        return 0

    def summary(self, results, saved):
        """The last line, from all processes' outcomes and the number saved."""
        return f"{dict(results)}, {saved} {self.saved_name}"


def modified(path):
    """When a proxy list was last replaced, or None if it doesn't exist."""
    try:
        return os.path.getmtime(path)
    except FileNotFoundError:
        return None


async def work(collector, items, share, shares):
    """One worker process: its share of the items, through its share of the VPN proxies, with its share of the free
    ones in reserve."""
    raise_open_files_limit()
    seen = {path: modified(path) for path in (PROXY_FILE, PLAIN_PROXY_FILE)}

    def reserve_brought():
        with progress.get_lock():
            progress[3] += 1

    pool = Pool(load_share(PROXY_FILE, share, shares), rest=collector.rest, give_up=collector.give_up,
                reserve=load_share(PLAIN_PROXY_FILE, share, shares), on_reserve=reserve_brought)
    collector.results = results = Counter()
    finished = 0
    async with await db.connect() as conn:
        await collector.prepare(conn, items)
        with progress.get_lock():
            progress[2] += 1  # ready: what's already saved is loaded, and the work starts
        # verify=False: no certificate checks through proxies (all the data is public)
        async with AsyncSession(impersonate="chrome", verify=False,
                                max_clients=collector.concurrency * ATTEMPTS) as session:
            remaining, stop = iter(items), asyncio.Event()

            async def worker():
                nonlocal finished
                for item in remaining:  # all workers share one iterator
                    try:
                        results[await collector.handle(pool, session, item)] += 1
                    except NoProxiesLeft:
                        return  # this process's proxies all broke; its other items wait for the next run
                    finished += 1
                pool.draining = True  # no new items left: idle capacity goes to the slowest requests

            async def saver():
                """Saves every SAVE_EVERY seconds until stopped, then once more. Only this touches the database, so
                a save is never interrupted halfway."""
                counted = 0
                while True:
                    try:
                        await asyncio.wait_for(stop.wait(), timeout=SAVE_EVERY)
                    except TimeoutError:
                        pass
                    stopped, done = stop.is_set(), finished  # items finished during this save count in the next
                    saved = await collector.save(conn)
                    with progress.get_lock():
                        progress[0] += done - counted
                        progress[1] += saved
                    counted = done
                    if stopped:
                        return

            async def follower():
                """Every FOLLOW_EVERY seconds: once sing-box has restarted with new configs, its local proxies are
                tested again; a refreshed free list joins the pool if the reserve is in use, else replaces it."""
                while not stop.is_set():
                    try:
                        await asyncio.wait_for(stop.wait(), timeout=FOLLOW_EVERY)
                    except TimeoutError:
                        pass
                    for path in (PROXY_FILE, PLAIN_PROXY_FILE):
                        if modified(path) != seen[path]:
                            seen[path] = modified(path)
                            proxies = load_share(path, share, shares)
                            if path == PROXY_FILE:
                                pool.renew(proxies)
                            elif pool.reserve_used:
                                pool.add(proxies)
                            else:
                                pool.reserve = proxies

            tasks = [asyncio.create_task(saver())]
            if collector.follow_lists:
                tasks.append(asyncio.create_task(follower()))
            try:
                await asyncio.gather(*(worker() for _ in range(min(collector.concurrency, len(items)))))
            finally:
                await pool.close()
                stop.set()  # also on Ctrl+C or an error: save what we have
                await asyncio.gather(*tasks)
    return results, pool.outcomes, len(pool.proven)


def start(counter):
    """Runs first in each worker process."""
    global progress
    progress = counter
    try:  # if memory runs out, Linux ends a worker first, never PostgreSQL (a crash would empty unlogged tables)
        with open("/proc/self/oom_score_adj", "w") as f:
            f.write("1000")
    except OSError:
        pass  # not Linux


def run_share(collector_class, items, share, shares):
    """Entry point of each worker process: it runs its own event loop."""
    return asyncio.run(work(collector_class(), items, share, shares))


def run(collector_class):
    """A collector's main(): load its items, work through them in worker processes, and report."""
    sys.stdout.reconfigure(line_buffering=True)  # print each line right away, also into a log file
    parser = argparse.ArgumentParser(description=sys.modules[collector_class.__module__].__doc__.split("\n\n")[0])
    parser.add_argument("argument", nargs="?",
                        help="for stats and comments: a number of days (90 by default), all, or (comments) unread")
    args = parser.parse_args()
    collector = collector_class()
    with psycopg.connect(db.DATABASE_URL, autocommit=True) as conn:
        items = collector.load(conn, args.argument)
    vpn, free = load_proxies(PROXY_FILE), load_proxies(PLAIN_PROXY_FILE)
    print(f"{len(items)} {collector.describe(args.argument)}, {len(vpn)} VPN proxies and {len(free)} free ones in "
          "reserve")
    if not items or not vpn + free:
        return

    processes = max(1, min(PROCESSES, (len(vpn) or len(free)) // 50, math.ceil(len(items) / 1000)))
    print(f"working with {processes} processes...")
    context = get_context("spawn")
    counter = context.Array("q", 4)  # see progress: counted by the processes
    started = time.monotonic()
    results, outcomes, working = Counter(), Counter(), 0
    with ProcessPoolExecutor(processes, mp_context=context, initializer=start, initargs=(counter,)) as executor:
        futures = [executor.submit(run_share, collector_class, items[i::processes], i, processes)
                   for i in range(processes)]
        before, then = 0, started
        while not all(future.done() for future in futures):
            wait(futures, timeout=collector.report_every)
            now, (finished, saved, ready, reserve) = time.monotonic(), counter[:]
            # Before its work, each process loads what's already saved for its items (comments' IDs, for example),
            # which for a big run takes a while: say so, or the line would look stuck at 0
            notes = ([f"{processes - ready} of {processes} processes still loading what's already saved"]
                     if ready < processes else [])
            notes += [f"free proxies brought in by {reserve} of {processes} processes"] if reserve else []
            print(f"{now - started:5.0f} s  {finished} of {len(items)} {collector.item_name} done, {saved} "
                  f"{collector.saved_name}, {(finished - before) / max(now - then, 0.001):,.0f}/s"
                  + "".join(f"  ({note})" for note in notes))
            before, then = finished, now
        for future in futures:
            share_results, share_outcomes, share_working = future.result()
            results += share_results
            outcomes += share_outcomes
            working += share_working
    took = time.monotonic() - started
    print(f"\nfinished in {took:.0f} s ({len(items) / took:,.0f} {collector.item_name}/s): "
          f"{collector.summary(results, counter[1])}")
    print(f"requests: {dict(outcomes)}")
    if counter[3]:
        print(f"free proxies were brought in by {counter[3]} of {processes} processes, when their VPN proxies stopped "
              "working")
    print(f"{working} proxies working at the end")
