import asyncio
import ipaddress
import os
import random
import resource
import time
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
from multiprocessing import get_context
from pathlib import Path

from curl_cffi import AsyncSession

# (url, type) — type is None when each line already starts with its type, like "socks5://..."
SOURCES = [
    ("https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.txt", None),
    ("https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text", None),
    ("https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt", "http"),
    ("https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt", "socks4"),
    ("https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt", "socks5"),
    ("https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt", "http"),
    ("https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt", "socks4"),
    ("https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt", "socks5"),
    ("https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt", "socks5"),
    ("https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/http.txt", "http"),
    ("https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/socks5.txt", "socks5"),
]

URL = "https://www.youtube.com/youtubei/v1/browse?prettyPrint=false"
CONTEXT = {"client": {"clientName": "WEB", "clientVersion": "2.20251001.01.00", "hl": "en", "gl": "US"}}
TEST_CHANNEL = "UCVPst_iSyaVYpuOP4ogRhlw"  # KunUZ
FIELD_MASK = "metadata.channelMetadataRenderer.title"  # the check only needs the title

# Tuned on a 52-core server with 1 Gbit. PROCESSES x CHECKS_PER_PROCESS should cover all candidates,
# so everything is checked in one wave. On a laptop, use far fewer (e.g. 4 processes x 500).
PROCESSES = 96
CHECKS_PER_PROCESS = 1500  # checks in flight in each process; 1500-2000 is safe
TIMEOUT = 5  # seconds per check, like a request in channels.py: slower proxies barely do any work there
SAMPLE = None  # check only this many random candidates; None checks all
OUTPUT = Path("working_proxies.txt")


def parse_line(line, default_type):
    """Turn one line from a list into a proxy URL like "socks5://1.2.3.4:1080", or None."""
    line = line.strip()
    proxy_type = default_type
    if "://" in line:
        proxy_type, line = line.split("://", 1)
    parts = line.split(":")  # "ip:port" or "ip:port:extra"
    if proxy_type is None or len(parts) < 2:
        return None
    ip, port = parts[0], parts[1]
    try:
        ipaddress.IPv4Address(ip)  # raises ValueError if it isn't an IP address
        port = int(port)
    except ValueError:
        return None
    if not 1 <= port <= 65535:
        return None
    proxy_type = proxy_type.lower()
    if proxy_type == "https":  # in these lists, "https" means an HTTP proxy that can reach HTTPS sites
        proxy_type = "http"
    if proxy_type not in ("http", "socks4", "socks5"):
        return None
    return f"{proxy_type}://{ip}:{port}"


async def download(session, url):
    response = await session.get(url, timeout=30)
    response.raise_for_status()
    return response.text


async def collect():
    """Download all sources and return the unique proxy URLs."""
    async with AsyncSession() as session:
        # Download all sources at the same time. return_exceptions=True keeps one
        # failed download from stopping the others.
        results = await asyncio.gather(
            *(download(session, url) for url, _ in SOURCES), return_exceptions=True
        )

    candidates = set()  # a set removes duplicates automatically
    for (url, default_type), result in zip(SOURCES, results):
        if isinstance(result, Exception):
            print(f"FAILED   {url}: {result}")
            continue
        found = set()
        for line in result.splitlines():
            proxy = parse_line(line, default_type)
            if proxy:
                found.add(proxy)
        print(f"{len(found):>7}  {url}")
        candidates |= found

    print(f"{len(candidates):>7}  unique candidates in total")
    return candidates


def raise_open_files_limit():
    """Every connection needs an open file; the default limit (1024 on Linux, 256 on macOS) is too low."""
    _, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    for limit in (1_000_000, 10240):  # macOS refuses more than 10240
        try:
            resource.setrlimit(resource.RLIMIT_NOFILE, (min(limit, hard), hard))
            return
        except (ValueError, OSError):
            continue


async def check(session, proxy):
    """Check one proxy. Returns (seconds, outcome); seconds is None if the proxy failed."""
    start = time.monotonic()
    try:
        response = await session.post(
            URL,
            json={"context": CONTEXT, "browseId": TEST_CHANNEL},
            headers={"X-Goog-FieldMask": FIELD_MASK},
            proxy=proxy,
            timeout=TIMEOUT,
        )
        if response.status_code != 200:
            return None, f"HTTP {response.status_code}"
        title = response.json()["metadata"]["channelMetadataRenderer"]["title"]
    except Exception as error:
        # Free proxies send all kinds of garbage, and reading it can fail in many ways, so any
        # error here counts as a failed check. The summary at the end counts each error type,
        # so a mistake in this code would still show up (e.g. "2000  NameError").
        return None, type(error).__name__
    if not title:
        return None, "no title"
    return time.monotonic() - start, "works"


async def check_share(proxies):
    """Check one process's share of the proxies, CHECKS_PER_PROCESS at a time."""
    raise_open_files_limit()
    working, outcomes = [], Counter()
    remaining = iter(proxies)

    async def worker():
        for proxy in remaining:  # all workers share one iterator, so each proxy is checked once
            seconds, outcome = await check(session, proxy)
            outcomes[outcome] += 1
            if seconds is not None:
                working.append((seconds, proxy))

    # verify=False: no certificate checks through proxies (all the data is public)
    async with AsyncSession(impersonate="chrome", verify=False, max_clients=CHECKS_PER_PROCESS) as session:
        await asyncio.gather(*(worker() for _ in range(min(CHECKS_PER_PROCESS, len(proxies)))))
    return working, outcomes


def run_share(proxies):
    """Entry point of each worker process: it runs its own event loop."""
    return asyncio.run(check_share(proxies))


def check_all(proxies):
    """Split the proxies between processes and check them in parallel, all in one wave."""
    # only as many processes as one wave needs (up to PROCESSES): 1,000 proxies need just one
    processes = max(1, min(PROCESSES, -(-len(proxies) // CHECKS_PER_PROCESS)))
    shares = [proxies[i::processes] for i in range(processes)]
    # "spawn" starts each process fresh, which works the same on macOS and Linux
    with ProcessPoolExecutor(processes, mp_context=get_context("spawn")) as pool:
        results = list(pool.map(run_share, shares))
    working = sorted(w for share_working, _ in results for w in share_working)
    outcomes = sum((share_outcomes for _, share_outcomes in results), Counter())
    return working, outcomes


def save(working):
    """Write the working proxies, fastest first, without ever leaving half a file behind."""
    tmp = OUTPUT.with_suffix(".tmp")
    tmp.write_text("".join(f"{proxy}\n" for _, proxy in working))
    os.replace(tmp, OUTPUT)  # swaps in the new file in one step


def main():
    candidates = sorted(asyncio.run(collect()))
    if SAMPLE:
        candidates = random.sample(candidates, SAMPLE)

    print(f"\nchecking with up to {PROCESSES} processes x {CHECKS_PER_PROCESS} checks at a time...")
    started = time.monotonic()
    working, outcomes = check_all(candidates)
    seconds = time.monotonic() - started
    save(working)

    print(f"\n{len(working)} of {len(candidates)} work ({seconds:.0f} s), saved to {OUTPUT}")
    for outcome, count in outcomes.most_common():
        print(f"{count:>7}  {outcome}")
    print("\nfastest:")
    for latency, proxy in working[:10]:
        print(f"{latency:5.2f} s  {proxy}")


# Needed for multiple processes: each worker process imports this file and must not run main() again.
if __name__ == "__main__":
    main()