"""Send requests to YouTube and Telegram through the local VPN proxies from sing-box, as fast as the proxies
answer.

Each run starts fresh with every proxy untested, in random order: proxies stop working within minutes, so a list
from an earlier run wouldn't help. Testing runs on its own, apart from the work: each proxy gets a test request, the
collector's own kind on an item that has been up for years, and a proxy YouTube answers through starts carrying work
at once. Real requests only go through proxies that work, so none waits on a dead one. How many tests run at a time
follows the CPU the work leaves unused (see allow_tests): many while few proxies work, few while the work needs the
CPU. Once every VPN proxy has been tested and there's room for more tests, the plain proxies are tested too.

Each working proxy has slots in a queue: a request takes the next free slot and puts it back when it ends, so fast
proxies come back sooner and carry more of the work. A proxy starts with START_LIMIT slots and gets one more after
each answer that found all of them busy, up to MAX_LIMIT: with few proxies each one carries more, with many each
carries less. Each failure takes one slot away; at zero the proxy rests and is then tested again, as is one that
failed its test, so proxies that recover come back within half a minute or so, even during long runs. A dead proxy's
test costs little: a connection attempt, nothing to download or read. The collectors all send their requests this way
(youtube.call or telegram.call sends each one).
"""
import asyncio
import itertools
import random
import resource
import time
import zlib
from collections import Counter, deque

PROXY_FILE = "data/vpn_proxies.txt"  # from sing-box (uv run proxies): one line per local proxy, "proxy link"
PLAIN_PROXY_FILE = "data/plain_proxies.txt"  # from uv run proxies: plain HTTP and SOCKS proxies, the reserve
START_LIMIT, MAX_LIMIT = 8, 64  # slots of a proxy once YouTube has answered through it, and at most
HEDGE_AFTER = 1  # when draining: seconds without an answer before a request also goes out through another proxy
ATTEMPTS = 5  # requests per answer at most
# Proxy tests in flight at a time, in each process: TESTS_START at first, then between TESTS_MIN and TESTS_MAX by how
# much CPU the work leaves unused (see allow_tests). A fixed 500 found more proxies than 100, but slowed the work.
TESTS_MIN, TESTS_START, TESTS_MAX = 25, 100, 1000
# YouTube's own 400s in a row, with no good answer between, that stop the run: a field mask is probably out of date.
# A single one only fails its request.
BAD_REQUESTS = 20
# Seconds a proxy rests when it fails its test, or when its slots fall to zero, before it's tested again: a random
# length in this range, so proxies that failed together come back at different times. With one fixed length they came
# back together, and the load rose and fell every minute. A proxy can wait longer in line for its test, when the
# tests are few (see TESTS_MIN).
REST = (25, 35)
# YouTube returns a random 403/429 now and then; that alone changes nothing. Only a real storm (8 blocks
# among a proxy's last 10 answers) pauses that proxy, for a random length in this range; then it continues at full
# speed.
STORM_WINDOW, STORM_BLOCKS, STORM_PAUSE = 10, 8, (45, 75)
# A process brings in its reserve (its share of the plain proxies) once every VPN proxy has been tested and its tests
# have room for more, or once its working proxies fall to a quarter of the most it had working at once, which YouTube
# blocking their addresses does, or once every proxy rests. Below this many, a peak is too small to say.
MIN_PEAK = 8
# Outcomes of a request the site answered
ANSWERED = ("ok", "gone", "blocked", "youtube error", "telegram error", "bad request")


class NoProxiesLeft(Exception):
    pass


class BadRequest(Exception):
    """YouTube rejected the request itself: probably a field mask is out of date."""


