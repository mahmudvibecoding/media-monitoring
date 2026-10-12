"""Send YouTube requests through the local VPN proxies from sing-box, as fast as the proxies answer.

Real requests test the proxies, so there's no separate check. Each proxy has slots in a queue: a request takes
the best free slot and puts it back when it ends, so fast proxies come back sooner and carry more of the work.
Working proxies' slots always go first: untested proxies only get requests that would otherwise wait.

Each proxy finds its own pace. An untested proxy has one slot, so a dead one holds up a single request, and that
failure doesn't count against the request's tries. Once YouTube answers through it, it gets START_LIMIT slots,
and one more after each answer that found all of them busy, up to MAX_LIMIT: with few proxies each one carries
more, with many each carries less. Each failure halves its slots; at zero the proxy rests, twice as long each
time it fails again, and is then tested again, so proxies that recover come back even during long runs.

Each run tries the proxies that answered in the last run first, and saves its own working ones for the next
(working_vpn_proxies.txt). channels.py and the other collectors all send their requests this way.
"""
import asyncio
import itertools
import os
import resource
import time
from collections import Counter, deque

API = "https://www.youtube.com/youtubei/v1/"  # InnerTube: the API behind YouTube's own website
CONTEXT = {"client": {"clientName": "WEB", "clientVersion": "2.20251001.01.00", "hl": "en", "gl": "US"}}
ALL_PROXIES = "vpn_proxies.txt"  # from singbox_runner.py: one line per local proxy, "proxy link"
WORKING_PROXIES = "working_vpn_proxies.txt"  # the lines of the proxies that answered in the last run
START_LIMIT, MAX_LIMIT = 8, 64  # slots of a proxy once YouTube has answered through it, and at most
TIMEOUT = 5  # seconds; a proxy that hasn't answered by then has failed
HEDGE_AFTER = 1  # when draining: seconds without an answer before the request also goes out elsewhere
ATTEMPTS = 5  # requests per answer at most, not counting failures of proxies that were being tested
REST, MAX_REST = 60, 1800  # seconds a proxy rests when its slots fall to zero; doubled each time in a row
# YouTube returns a random 403/429 now and then; that alone changes nothing. Only a real storm (8 blocks
# among a proxy's last 10 answers) pauses that proxy for 30 seconds; then it continues at full speed.
STORM_WINDOW, STORM_BLOCKS, STORM_PAUSE = 10, 8, 30
# Which free slot a request gets first: a working proxy's; else a test of a proxy that answered earlier in this
# run; else a test of any other, in the order given (load_proxies puts the last run's working ones first)
WORKING, ANSWERED_BEFORE, OTHER = range(3)


class NoProxiesLeft(Exception):
    pass


class BadRequest(Exception):
    """YouTube rejected the request itself: probably a field mask is out of date."""


def read_lines(path):
    """The lines of a proxy list, "proxy link" each; none if the file doesn't exist."""
    try:
        with open(path) as f:
            return [line.strip() for line in f if line.strip()]
    except FileNotFoundError:
        return []


def load_proxies():
    """Every local proxy from sing-box (run singbox_runner.py first) as {proxy: its line}, the ones that answered
    in the last run first. Whole lines are compared: after a restart, sing-box may run another link at an address."""
    last = set(read_lines(WORKING_PROXIES))
    lines = sorted(read_lines(ALL_PROXIES), key=lambda line: line not in last)  # stable: else in the file's order
    return {line.split()[0]: line for line in lines}


def save_working(proxies, working, failed):
    """Save the working proxies for the next run: the ones that answered in this run, and the ones from the last
    run that weren't found failing. proxies is from load_proxies()."""
    last = set(read_lines(WORKING_PROXIES))
    lines = [line for proxy, line in proxies.items() if proxy in working or (line in last and proxy not in failed)]
    with open(WORKING_PROXIES + ".tmp", "w") as f:
        f.writelines(line + "\n" for line in lines)
    os.replace(WORKING_PROXIES + ".tmp", WORKING_PROXIES)  # all at once: a stopped run never leaves half a file
    return len(lines)


