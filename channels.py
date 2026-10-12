"""Fill youtube_channels (title, handle, description, avatar_url, subscriber_count) from InnerTube,
as fast as the proxies answer, through the working VPN configs.

Run check_vpn.py first (with singbox_runner.py still running), so the pool is fresh.
"""
import asyncio
import math
import os
import random
import sys
import time
from collections import Counter, deque
from concurrent.futures import ProcessPoolExecutor, wait
from multiprocessing import get_context

import psycopg
from curl_cffi import AsyncSession

from proxies import CONTEXT, URL, raise_open_files_limit

DATABASE_URL = os.environ.get("DATABASE_URL", "dbname=media_monitoring_v2")
# The proxy is the first word of each line. Plain proxies (working_proxies.txt from proxies.py) did only
# 4-7% of the work and most failed their first request, so they're left out; add the file back to use them.
PROXY_FILES = ["working_vpn_proxies.txt"]
PROCESSES = max(1, os.cpu_count() - 4)  # each runs its own event loop; a few cores stay free for sing-box
CONCURRENCY = 500  # channels in progress at a time, per process
REQUESTS_PER_PROXY = 8  # requests in flight through one proxy at a time, so a weak proxy isn't flooded
TIMEOUT = 5  # seconds; a proxy that hasn't answered by then is dropped
HEDGE_AFTER = 1  # at the end of a run: seconds without an answer before the request also goes out elsewhere
ATTEMPTS = 5  # requests per channel at most
# YouTube returns a random 403/429 now and then; that alone changes nothing. Only a real storm (8 blocks
# among a proxy's last 10 answers) pauses that proxy for 30 seconds; then it continues at full speed.
STORM_WINDOW, STORM_BLOCKS, STORM_PAUSE = 10, 8, 30
PROFILE = "microformat.microformatDataRenderer.channelProfileMicroformatDetails.profilePage.mainEntity"
FIELD_MASK = ",".join([
    "metadata.channelMetadataRenderer.title",
    "metadata.channelMetadataRenderer.description",
    "metadata.channelMetadataRenderer.avatar",
    f"{PROFILE}.alternateName",
    f"{PROFILE}.interactionStatistic",
    "alerts",  # YouTube's message when a channel doesn't exist
])
SAVE = """UPDATE youtube_channels
          SET title = %s, handle = %s, description = %s, avatar_url = %s, subscriber_count = %s
          WHERE channel_id = %s"""


class NoProxiesLeft(Exception):
    pass


class BadRequest(Exception):
    """YouTube rejected the request itself: probably the field mask is out of date."""


class Pool:
    """One process's proxies, as slots in a queue: a request takes the next free slot and puts it back when it
    ends, so fast proxies come back sooner and carry more of the work. Each proxy starts with one slot, so a
    dead one holds up a single request; once YouTube answers through it, it gets REQUESTS_PER_PROXY slots."""

    def __init__(self, proxies):
        self.slots = asyncio.Queue()
        for proxy in proxies:
            self.slots.put_nowait(proxy)
        self.alive = set(proxies)
        self.proven = set()  # proxies that YouTube answered through
        self.recent = {proxy: deque(maxlen=STORM_WINDOW) for proxy in proxies}  # last answers: True = blocked
        self.paused_until = {}  # proxies resting after a storm: {proxy: time}
        self.draining = False  # True once there are no new channels left to start

    async def take(self):
        """Wait for a free slot and return its proxy."""
        while True:
            proxy = await self.slots.get()
            if proxy is None:  # every proxy broke
                self.slots.put_nowait(None)  # tell the next waiting request too
                raise NoProxiesLeft
            if proxy in self.alive:  # slots of proxies that broke meanwhile are thrown away
                return proxy

    def give_back(self, proxy, outcome):
        """Put the slot back after a request. outcome is None if the request was cancelled."""
        if outcome == "broken":  # the proxy itself failed: drop it for this run
            self.alive.discard(proxy)
            if not self.alive:
                self.slots.put_nowait(None)
            return
        if outcome in ("ok", "gone", "blocked"):  # YouTube answered
            if proxy not in self.proven:
                self.proven.add(proxy)
                for _ in range(REQUESTS_PER_PROXY - 1):
                    self.slots.put_nowait(proxy)
            recent = self.recent[proxy]
            recent.append(outcome == "blocked")
            if sum(recent) >= STORM_BLOCKS:
                recent.clear()
                self.paused_until[proxy] = time.monotonic() + STORM_PAUSE
        rest = self.paused_until.get(proxy, 0) - time.monotonic()
        if rest > 0:
            asyncio.get_running_loop().call_later(rest, self.slots.put_nowait, proxy)
        else:
            self.slots.put_nowait(proxy)


def load_proxies():
    """All proxies from PROXY_FILES, without duplicates."""
    proxies = {}
    for path in PROXY_FILES:
        try:
            with open(path) as f:
                for line in f:
                    if line.strip():
                        proxies[line.split()[0]] = None
        except FileNotFoundError:
            print(f"{path} not found, skipping it")
    return list(proxies)


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
    return meta.get("title"), profile.get("alternateName"), meta.get("description"), avatars[0].get("url"), subscribers


