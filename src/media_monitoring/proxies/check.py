"""Check every proxy with one real YouTube request, and count what works per protocol and per source list. Only a
report: the collectors find working proxies by themselves (see pool.py).

    uv run check-vpn      the local VPN proxies from singbox (keep it running in another terminal)
    uv run check-plain    the free proxies from plain-proxies

A VPN proxy is checked with a channel page, the lightest request the collectors make. Free proxies are only used for
video pages and comments (YouTube's next endpoint, with --plain), so a free proxy is checked with a video page.
"""
import asyncio
import sys
import time
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor
from functools import partial
from multiprocessing import get_context

from curl_cffi import AsyncSession

from media_monitoring.pool import PLAIN_PROXY_FILE, PROXY_FILE, raise_open_files_limit
from media_monitoring.youtube import API, CONTEXT

VPN_SOURCES = "data/vpn_sources.txt"  # from vpn-proxies: "<link> <source> <source> ..."
PLAIN_SOURCES = "data/plain_sources.txt"  # from plain-proxies: "<proxy> <source> <source> ..."
# Tuned on a 52-core server. PROCESSES x CHECKS_PER_PROCESS should cover all VPN proxies, so they're checked in one
# wave; the free ones take a few. On a laptop, use far fewer (e.g. 4 processes x 500).
PROCESSES = 96
CHECKS_PER_PROCESS = 1500  # checks in flight in each process; 1500-2000 is safe
TIMEOUT = 5  # seconds per check, like a request in the collectors: slower proxies barely do any work there
# The request each kind of proxy is checked with: (url, body, headers). Both ask only for a title.
TESTS = {
    "vpn": (API + "browse?prettyPrint=false", {"browseId": "UCVPst_iSyaVYpuOP4ogRhlw"},  # KunUZ
            {"X-Goog-FieldMask": "metadata.channelMetadataRenderer.title"}),
    "plain": (API + "next?prettyPrint=false&fields=contents/twoColumnWatchNextResults/results/results/contents/"
              "videoPrimaryInfoRenderer/title/runs/text", {"videoId": "dQw4w9WgXcQ"}, {}),  # up since 2009
}


def title(kind, data):
    """The title in a test's answer, or None."""
    if kind == "vpn":
        return data["metadata"]["channelMetadataRenderer"]["title"]
    for item in data["contents"]["twoColumnWatchNextResults"]["results"]["results"]["contents"]:
        if "videoPrimaryInfoRenderer" in item:
            return "".join(run["text"] for run in item["videoPrimaryInfoRenderer"]["title"]["runs"])
    return None


async def check(session, proxy, kind):
    """Check one proxy. Returns (seconds, outcome); seconds is None if the proxy failed."""
    url, body, headers = TESTS[kind]
    start = time.monotonic()
    try:
        response = await session.post(url, json={"context": CONTEXT, **body}, headers=headers, proxy=proxy,
                                      timeout=TIMEOUT)
        if response.status_code != 200:
            return None, f"HTTP {response.status_code}"
        found = title(kind, response.json())
    except Exception as error:
        # Proxies fail in many ways, so any error counts as a failed check. The summary counts each error
        # type, so a mistake in this code would still show up (e.g. "2000  NameError").
        return None, type(error).__name__
    if not found:
        return None, "no title"
    return time.monotonic() - start, "works"


async def check_share(proxies, kind):
    """Check one process's share of the proxies, CHECKS_PER_PROCESS at a time."""
    raise_open_files_limit()
    working, outcomes = [], Counter()
    remaining = iter(proxies)

    async def worker():
        for proxy in remaining:  # all workers share one iterator, so each proxy is checked once
            seconds, outcome = await check(session, proxy, kind)
            outcomes[outcome] += 1
            if seconds is not None:
                working.append((seconds, proxy))

    # verify=False: no certificate checks through proxies (all the data is public)
    async with AsyncSession(impersonate="chrome", verify=False, max_clients=CHECKS_PER_PROCESS) as session:
        await asyncio.gather(*(worker() for _ in range(min(CHECKS_PER_PROCESS, len(proxies)))))
    return working, outcomes


def run_share(proxies, kind):
    """Entry point of each worker process: it runs its own event loop."""
    return asyncio.run(check_share(proxies, kind))


def check_all(proxies, kind):
    """Split the proxies between processes and check them in parallel."""
    # only as many processes as one wave needs (up to PROCESSES): 1,000 proxies need just one
    processes = max(1, min(PROCESSES, -(-len(proxies) // CHECKS_PER_PROCESS)))
    shares = [proxies[i::processes] for i in range(processes)]
    # "spawn" starts each process fresh, which works the same on macOS and Linux
    with ProcessPoolExecutor(processes, mp_context=get_context("spawn")) as pool:
        results = list(pool.map(partial(run_share, kind=kind), shares))
    working = sorted(w for share_working, _ in results for w in share_working)
    outcomes = sum((share_outcomes for _, share_outcomes in results), Counter())
    return working, outcomes


def read_pairs(path):
    """Read lines like "first rest of line" into {first: "rest of line"}; {} if the file doesn't exist."""
    pairs = {}
    try:
        with open(path) as f:
            for line in f:
                first, _, rest = line.strip().partition(" ")
                if first:
                    pairs[first] = rest
    except FileNotFoundError:
        pass
    return pairs


def print_table(title, counts):
    print(f"\n{title:52} {'checked':>7} {'works':>6} {'rate':>5} {'only here':>9}")
    for name, c in sorted(counts.items(), key=lambda item: -item[1]["works"]):
        checked = c["works"] + c["fails"]
        share = 100 * c["works"] / checked
        print(f"{name[:52]:52} {checked:>7} {c['works']:>6} {share:>4.0f}% {c['only here'] or '':>9}")


def report(kind, proxies, group_name):
    """Check the proxies, given as {proxy: (group, [source, ...])}, and print what works per group and source."""
    print(f"checking {len(proxies)} {'local VPN' if kind == 'vpn' else 'free'} proxies...")
    started = time.monotonic()
    working, outcomes = check_all(list(proxies), kind)
    print(f"\n{len(working)} of {len(proxies)} work ({time.monotonic() - started:.0f} s)")
    for outcome, count in outcomes.most_common():
        print(f"{count:>7}  {outcome}")

    # "only here": working proxies that no other list has, which is what a source really adds
    works = {proxy for _, proxy in working}
    by_group, by_source = defaultdict(Counter), defaultdict(Counter)
    for proxy, (group, listed_in) in proxies.items():
        result = "works" if proxy in works else "fails"
        by_group[group][result] += 1
        for source in listed_in:
            by_source[source][result] += 1
            if result == "works" and len(listed_in) == 1:
                by_source[source]["only here"] += 1
    print_table(group_name, by_group)
    print_table("source", by_source)


def check_vpn():
    links = read_pairs(PROXY_FILE)  # {local proxy: link}
    sources = read_pairs(VPN_SOURCES)  # {link: "source source ..."}
    report("vpn", {proxy: (link.split("://")[0], sources.get(link, "unknown").split())
                   for proxy, link in links.items()}, "protocol")


def check_plain():
    sources = read_pairs(PLAIN_SOURCES)  # {proxy: "source source ..."}
    report("plain", {proxy: (proxy.split("://")[0], sources.get(proxy, "unknown").split())
                     for proxy in read_pairs(PLAIN_PROXY_FILE)}, "type")


# Needed for multiple processes: each worker process imports this file and must not run a check again.
if __name__ == "__main__":
    check_plain() if sys.argv[1:] == ["plain"] else check_vpn()