def load_proxies(path=PROXY_FILE):
    """Every proxy in a list, in random order: by default the local ones from sing-box (run "uv run proxies" first).
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
    """One process's share of the proxies (see the top of this file), in the order to test them; start_testing()
    starts the tests. reserve is more proxies (the plain ones), brought in once there's room to test them or the
    working proxies collapse (see MIN_PEAK), and always tested after the VPN ones; on_reserve is called when they
    are. With give_up=False, requests wait when every proxy rests at once, for one to come back or for add() to bring
    new ones."""

    def __init__(self, proxies, give_up=True, reserve=(), on_reserve=None):
        self.give_up = give_up
        self.reserve = list(reserve)  # replaceable until used, e.g. by a refreshed list
        self.reserve_used = False
        self.on_reserve = on_reserve
        self.peak = 0  # the most proxies working at once in this run
        self.known = set(proxies)
        self.slots = asyncio.Queue()  # working proxies' free slots, in the order they were freed: (proxy, generation)
        # Proxies waiting for a test, VPN ones first, then in the order they came: (plain, number, proxy, generation)
        self.to_test = asyncio.PriorityQueue()
        self.order = itertools.count()  # the numbers that keep that order
        self.plain = set()  # the plain proxies brought in from the reserve
        self.test, self.testers = None, []  # the test request (see start_testing), and the tasks that test them
        self.allowed = TESTS_START  # tests that may run at once (see allow_tests)
        self.raised = asyncio.Event()  # set when more tests may run at once
        self.generation = Counter()  # raised when a proxy starts resting, so the slots it had are thrown away
        self.limit = Counter()  # how many slots each proxy may have
        self.held = Counter()  # each proxy's slots, free or in use
        self.busy = Counter()  # each proxy's slots in use
        self.proven = set()  # proxies that work: they answered their test and haven't rested since
        self.resting = set()  # proxies resting before their next test
        self.recent = {}  # each proxy's last answers: True = blocked
        self.paused_until = {}  # proxies resting after a storm: {proxy: time}
        self.count = len(proxies)
        self.draining = False  # set it when no new work is left: then slow requests also go out elsewhere
        self.outcomes = Counter()  # how every request ended
        self.test_outcomes = Counter()  # how every test ended
        self.background = set()  # slower copies of requests that already got their answer
        self.bad_requests = 0  # YouTube's 400s since its last good answer
        for proxy in proxies:
            self._queue_test(proxy)
        if not proxies:
            self._bring_reserve()
        if not self.count and give_up:
            self._give_up()

    def start_testing(self, test):
        """Start testing the proxies, TESTS_START at a time until allow_tests() says otherwise. test(proxy) sends one
        test request through the proxy and returns (outcome, result) like a request: the proxy works if YouTube
        answered."""
        self.test = test
        self.testers = [asyncio.create_task(self._tester(n)) for n in range(TESTS_MAX)]

    def allow_tests(self, allowed):
        """How many tests may run at once from now on, between TESTS_MIN and TESTS_MAX: the runner raises it while the
        work leaves CPU unused, as when few proxies work, and lowers it while the work needs the CPU (see
        parallel.py)."""
        raised, self.allowed = allowed > self.allowed, allowed
        if raised:
            self.raised.set()  # wakes the testers waiting for it
            self.raised = asyncio.Event()

    def add(self, proxies, plain=False):
        """Proxies that joined the lists while the pool runs: each is tested, the plain ones after the VPN ones."""
        for proxy in proxies:
            if proxy not in self.known:
                self.known.add(proxy)
                self.count += 1
                if plain:
                    self.plain.add(proxy)
                self._queue_test(proxy)

    def renew(self, proxies):
        """Proxies whose address now leads somewhere else (sing-box restarted with new configs): what we knew about
        them no longer holds, so each is tested again."""
        self.add(proxies)
        for proxy in set(proxies) & self.known:
            self.generation[proxy] += 1  # its slots, and a rest it was taking, are thrown away
            self.proven.discard(proxy)
            self._queue_test(proxy)
        self.peak = len(self.proven)  # what worked before says nothing about the new ones

    async def run(self, request):
        """Get one answer. request(proxy) sends one request through that proxy and returns (outcome, result),
        where outcome is "ok", "gone" or a problem from youtube.call(). A failed request goes out again through
        another proxy, up to ATTEMPTS times. When draining, a request without an answer after HEDGE_AFTER seconds
        also goes out through another proxy with a free slot; the first useful answer wins. Returns ("ok", result),
        ("gone", result) or ("failed", None)."""
        tries, sent, slow = set(), 0, False
        try:
            while True:
                slot = None
                if sent < ATTEMPTS and not tries:
                    slot = await self._take()
                elif sent < ATTEMPTS and slow and self.draining:
                    slot = self._take_free()
                if slot:
                    proxy, generation = slot
                    tries.add(asyncio.create_task(self._send(request, proxy, generation)))
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
        finally:
            for task in tries:  # left to finish, so their proxies are judged by how they answer
                self.background.add(task)
                task.add_done_callback(self.background.discard)

    async def close(self):
        """Stop the tests, and cancel the slower copies of requests that are still running."""
        tasks = self.testers + list(self.background)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def _send(self, request, proxy, generation):
        outcome = result = None
        try:
            outcome, result = await request(proxy)
        finally:
            self._give_back(proxy, generation, outcome)  # outcome is still None if this request was cancelled
        self.outcomes[outcome] += 1
        return outcome, result

    async def _take(self):
        """Wait for a free slot; return its proxy and generation."""
        while True:
            proxy, generation = await self.slots.get()
            if proxy is None:  # every proxy is resting
                self.slots.put_nowait((proxy, generation))  # tell the next waiting request too
                raise NoProxiesLeft
            if self._claim(proxy, generation):
                return proxy, generation

    def _take_free(self):
        """A free slot if there's one right now, else None; returns its proxy and generation."""
        while not self.slots.empty():
            proxy, generation = self.slots.get_nowait()
            if proxy is None:
                self.slots.put_nowait((proxy, generation))
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
        self.slots.put_nowait((proxy, generation))

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
        elif outcome in ANSWERED:
            self.bad_requests = self.bad_requests + 1 if outcome == "bad request" else 0
            if all_busy and outcome in ("ok", "gone"):  # it could carry more
                self.limit[proxy] = min(MAX_LIMIT, self.limit[proxy] + 1)
            recent = self.recent.setdefault(proxy, deque(maxlen=STORM_WINDOW))
            recent.append(outcome == "blocked")
            if sum(recent) >= STORM_BLOCKS:
                recent.clear()
                self.paused_until[proxy] = time.monotonic() + random.uniform(*STORM_PAUSE)
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

    def _queue_test(self, proxy):
        """Put the proxy in line for a test."""
        self.resting.discard(proxy)
        self.to_test.put_nowait((proxy in self.plain, next(self.order), proxy, self.generation[proxy]))

    async def _tester(self, n):
        """Test the proxies waiting for it, one at a time. There are TESTS_MAX of these, and the nth only tests while
        more than n tests may run at once."""
        while True:
            while n >= self.allowed:
                await self.raised.wait()
            if self.to_test.empty():
                self._bring_reserve()  # every proxy is tested, and there's room for more tests
            waiting = await self.to_test.get()
            if n >= self.allowed:  # fewer tests may run meanwhile: it keeps its place in line for another tester
                self.to_test.put_nowait(waiting)
                continue
            _, _, proxy, generation = waiting
            if generation != self.generation[proxy]:
                continue  # renew() tested it again meanwhile
            try:
                outcome, _ = await self.test(proxy)
            except Exception:  # a test that went wrong in an unexpected way: the proxy failed it
                outcome = "broken"
            self.test_outcomes[outcome] += 1
            if generation != self.generation[proxy]:
                continue
            if outcome in ANSWERED:
                self._start_work(proxy)
            else:
                self._rest(proxy)

    def _start_work(self, proxy):
        """The proxy passed its test: it gets START_LIMIT slots."""
        self.proven.add(proxy)
        self.peak = max(self.peak, len(self.proven))
        self.limit[proxy] = self.held[proxy] = START_LIMIT
        self.busy[proxy] = 0
        for _ in range(START_LIMIT):
            self._free(proxy, self.generation[proxy])

    def _rest(self, proxy):
        """The proxy failed its test, or failed with its last slot: it rests, then is tested again."""
        self.generation[proxy] += 1  # its slots still out are thrown away
        self.held[proxy] = self.busy[proxy] = 0
        self.proven.discard(proxy)
        self.resting.add(proxy)
        asyncio.get_running_loop().call_later(random.uniform(*REST), self._wake, proxy, self.generation[proxy])
        collapsed = self.peak >= MIN_PEAK and len(self.proven) * 4 <= self.peak
        if collapsed or len(self.resting) == self.count:
            self._bring_reserve()
        if len(self.resting) == self.count and self.give_up:
            self._give_up()

    def _bring_reserve(self):
        """Bring in the reserve, once: each of its proxies is tested, after the VPN ones."""
        if self.reserve_used or not self.reserve:
            return
        self.reserve_used = True
        self.add(self.reserve, plain=True)
        if self.on_reserve:
            self.on_reserve()

    def _wake(self, proxy, generation):
        """The proxy's rest is over: test it again, unless renew() already did."""
        if generation == self.generation[proxy]:
            self._queue_test(proxy)

    def _give_up(self):
        """Every proxy is resting at once (the network is probably down): end the run."""
        self.slots.put_nowait((None, 0))