async def fetch(session, channel_id, proxy):
    """Ask InnerTube for one channel through one proxy. Returns (outcome, row); row is set for "ok"."""
    try:
        response = await session.post(URL, json={"context": CONTEXT, "browseId": channel_id},
                                      headers={"X-Goog-FieldMask": FIELD_MASK}, proxy=proxy, timeout=TIMEOUT)
    except Exception:
        return "broken", None  # the proxy didn't get us an answer
    if response.status_code == 400:
        return "bad request", None
    if response.status_code in (403, 429):
        return "blocked", None
    if response.status_code >= 500:
        return "youtube error", None
    try:
        data = response.json()
        if "metadata" in data:
            return "ok", parse(data) + (channel_id,)
        if data.get("alerts"):  # e.g. "This channel does not exist."
            return "gone", None
    except Exception:
        pass
    return "broken", None  # an answer that isn't YouTube's: the proxy mangled it


async def send(session, pool, proxy, channel_id, outcomes):
    """One request for the channel through one proxy; the proxy's slot goes back to the pool afterwards."""
    outcome = row = None
    try:
        outcome, row = await fetch(session, channel_id, proxy)
    finally:
        pool.give_back(proxy, outcome)  # outcome is still None if this request was cancelled
    outcomes[outcome] += 1
    return outcome, row


async def collect_one(session, pool, channel_id, outcomes, background):
    """Get one channel: when a request fails, send it again through another proxy, up to ATTEMPTS requests.
    At the end of a run (pool.draining: no new channels left), a request without an answer after HEDGE_AFTER
    seconds also goes out through another proxy, and the first useful answer wins. Requests still running
    then finish in `background`, so their proxies are judged by how they answer.
    Returns ("ok", row), ("gone", None) or ("failed", None)."""
    tries, sent, slow = set(), 0, False
    try:
        while True:
            if sent < ATTEMPTS and (not tries or (slow and pool.draining)):
                proxy = await pool.take()
                tries.add(asyncio.create_task(send(session, pool, proxy, channel_id, outcomes)))
                sent += 1
            elif not tries:
                return "failed", None
            done, tries = await asyncio.wait(tries, timeout=HEDGE_AFTER, return_when=asyncio.FIRST_COMPLETED)
            slow = not done
            for task in done:
                outcome, row = task.result()
                if outcome == "bad request":
                    raise BadRequest("YouTube answered 400 Bad Request: the field mask is probably out of date")
                if outcome in ("ok", "gone"):
                    return outcome, row
    finally:
        for task in tries:
            background.add(task)
            task.add_done_callback(background.discard)


async def save_rows(conn, pending):
    """Write the collected rows to the database and empty the list."""
    if pending:
        rows = pending[:]
        pending.clear()
        async with conn.cursor() as cur:
            await cur.executemany(SAVE, rows)
        await conn.commit()


async def collect_share(channel_ids, proxies):
    """One process: fetch its share of the channels through its share of the proxies, saving every 2 seconds."""
    raise_open_files_limit()
    pool = Pool(proxies)
    results, outcomes, pending, background = Counter(), Counter(), [], set()
    async with await psycopg.AsyncConnection.connect(DATABASE_URL) as conn:
        # verify=False: no certificate checks through proxies (all the data is public)
        async with AsyncSession(impersonate="chrome", verify=False, max_clients=CONCURRENCY * ATTEMPTS) as session:
            remaining = iter(channel_ids)

            async def worker():
                for channel_id in remaining:  # all workers share one iterator
                    try:
                        result, row = await collect_one(session, pool, channel_id, outcomes, background)
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
                for task in list(background):  # slower copies of requests that already got their answer
                    task.cancel()
                await asyncio.gather(*background, return_exceptions=True)
                stop.set()  # also on Ctrl+C or an error: save what we have
                await saving
    return results, outcomes


def run_share(channel_ids, proxies):
    """Entry point of each worker process: it runs its own event loop."""
    return asyncio.run(collect_share(channel_ids, proxies))


def main():
    sys.stdout.reconfigure(line_buffering=True)  # print each line right away, also into a log file
    with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
        channel_ids = [row[0] for row in conn.execute("SELECT channel_id FROM youtube_channels WHERE title IS NULL")]
    proxies = load_proxies()
    print(f"{len(channel_ids)} channels to fetch, {len(proxies)} proxies")
    if not channel_ids or not proxies:
        return

    # Each process gets an equal mix of fast and slow proxies, and a share of the channels
    random.shuffle(proxies)
    processes = max(1, min(PROCESSES, len(proxies) // 50, math.ceil(len(channel_ids) / 1000)))
    print(f"fetching with {processes} processes...")
    started = time.monotonic()
    results, outcomes = Counter(), Counter()
    with ProcessPoolExecutor(processes, mp_context=get_context("spawn")) as executor:
        futures = [executor.submit(run_share, channel_ids[i::processes], proxies[i::processes])
                   for i in range(processes)]
        with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
            while not all(f.done() for f in futures):
                wait(futures, timeout=2)
                left = conn.execute("SELECT count(*) FROM youtube_channels WHERE title IS NULL").fetchone()[0]
                print(f"{time.monotonic() - started:5.0f} s  {len(channel_ids) - left} of {len(channel_ids)} filled")
        for future in futures:
            share_results, share_outcomes = future.result()
            results += share_results
            outcomes += share_outcomes
    print(f"\nfinished in {time.monotonic() - started:.0f} s: {dict(results)}")
    print(f"requests: {dict(outcomes)}")


# Needed for multiple processes: each worker process imports this file and must not run main() again.
if __name__ == "__main__":
    main()