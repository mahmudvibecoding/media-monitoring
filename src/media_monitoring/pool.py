"""Send YouTube requests through the local VPN proxies from sing-box, as fast as the proxies answer.

Real requests test the proxies, so there's no separate check, and each run starts fresh with every proxy in random
order: proxies stop working within minutes, so a list from an earlier run wouldn't help. Each proxy has slots in a
queue: a request takes the best free slot and puts it back when it ends, so fast proxies come back sooner and carry
more of the work. Working proxies' slots always go first: untested proxies only get requests that would otherwise
wait.

Each proxy finds its own pace. An untested proxy has one slot, so a dead one holds up a single request, and its
failure doesn't count against the request's tries; if it has no answer within HEDGE_AFTER seconds, the request also
goes out through a working proxy, when one has a free slot. Once YouTube answers through a proxy, it gets
START_LIMIT slots, and one more after each answer that found all of them busy, up to MAX_LIMIT: with few proxies
each one carries more, with many each carries less. Each failure takes one slot away; at zero the proxy rests and
is then tested again, so proxies that recover come back even during long runs. The collectors all send their
requests this way (youtube.call sends each one).
"""
import asyncio
import itertools
import random
import resource
import time
import zlib
from collections import Counter, deque

PROXY_FILE = "data/vpn_proxies.txt"  # from singbox: one line per local proxy, "proxy link"
PLAIN_PROXY_FILE = "data/plain_proxies.txt"  # from plain-proxies: free HTTP and SOCKS4 proxies, used with --plain
START_LIMIT, MAX_LIMIT = 8, 64  # slots of a proxy once YouTube has answered through it, and at most
HEDGE_AFTER = 1  # seconds without an answer before a request through an untested proxy (or any, when draining)
                 # also goes out through a working proxy, if one has a free slot
ATTEMPTS = 5  # requests per answer at most, not counting failures of proxies that were being tested
# YouTube's own 400s in a row, with no good answer between, that stop the run: a field mask is probably out of date.
# A single one only fails its request.
BAD_REQUESTS = 20
# Seconds a proxy rests when its slots fall to zero: a proxy that has answered in this run comes back sooner, while
# one that never has (most of them are dead) is tried less often
REST, REST_IF_NEVER_ANSWERED = 30, 60
# YouTube blocks an address from video pages and comments (its next endpoint) for a while after heavy use, so the
# scripts that ask for those let every failed proxy rest this long instead, and then try it again
LONG_REST = 900
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


def load_proxies(path=PROXY_FILE):
    """Every proxy in a list, in random order: by default the local ones from sing-box (run singbox first).
    None if the list doesn't exist."""
    try:
        with open(path) as f:
            proxies = [line.split()[0] for line in f if line.strip()]
    except FileNotFoundError:
        return []
    random.shuffle(proxies)
    return proxies


def load_share(path, share, shares):
    """One process's share of a proxy list, by a hash of each proxy: the same proxies whenever the list is read, so a
    refreshed list brings each process only what's new to it."""
    return [proxy for proxy in load_proxies(path) if zlib.crc32(proxy.encode()) % shares == share]


def raise_open_files_limit():
    """Every connection needs an open file; the default limit (1024 on Linux, 256 on macOS) is too low."""
    _, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    for limit in (1_000_000, 10240):  # macOS refuses more than 10240
        try:
            resource.setrlimit(resource.RLIMIT_NOFILE, (min(limit, hard), hard))
            return
        except (ValueError, OSError):
            continue


