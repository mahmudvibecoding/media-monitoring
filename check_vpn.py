"""Check every local VPN proxy from vpn_proxies.txt with one real YouTube request, and count what works per
protocol and per source. Only a report: the collectors find working proxies by themselves (see pool.py).

Keep singbox_runner.py running in another terminal while this runs.
"""
import asyncio
import time
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor
from multiprocessing import get_context

from curl_cffi import AsyncSession

from pool import API, CONTEXT, raise_open_files_limit

INPUT = "vpn_proxies.txt"  # from singbox_runner.py: "<local proxy> <link>"
SOURCES_FILE = "vpn_sources.txt"  # from vpn_configs.py: "<link> <source> <source> ..."
# Tuned on a 52-core server. PROCESSES x CHECKS_PER_PROCESS should cover all proxies, so everything is checked
# in one wave. On a laptop, use far fewer (e.g. 4 processes x 500).
PROCESSES = 96
CHECKS_PER_PROCESS = 1500  # checks in flight in each process; 1500-2000 is safe
TIMEOUT = 5  # seconds per check, like a request in the collectors: slower proxies barely do any work there
TEST_CHANNEL = "UCVPst_iSyaVYpuOP4ogRhlw"  # KunUZ
FIELD_MASK = "metadata.channelMetadataRenderer.title"  # the check only needs the title


async def check(session, proxy):
    """Check one proxy. Returns (seconds, outcome); seconds is None if the proxy failed."""
    start = time.monotonic()
    try:
        response = await session.post(
            API + "browse?prettyPrint=false",
            json={"context": CONTEXT, "browseId": TEST_CHANNEL},
            headers={"X-Goog-FieldMask": FIELD_MASK},
            proxy=proxy,
            timeout=TIMEOUT,
        )
        if response.status_code != 200:
            return None, f"HTTP {response.status_code}"
        title = response.json()["metadata"]["channelMetadataRenderer"]["title"]
    except Exception as error:
        # Proxies fail in many ways, so any error counts as a failed check. The summary counts each error
        # type, so a mistake in this code would still show up (e.g. "2000  NameError").
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


def read_pairs(path):
    """Read lines like "first rest of line" into {first: "rest of line"}."""
    pairs = {}
    with open(path) as f:
        for line in f:
            first, _, rest = line.strip().partition(" ")
            if first:
                pairs[first] = rest
    return pairs


def print_table(title, counts):
    print(f"\n{title:52} {'checked':>7} {'works':>6} {'rate':>5} {'only here':>9}")
    for name, c in sorted(counts.items(), key=lambda item: -item[1]["works"]):
        checked = c["works"] + c["fails"]
        print(f"{name[:52]:52} {checked:>7} {c['works']:>6} {100 * c['works'] / checked:>4.0f}% {c['only here'] or '':>9}")


def main():
    links = read_pairs(INPUT)  # {local proxy: link}
    sources = read_pairs(SOURCES_FILE)  # {link: "source source ..."}

    print(f"checking {len(links)} local proxies...")
    started = time.monotonic()
    working, outcomes = check_all(list(links))
    print(f"\n{len(working)} of {len(links)} work ({time.monotonic() - started:.0f} s)")
    for outcome, count in outcomes.most_common():
        print(f"{count:>7}  {outcome}")

    # "only here": working configs that no other list has, which is what a source really adds
    works = {proxy for _, proxy in working}
    by_protocol, by_source = defaultdict(Counter), defaultdict(Counter)
    for proxy, link in links.items():
        result = "works" if proxy in works else "fails"
        by_protocol[link.split("://")[0]][result] += 1
        listed_in = sources.get(link, "unknown").split()
        for source in listed_in:
            by_source[source][result] += 1
            if result == "works" and len(listed_in) == 1:
                by_source[source]["only here"] += 1
    print_table("protocol", by_protocol)
    print_table("source", by_source)


# Needed for multiple processes: each worker process imports this file and must not run main() again.
if __name__ == "__main__":
    main()
