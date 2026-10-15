"""Run a collector across processes, as fast as the proxies answer. Each worker process takes an equal share of the
items and of the proxies, works through its items `concurrency` at a time, and saves what it collects every
SAVE_EVERY seconds. A collector (YouTube's channels, videos, details, stats and comments, Telegram's channels) only
describes its own part: see Collector.

Every collector goes through the VPN proxies run by sing-box. Each process also holds its share of the plain proxies
in reserve, and brings them in once its VPN proxies stop working, or once it has tested them all and has room for more
tests: YouTube's next endpoint (details, comments) blocks busy addresses for a while, and the plain proxies are many
more addresses (see Pool). How many proxies each process tests at a time follows the CPU the work leaves unused (see
regulate_tests).
"""
import argparse
import asyncio
import math
import os
import signal
import sys
import threading
import time
from collections import Counter
from concurrent.futures import ProcessPoolExecutor, wait
from concurrent.futures.process import BrokenProcessPool
from functools import partial
from multiprocessing import get_context

import psycopg
from curl_cffi import AsyncSession

from media_monitoring import db
from media_monitoring.pool import (ATTEMPTS, PLAIN_PROXY_FILE, PROXY_FILE, TESTS_MAX, TESTS_MIN, TESTS_START,
                                   NoProxiesLeft, Pool, load_proxies, load_share, raise_open_files_limit)

PROCESSES = max(1, os.cpu_count() - 4)  # each runs its own event loop; a few cores stay free for sing-box
SAVE_EVERY = 2  # seconds
FOLLOW_EVERY = 60  # seconds between looks at the proxy lists, for collectors that follow them
# Proxy tests per process (see regulate_tests): every REGULATE_EVERY seconds, twice as many while more than IDLE_HIGH
# of the server's CPU is idle, half as many while less than IDLE_LOW is. A process whose own core is busier than
# OWN_BUSY runs half as many as it did, whatever the server's CPU, and comes back up while it's below OWN_FREE.
REGULATE_EVERY = 0.5
IDLE_LOW, IDLE_HIGH = 0.10, 0.20
OWN_FREE, OWN_BUSY = 0.6, 0.9

# Shared by all processes: whether the run is stopping early (set by the main process on Ctrl+C or kill, see run),
# how many proxy tests each process may run at a time (set by the main process, see regulate_tests), then PER_SHARE
# counters for each share of the items, from SHARES on, each written only by the process working on that share: items
# finished, items saved, whether it's ready (what's already saved is loaded), whether it brought in the plain proxies,
# and its successful requests. Without a lock, a process ended halfway through (killed, or out of memory) can't leave
# one held.
progress = None
STOPPING, TESTS, SHARES = 0, 1, 2
PER_SHARE = 5
FINISHED, SAVED, READY, RESERVE, SUCCEEDED = range(PER_SHARE)
SUCCESSFUL = ("ok", "gone")  # requests the site answered with what was asked: every speed shown counts these
parent = None  # in each worker process: the main process, which it stops for if it's gone
busy = False  # in each worker process: whether it's working on a share (see run_share)
killed = False  # in each worker process: whether kill asked this process alone to stop (see start)