class Pool:
    """One process's share of the proxies (see the top of this file), in the order to test them. rest, if given, is
    how long every proxy whose slots fall to zero rests (else REST or REST_IF_NEVER_ANSWERED). With give_up=False,
    requests wait when every proxy rests at once, for one to come back or for add() to bring new ones."""

    def __init__(self, proxies, rest=None, give_up=True):
        self.rest = rest
        self.give_up = give_up
        self.known = set(proxies)
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
        self.bad_requests = 0  # YouTube's 400s since its last good answer
        for proxy in proxies:
            self._test(proxy)
        if not proxies and give_up:
            self._give_up()

    def add(self, proxies):
        """Proxies that joined the lists while the pool runs: each gets one slot, so its next request tests it."""
        for proxy in proxies:
            if proxy not in self.known:
                self.known.add(proxy)
                self.count += 1
                self._test(proxy)

    def renew(self, proxies):
        """Proxies whose address now leads somewhere else (sing-box restarted with new configs): what we knew about
        them no longer holds, so each is tested again."""
        self.add(proxies)
        for proxy in set(proxies) & self.known:
            self.generation[proxy] += 1  # its slots, and a rest it was taking, are thrown away
            self.proven.discard(proxy)
            self.answered.discard(proxy)
            self._test(proxy)

    async def run(self, request):
        """Get one answer. request(proxy) sends one request through that proxy and returns (outcome, result),
        where outcome is "ok", "gone" or a problem from youtube.call(). A failed request goes out again through
        another proxy, up to ATTEMPTS times. A request without an answer after HEDGE_AFTER seconds also goes out
        through a working proxy with a free slot if it only went through untested proxies, or always when draining;
        the first useful answer wins. Returns ("ok", result), ("gone", result) or ("failed", None)."""
        tries, tests, sent, slow = set(), set(), 0, False
        try:
            while True:
                slot = None
                if sent < ATTEMPTS and not tries:
                    slot = await self._take()
                elif sent < ATTEMPTS and slow and (self.draining or tries <= tests):
                    slot = self._take_working()  # a copy only goes through a proxy that already works
                if slot:
                    proxy, generation = slot
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
                    if outcome == "bad request" and self.bad_requests >= BAD_REQUESTS:
                        raise BadRequest("YouTube keeps answering 400: a field mask is probably out of date")
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
            if self._claim(proxy, generation):
                return proxy, generation

    def _take_working(self):
        """A free slot of a working proxy if there's one right now, else None; returns its proxy and generation."""
        while not self.slots.empty():
            entry = self.slots.get_nowait()
            rank, _, proxy, generation = entry
            if rank != WORKING:
                self.slots.put_nowait(entry)  # the best free slot isn't a working proxy's: leave it
                return None
            if self._claim(proxy, generation):
                return proxy, generation
        return None

    def _claim(self, proxy, generation):
        """Use a slot taken from the queue, unless it's gone: True if it's now busy."""
        if generation != self.generation[proxy]:
            return False  # the proxy has rested since: its old slots are gone
        if self.held[proxy] > self.limit[proxy]:
            self.held[proxy] -= 1  # the proxy failed since, so it has fewer slots now
            return False
        self.busy[proxy] += 1
        return True

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
        elif outcome in ("ok", "gone", "blocked", "youtube error", "bad request"):  # YouTube answered
            self.bad_requests = self.bad_requests + 1 if outcome == "bad request" else 0
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
        self.busy[proxy] = 0
        self._free(proxy, self.generation[proxy])

    def _rest(self, proxy):
        """The proxy failed with its last slot: it rests, then is tested again."""
        self.generation[proxy] += 1  # its slots still out are thrown away
        self.held[proxy] = self.busy[proxy] = 0
        self.proven.discard(proxy)
        self.resting.add(proxy)
        rest = self.rest or (REST if proxy in self.answered else REST_IF_NEVER_ANSWERED)
        asyncio.get_running_loop().call_later(rest, self._wake, proxy, self.generation[proxy])
        if len(self.resting) == self.count and self.give_up:
            self._give_up()

    def _wake(self, proxy, generation):
        """The proxy's rest is over: test it again, unless renew() already did."""
        if generation == self.generation[proxy]:
            self._test(proxy)

    def _give_up(self):
        """Every proxy is resting at once (the network is probably down): end the run."""
        self.slots.put_nowait((-1, next(self.order), None, 0))
