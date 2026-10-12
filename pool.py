"""Send YouTube requests through the local VPN proxies from sing-box, as fast as the proxies answer.

Real requests test the proxies, so there's no separate check, and each run starts fresh with every proxy in random
order: proxies stop working within minutes, so a list from an earlier run wouldn't help. Each proxy has slots in a
queue: a request takes the best free slot and puts it back when it ends, so fast proxies come back sooner and carry
more of the work. Working proxies' slots always go first: untested proxies only get requests that would otherwise
wait.

Each proxy finds its own pace. An untested proxy has one slot, so a dead one holds up a single request, which also
goes out elsewhere if it has no answer within HEDGE_AFTER seconds, and its failure doesn't count against the
request's tries. Once YouTube answers through a proxy, it gets START_LIMIT slots, and one more after each answer
that found all of them busy, up to MAX_LIMIT: with few proxies each one carries more, with many each carries less.
Each failure takes one slot away; at zero the proxy rests REST seconds and is then tested again, so proxies that
recover come back even during long runs. channels.py and the other collectors all send their requests this way.
"""
import asyncio
import itertools
import random
import resource
import time
from collections import Counter, deque

API = "https://www.youtube.com/youtubei/v1/"  # InnerTube: the API behind YouTube's own website
CONTEXT = {"client": {"clientName": "WEB", "clientVersion": "2.20251001.01.00", "hl": "en", "gl": "US"}}
PROXY_FILE = "vpn_proxies.txt"  # from singbox_runner.py: one line per local proxy, "proxy link"
START_LIMIT, MAX_LIMIT = 8, 64  # slots of a proxy once YouTube has answered through it, and at most
TIMEOUT = 5  # seconds; a proxy that hasn't answered by then has failed
HEDGE_AFTER = 1  # seconds without an answer before a request through an untested proxy (or any, when draining)
                 # also goes out elsewhere
ATTEMPTS = 5  # requests per answer at most, not counting failures of proxies that were being tested
REST = 30  # seconds a proxy rests when its slots fall to zero
# YouTube returns a random 403/429 now and then; that alone changes nothing. Only a real storm (8 blocks
# among a proxy's last 10 answers) pauses that proxy for 30 seconds; then it continues at full speed.
STORM_WINDOW, STORM_BLOCKS, STORM_PAUSE = 10, 8, 30
# Which free slot a request gets first: a working proxy's; else a test of a proxy that answered earlier in this
# run; else a test of any other
WORKING, ANSWERED_BEFORE, OTHER = range(3)


class NoProxiesLeft(Exception):
    pass


class BadRequest(Exception):
    """YouTube rejected the request itself: probably a field mask is out of date."""


def load_proxies():
    """Every local proxy from sing-box (run singbox_runner.py first), in random order."""
    with open(PROXY_FILE) as f:
        proxies = [line.split()[0] for line in f if line.strip()]
    random.shuffle(proxies)
    return proxies


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
        self.resting = set()  # proxies waiting for their next test
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
        another proxy, up to ATTEMPTS times. A request without an answer after HEDGE_AFTER seconds also goes out
        elsewhere if it only went through untested proxies, or always when draining; the first useful answer wins.
        Returns ("ok", result), ("gone", result) or ("failed", None)."""
        tries, tests, sent, slow = set(), set(), 0, False
        try:
            while True:
                if sent < ATTEMPTS and (not tries or (slow and (self.draining or tries <= tests))):
                    proxy, generation = await self._take()
                    task = asyncio.create_task(self._send(request, proxy, generation))
                    tries.add(task)
                    if proxy not in self.proven:
                        tests.add(task)  # this request also tests the proxy
                    sent += 1
                elif not tries:
                    return "failed", None
                done, tries = await asyncio.wait(tries, timeout=HEDGE_AFTER, return_when=asyncio.FIRST_COMPLETED)
                slow = not done
                for task in done:
                    outcome, result = task.result()
                    if outcome == "bad request":
                        raise BadRequest("YouTube answered 400 Bad Request: a field mask is probably out of date")
                    if outcome in ("ok", "gone"):
                        return outcome, result
                    if outcome == "broken" and task in tests:
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
        outcome = result = None
        try:
            outcome, result = await request(proxy)
        finally:
            self._give_back(proxy, generation, outcome)  # outcome is still None if this request was cancelled
        self.outcomes[outcome] += 1
        return outcome, result

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
            self.limit[proxy] -= 1
            if not self.limit[proxy]:
                self._rest(proxy)
                return
        elif outcome in ("ok", "gone", "blocked", "youtube error"):  # YouTube answered
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
        """The proxy failed with its last slot: it rests, then is tested again."""
        self.generation[proxy] += 1  # its slots still out are thrown away
        self.held[proxy] = self.busy[proxy] = 0
        self.proven.discard(proxy)
        self.resting.add(proxy)
        asyncio.get_running_loop().call_later(REST, self._test, proxy)
        if len(self.resting) == self.count:
            self._give_up()

    def _give_up(self):
        """Every proxy is resting at once (the network is probably down): end the run."""
        self.slots.put_nowait((-1, next(self.order), None, 0))