class Collector:
    """One collector's own part; run() does the rest. In each worker process one instance works through that
    process's share of the items: prepare() once, then handle() for each item, while save() writes what has been
    collected every SAVE_EVERY seconds. self.results counts the items' outcomes; handle() may add counts of its own."""
    concurrency = 500  # items in progress at a time, per process
    attempts = ATTEMPTS  # requests per item at most, each through another proxy (see Pool.run)
    give_up = True  # end the run when every proxy rests at once (see Pool)
    follow_lists = False  # take in refreshed proxy lists while running
    report_every = 10  # seconds between progress lines
    item_name = "items"
    saved_name = "saved"
    argument = None  # what the command line's argument may be, for its help; None if it takes none
    words = ()  # the words the argument may be
    days = False  # whether the argument may also be a number of days

    def load(self, conn, argument):
        """In the main process: the items to work on. argument is the command line's, or None."""
        raise NotImplementedError

    def describe(self, argument):
        """In the main process: what the items are, for the first line."""
        return self.item_name

    async def prepare(self, conn, items):
        """In each worker process, before the work: e.g. temporary tables, or what's already saved."""

    async def test(self, session, proxy):
        """One test of a proxy (see Pool): the collector's own kind of request, on an item that has been up for years.
        Returns (outcome, result) like a request."""
        raise NotImplementedError

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
    """One worker process: its share of the items, through its share of the VPN proxies, with its share of the plain
    ones in reserve."""
    raise_open_files_limit()
    seen = {path: modified(path) for path in (PROXY_FILE, PLAIN_PROXY_FILE)}
    mine = SHARES + PER_SHARE * share  # where this share's counters are in progress

    def reserve_brought():
        progress[mine + RESERVE] = 1

    pool = Pool(load_share(PROXY_FILE, share, shares), give_up=collector.give_up,
                reserve=load_share(PLAIN_PROXY_FILE, share, shares), on_reserve=reserve_brought,
                attempts=collector.attempts)
    collector.results = results = Counter()
    finished = 0
    async with await db.connect() as conn:
        await collector.prepare(conn, items)
        progress[mine + READY] = 1  # what's already saved is loaded, and the work starts
        # verify=False: no certificate checks through proxies (all the data is public)
        async with AsyncSession(impersonate="chrome", verify=False,
                                max_clients=collector.concurrency * collector.attempts + TESTS_MAX) as session:
            pool.start_testing(partial(collector.test, session))
            remaining, stop, halted = iter(items), asyncio.Event(), False

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
                a save is never interrupted halfway. When the run is stopping early (Ctrl+C or kill), or the main
                process is gone, it ends the work: the last save keeps what was collected."""
                nonlocal halted
                counted = 0
                while True:
                    try:
                        await asyncio.wait_for(stop.wait(), timeout=SAVE_EVERY)
                    except TimeoutError:
                        pass
                    if not halted and (progress[STOPPING] or ending()):
                        halted = True
                        working.cancel()
                    stopped, done = stop.is_set(), finished  # items finished during this save count in the next
                    saved = await collector.save(conn)
                    progress[mine + FINISHED] += done - counted
                    progress[mine + SAVED] += saved
                    counted = done
                    if stopped:
                        return

            async def follower():
                """Every FOLLOW_EVERY seconds: once sing-box has restarted with new configs, its local proxies are
                tested again; a refreshed plain list joins the pool if the reserve is in use, else replaces it."""
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
                                pool.add(proxies, plain=True)
                            else:
                                pool.reserve = proxies

            async def regulator():
                """Every REGULATE_EVERY seconds: how many proxies this process tests at a time. The main process sets
                that for all processes, by the server's idle CPU; this one tests fewer while its own core is nearly
                full, since its tests and its work share it. Also counts the successful requests, for the speed."""
                own, cpu, then = TESTS_MAX, time.process_time(), time.monotonic()
                while not stop.is_set():
                    try:
                        await asyncio.wait_for(stop.wait(), timeout=REGULATE_EVERY)
                    except TimeoutError:
                        pass
                    progress[mine + SUCCEEDED] = sum(pool.outcomes[outcome] for outcome in SUCCESSFUL)
                    busy_share = (time.process_time() - cpu) / max(time.monotonic() - then, 0.001)
                    cpu, then = time.process_time(), time.monotonic()
                    if busy_share > OWN_BUSY:
                        own = max(TESTS_MIN, min(own, pool.allowed) // 2)
                    elif busy_share < OWN_FREE:
                        own = min(TESTS_MAX, own * 2)
                    pool.allow_tests(min(progress[TESTS], own))

            working = asyncio.gather(*(worker() for _ in range(min(collector.concurrency, len(items)))))
            tasks = [asyncio.create_task(saver()), asyncio.create_task(regulator())]
            if collector.follow_lists:
                tasks.append(asyncio.create_task(follower()))
            try:
                await working
            except asyncio.CancelledError:
                if not halted:
                    raise  # not the saver's doing
            finally:
                await pool.close()
                stop.set()  # also when stopping early or on an error: save what we have
                await asyncio.gather(*tasks)
    return results, pool.outcomes, pool.test_outcomes, len(pool.proven)


def start(counter, main):
    """Runs first in each worker process. main is the main process: not simply this one's parent, which is already
    another one if the main process was killed while this one was starting."""
    global progress, parent
    progress, parent = counter, main
    # Ctrl+C reaches the workers too, but only the main process acts on it, and the workers stop when it asks (see
    # work). kill on a worker makes it save what it has and end, like the main process being gone; the pool then
    # stops the others the same way (it sends them kill when one has ended). A worker interrupted halfway through
    # could leave a lock its queues share held, and hang the run. Both were held back while this process started.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, kill_asked)
    signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGINT, signal.SIGTERM})
    threading.Thread(target=watch_parent, daemon=True).start()
    try:  # if memory runs out, Linux ends a worker first, never PostgreSQL (a crash would empty unlogged tables)
        with open("/proc/self/oom_score_adj", "w") as f:
            f.write("1000")
    except OSError:
        pass  # not Linux


def kill_asked(signum, frame):
    global killed
    killed = True


def ending():
    """In each worker process: whether it should end by itself, because the main process is gone (killed, or out of
    memory), or because kill asked this process alone to stop (the pool does when another one has ended) while the
    run as a whole isn't stopping. Nobody would end it otherwise: it would wait for more work forever."""
    return os.getppid() != parent or (killed and not progress[STOPPING])


