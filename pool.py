"""Send YouTube requests through the pool of working proxies, as fast as the proxies answer.

Each proxy has a few slots in a queue: a request takes the next free slot and puts it back when it ends,
so fast proxies come back sooner and carry more of the work. A request that fails goes out again through
another proxy. channels.py and the monitoring jobs all send their requests this way.
"""
import asyncio
import resource
import time
from collections import Counter, deque

API = "https://www.youtube.com/youtubei/v1/"  # InnerTube: the API behind YouTube's own website
CONTEXT = {"client": {"clientName": "WEB", "clientVersion": "2.20251001.01.00", "hl": "en", "gl": "US"}}
PROXY_FILE = "working_vpn_proxies.txt"  # from check_vpn.py, fastest first; the proxy is the first word of each line
REQUESTS_PER_PROXY = 8  # requests in flight through one proxy at a time, so a weak proxy isn't flooded
TIMEOUT = 5  # seconds; a proxy that hasn't answered by then is dropped
HEDGE_AFTER = 1  # when draining: seconds without an answer before the request also goes out elsewhere
ATTEMPTS = 5  # requests per answer at most
# YouTube returns a random 403/429 now and then; that alone changes nothing. Only a real storm (8 blocks
# among a proxy's last 10 answers) pauses that proxy for 30 seconds; then it continues at full speed.
STORM_WINDOW, STORM_BLOCKS, STORM_PAUSE = 10, 8, 30


class NoProxiesLeft(Exception):
    pass


class BadRequest(Exception):
    """YouTube rejected the request itself: probably a field mask is out of date."""


def load_proxies():
    """The working proxies from PROXY_FILE (run check_vpn.py first)."""
    with open(PROXY_FILE) as f:
        return [line.split()[0] for line in f if line.strip()]


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
    """One process's proxies, as slots in a queue. Each proxy starts with one slot, so a dead one holds up
    a single request; once YouTube answers through it, it gets REQUESTS_PER_PROXY slots."""

    def __init__(self, proxies):
        self.slots = asyncio.Queue()
        for proxy in proxies:
            self.slots.put_nowait(proxy)
        self.alive = set(proxies)
        self.proven = set()  # proxies that YouTube answered through
        self.recent = {proxy: deque(maxlen=STORM_WINDOW) for proxy in proxies}  # last answers: True = blocked
        self.paused_until = {}  # proxies resting after a storm: {proxy: time}
        self.draining = False  # set it when no new work is left: then slow requests also go out elsewhere
        self.outcomes = Counter()  # how every request ended
        self.background = set()  # slower copies of requests that already got their answer

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
                    proxy = await self._take()
                    tries.add(asyncio.create_task(self._send(request, proxy)))
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
        finally:
            for task in tries:  # left to finish, so their proxies are judged by how they answer
                self.background.add(task)
                task.add_done_callback(self.background.discard)

    async def close(self):
        """Cancel the slower copies of requests that are still running."""
        for task in list(self.background):
            task.cancel()
        await asyncio.gather(*self.background, return_exceptions=True)

    async def _send(self, request, proxy):
        outcome = result = None
        try:
            outcome, result = await request(proxy)
        finally:
            self._give_back(proxy, outcome)  # outcome is still None if this request was cancelled
        self.outcomes[outcome] += 1
        return outcome, result

    async def _take(self):
        """Wait for a free slot and return its proxy."""
        while True:
            proxy = await self.slots.get()
            if proxy is None:  # every proxy broke
                self.slots.put_nowait(None)  # tell the next waiting request too
                raise NoProxiesLeft
            if proxy in self.alive:  # slots of proxies that broke meanwhile are thrown away
                return proxy

    def _give_back(self, proxy, outcome):
        """Put the slot back after a request. outcome is None if the request was cancelled."""
        if outcome == "broken":  # the proxy itself failed: drop it
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