def raise_open_files_limit():
    """Every connection needs an open file; the default limit (1024 on Linux, 256 on macOS) is too low."""
    _, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    for limit in (1_000_000, 10240):  # macOS refuses more than 10240
        try:
            resource.setrlimit(resource.RLIMIT_NOFILE, (min(limit, hard), hard))
            return
        except (ValueError, OSError):
            continue


async def call(session, proxy, method, url, **kwargs):
    """One HTTP request through one proxy. Returns (problem, response): problem is None when YouTube
    answered normally, else "broken" (the proxy failed), "blocked" (403 or 429), "bad request" (400) or
    "youtube error" (500 and up), and response is None."""
    try:
        response = await session.request(method, url, proxy=proxy, timeout=TIMEOUT, **kwargs)
    except Exception:
        return "broken", None  # the proxy didn't get us an answer
    if response.status_code == 400:
        return "bad request", None
    if response.status_code in (403, 429):
        return "blocked", None
    if response.status_code >= 500:
        return "youtube error", None
    return None, response


class Pool:
    """One process's share of the proxies (see the top of this file), in the order to test them."""

    def __init__(self, proxies):
        self.slots = asyncio.PriorityQueue()  # free slots: (rank, order, proxy, generation)
        self.order = itertools.count()  # slots of the same rank are taken in the order they were freed
        self.generation = Counter()  # raised when a proxy starts resting, so the slots it had are thrown away
        self.limit = Counter()  # how many slots each proxy may have
        self.held = Counter()  # each proxy's slots, free or in use
        self.busy = Counter()  # each proxy's slots in use
        self.proven = set()  # proxies that answered and haven't rested since
        self.answered = set()  # proxies that answered at least once in this run
        self.failed = set()  # proxies that rested and haven't answered since
        self.resting = set()  # proxies waiting for their next test
        self.rests = Counter()  # each proxy's rests in a row, for the length of the next one
        self.recent = {}  # each proxy's last answers: True = blocked
        self.paused_until = {}  # proxies resting after a storm: {proxy: time}
        self.count = len(proxies)
        self.draining = False  # set it when no new work is left: then slow requests also go out elsewhere
        self.outcomes = Counter()  # how every request ended
        self.background = set()  # slower copies of requests that already got their answer
        for proxy in proxies:
            self._test(proxy)
        if not proxies:
            self._give_up()

    async def run(self, request):
        """Get one answer. request(proxy) sends one request through that proxy and returns (outcome, result),
        where outcome is "ok", "gone" or a problem from call(). A failed request goes out again through
        another proxy, up to ATTEMPTS times. When draining, a request without an answer after HEDGE_AFTER
        seconds also goes out elsewhere, and the first useful answer wins.
        Returns ("ok", result), ("gone", result) or ("failed", None)."""
        tries, sent, slow = set(), 0, False
        try:
            while True:
                if sent < ATTEMPTS and (not tries or (slow and self.draining)):
                    proxy, generation = await self._take()
                    tries.add(asyncio.create_task(self._send(request, proxy, generation)))
                    sent += 1
                elif not tries:
                    return "failed", None
                done, tries = await asyncio.wait(tries, timeout=HEDGE_AFTER, return_when=asyncio.FIRST_COMPLETED)
                slow = not done
                for task in done:
                    outcome, result, working = task.result()
                    if outcome == "bad request":
                        raise BadRequest("YouTube answered 400 Bad Request: a field mask is probably out of date")
                    if outcome in ("ok", "gone"):
                        return outcome, result
                    if outcome == "broken" and not working:
                        sent -= 1  # a proxy's test failed, not this request
        finally:
            for task in tries:  # left to finish, so their proxies are judged by how they answer
                self.background.add(task)
                task.add_done_callback(self.background.discard)

    async def close(self):
        """Cancel the slower copies of requests that are still running."""
        for task in list(self.background):
            task.cancel()
        await asyncio.gather(*self.background, return_exceptions=True)

    async def _send(self, request, proxy, generation):
        working = proxy in self.proven  # else this request also tests the proxy
        outcome = result = None
        try:
            outcome, result = await request(proxy)
        finally:
            self._give_back(proxy, generation, outcome)  # outcome is still None if this request was cancelled
        self.outcomes[outcome] += 1
        return outcome, result, working

    async def _take(self):
        """Wait for the best free slot; return its proxy and generation."""
        while True:
            entry = await self.slots.get()
            _, _, proxy, generation = entry
            if proxy is None:  # every proxy is resting
                self.slots.put_nowait(entry)  # tell the next waiting request too
                raise NoProxiesLeft
            if generation != self.generation[proxy]:
                continue  # the proxy has rested since: its old slots are gone
            if self.held[proxy] > self.limit[proxy]:
                self.held[proxy] -= 1  # the proxy failed since, so it has fewer slots now
                continue
            self.busy[proxy] += 1
            return proxy, generation

    def _free(self, proxy, generation):
        """Put a slot of the proxy in the queue."""
        rank = WORKING if proxy in self.proven else ANSWERED_BEFORE if proxy in self.answered else OTHER
        self.slots.put_nowait((rank, next(self.order), proxy, generation))

    def _give_back(self, proxy, generation, outcome):
        """After a request: set the proxy's slots by how it did, and free this one again. outcome is None if the
        request was cancelled."""
        if generation != self.generation[proxy]:
            return  # the proxy rested meanwhile, and came back with a new slot
        all_busy = self.busy[proxy] == self.held[proxy]
        self.busy[proxy] -= 1
        if outcome == "broken":
            self.limit[proxy] //= 2
            if not self.limit[proxy]:
                self._rest(proxy)
                return
        elif outcome in ("ok", "gone", "blocked", "youtube error"):  # YouTube answered
            self.rests[proxy] = 0
            self.failed.discard(proxy)
            self.answered.add(proxy)
            if proxy not in self.proven:
                self.proven.add(proxy)
                self.limit[proxy] = START_LIMIT
            elif all_busy and outcome in ("ok", "gone"):  # it could carry more
                self.limit[proxy] = min(MAX_LIMIT, self.limit[proxy] + 1)
            recent = self.recent.setdefault(proxy, deque(maxlen=STORM_WINDOW))
            recent.append(outcome == "blocked")
            if sum(recent) >= STORM_BLOCKS:
                recent.clear()
                self.paused_until[proxy] = time.monotonic() + STORM_PAUSE
        new = self.limit[proxy] - self.held[proxy]  # slots to add; below zero, this one is dropped
        if new < 0:
            self.held[proxy] -= 1
            return
        self.held[proxy] += new
        pause = self.paused_until.get(proxy, 0) - time.monotonic()
        for _ in range(new + 1):  # this slot and the new ones
            if pause > 0:
                asyncio.get_running_loop().call_later(pause, self._free, proxy, generation)
            else:
                self._free(proxy, generation)

    def _test(self, proxy):
        """One slot, so the proxy's next request tests it."""
        self.resting.discard(proxy)
        self.limit[proxy] = self.held[proxy] = 1
        self._free(proxy, self.generation[proxy])

    def _rest(self, proxy):
        """The proxy failed with its last slot: it rests, twice as long each time in a row, then is tested again."""
        self.generation[proxy] += 1  # its slots still out are thrown away
        self.held[proxy] = self.busy[proxy] = 0
        self.proven.discard(proxy)
        self.failed.add(proxy)
        self.resting.add(proxy)
        rest = min(MAX_REST, REST * 2 ** self.rests[proxy])
        self.rests[proxy] += 1
        asyncio.get_running_loop().call_later(rest, self._test, proxy)
        if len(self.resting) == self.count:
            self._give_up()

    def _give_up(self):
        """Every proxy is resting at once (the network is probably down): end the run."""
        self.slots.put_nowait((-1, next(self.order), None, 0))