def watch_parent():
    """Ends this worker process once it should (see ending) while it has no share to work on. Working on a share, it
    saves and ends by itself (see work and run_share)."""
    while True:
        time.sleep(1)
        if ending() and not busy:
            os._exit(0)


def cpu_times():
    """The server's idle and total CPU time so far, in clock ticks; None where it can't tell (not on Linux)."""
    try:
        with open("/proc/stat") as f:
            ticks = [int(n) for n in f.readline().split()[1:9]]  # user, nice, system, idle, iowait, irq, softirq, steal
    except (OSError, ValueError):
        return None
    return ticks[3] + ticks[4], sum(ticks)


def regulate_tests(counter, processes, done):
    """In the main process, from when every worker process has started its work until done is set: every
    REGULATE_EVERY seconds, how many proxies each worker process may test at a time (counter[TESTS]). Twice as many
    while more than IDLE_HIGH of the server's CPU is idle, which is when the work can't use it, as when few proxies
    work; half as many while less than IDLE_LOW is, as the work needs it. One setting for all processes, so they don't
    each react on their own. Where the CPU can't be read (not on Linux), it stays at TESTS_START."""
    while sum(counter[SHARES + READY::PER_SHARE]) < processes:
        if done.wait(REGULATE_EVERY):
            return
    last = cpu_times()
    while last and not done.wait(REGULATE_EVERY):
        now = cpu_times()
        idle = (now[0] - last[0]) / max(now[1] - last[1], 1)
        last = now
        if idle > IDLE_HIGH:
            counter[TESTS] = min(TESTS_MAX, counter[TESTS] * 2)
        elif idle < IDLE_LOW:
            counter[TESTS] = max(TESTS_MIN, counter[TESTS] // 2)


def run_share(collector_class, items, share, shares):
    """Entry point of each worker process: it runs its own event loop."""
    global busy
    busy = True
    result = asyncio.run(work(collector_class(), items, share, shares))
    if ending():
        os._exit(0)  # what was collected is saved
    busy = False
    return result


def run(collector_class):
    """A collector's main(): load its items, work through them in worker processes, and report. Ctrl+C or kill
    stops it early: the workers stop and save what they have collected first. Another Ctrl+C ends it at once."""
    sys.stdout.reconfigure(line_buffering=True)  # print each line right away, also into a log file
    collector = collector_class()
    parser = argparse.ArgumentParser(description=sys.modules[collector_class.__module__].__doc__.split("\n\n")[0])
    if collector.argument:
        parser.add_argument("argument", nargs="?", help=collector.argument)
    argument = getattr(parser.parse_args(), "argument", None)
    if argument is not None and argument not in collector.words and not (collector.days and argument.isdigit()):
        parser.error(f"the argument should be {collector.argument}, not {argument!r}")
    # The signal that asked the run to stop early and when, if one did; what the processes share
    asked, counter = [], None

    def ask_to_stop(signum, frame):
        """Ctrl+C or kill: the workers stop, saving what they have. Another one a second later ends the run at once
        (its workers still save and stop, once they see it's gone). Within the second it's the same one: uv run
        passes Ctrl+C on, so it arrives twice."""
        if asked:
            if time.monotonic() - asked[1] >= 1:
                os._exit(128 + signum)
            return
        asked.extend((signum, time.monotonic()))
        if counter is not None:
            counter[STOPPING] = 1

    handled = {s for s in (signal.SIGINT, signal.SIGTERM) if signal.getsignal(s) is not signal.SIG_IGN}
    for signum in handled:
        signal.signal(signum, ask_to_stop)
    with psycopg.connect(db.DATABASE_URL, autocommit=True) as conn:
        items = collector.load(conn, argument)
    vpn, plain = load_proxies(PROXY_FILE), load_proxies(PLAIN_PROXY_FILE)
    print(f"{len(items)} {collector.describe(argument)}, {len(vpn)} VPN proxies and {len(plain)} plain ones in reserve")
    if asked:
        print("stopped before it started")
        sys.exit(128 + asked[0])
    if not items or not vpn + plain:
        return

    processes = max(1, min(PROCESSES, (len(vpn) or len(plain)) // 50, math.ceil(len(items) / 1000)))
    print(f"working with {processes} processes...")
    context = get_context("spawn")
    counter = context.Array("q", SHARES + PER_SHARE * processes, lock=False)  # see progress
    counter[STOPPING], counter[TESTS] = bool(asked), TESTS_START

    def totals():
        """Items finished, items saved, shares ready, shares that brought in the plain proxies and successful requests,
        from all shares."""
        values = counter[:]
        return [sum(values[SHARES + kind::PER_SHARE]) for kind in (FINISHED, SAVED, READY, RESERVE, SUCCEEDED)]

    # Held back while the worker processes start, which takes a few seconds: they start with them held back too,
    # until they ignore them (see start), and here they arrive once the workers are running
    signal.pthread_sigmask(signal.SIG_BLOCK, handled)
    started = time.monotonic()
    results, outcomes, tests, working = Counter(), Counter(), Counter(), 0
    with ProcessPoolExecutor(processes, mp_context=context, initializer=start,
                             initargs=(counter, os.getpid())) as executor:
        futures = [executor.submit(run_share, collector_class, items[i::processes], i, processes)
                   for i in range(processes)]
        done = threading.Event()  # the regulator's stop
        threading.Thread(target=regulate_tests, args=(counter, processes, done), daemon=True).start()
        signal.pthread_sigmask(signal.SIG_UNBLOCK, handled)
        before, then = 0, started  # successful requests at the last line, and when
        while not all(future.done() for future in futures):
            wait(futures, timeout=collector.report_every)
            now, (finished, saved, ready, reserve, succeeded) = time.monotonic(), totals()
            # Before its work, each process loads what's already saved for its items (comments' IDs, for example),
            # which for a big run takes a while: say so, or the line would look stuck at 0
            notes = ([f"{processes - ready} of {processes} processes still loading what's already saved"]
                     if ready < processes else [])
            notes += [f"up to {counter[TESTS]} proxy tests at a time per process"] if ready == processes else []
            notes += [f"plain proxies brought in by {reserve} of {processes} processes"] if reserve else []
            notes += ["stopping early: each process saves what it has"] if asked else []
            print(f"{now - started:5.0f} s  {finished} of {len(items)} {collector.item_name} done, {saved} "
                  f"{collector.saved_name}, {(succeeded - before) / max(now - then, 0.001):,.0f} successful requests/s"
                  + "".join(f"  ({note})" for note in notes))
            before, then = succeeded, now
        broken = False  # a worker process ended unexpectedly (killed, or out of memory): the pool ends the others
        for future in futures:
            try:
                share_results, share_outcomes, share_tests, share_working = future.result()
            except BrokenProcessPool:
                broken = True
                continue
            results += share_results
            outcomes += share_outcomes
            tests += share_tests
            working += share_working
        done.set()
    took = time.monotonic() - started
    finished, saved, _, reserve, succeeded = totals()
    if not broken:  # the shares' own counts, which include the requests after their last progress update
        succeeded = sum(outcomes[outcome] for outcome in SUCCESSFUL)
    rate = f"{succeeded / took:,.0f} successful requests/s"
    if broken:  # the shares' own counts didn't come back, only the ones they keep in progress
        print(f"\nstopped after {took:.0f} s ({rate}): {finished} {collector.item_name} done, {saved} "
              f"{collector.saved_name}")
    else:
        print(f"\n{'stopped after' if asked else 'finished in'} {took:.0f} s ({rate}): "
              f"{collector.summary(results, saved)}")
        print(f"requests: {dict(outcomes)}")
        print(f"proxy tests: {dict(tests)}")
    if reserve:
        print(f"plain proxies were brought in by {reserve} of {processes} processes, once their VPN proxies were all "
              "tested or stopped working")
    if not broken:
        print(f"{working} proxies working at the end")
    if asked:
        print("stopped early (Ctrl+C or kill): what wasn't done continues next run")
        sys.exit(128 + asked[0])
    if broken:
        print("stopped early: a worker process ended unexpectedly (killed, or out of memory), and the others stopped "
              "too; what wasn't done continues next run")
        sys.exit(1)
