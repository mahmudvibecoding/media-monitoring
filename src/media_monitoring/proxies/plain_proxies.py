"""Download public lists of plain HTTP, SOCKS4 and SOCKS5 proxies into data/plain_proxies.txt, one proxy per line, and
which lists each came from into data/plain_sources.txt. Each collector process keeps its share of them in reserve
and brings them in once its VPN proxies stop working, or once it has tested all of those and has room for more tests:
they give video pages and comments (YouTube's next endpoint, which blocks an address after heavy use) many more
addresses. Most of them don't work; the pool finds the ones that do by itself (see pool.py), and "uv run proxies
check plain" reports which lists work best.
"""
import asyncio
import ipaddress
import os
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone
from multiprocessing import get_context

from curl_cffi import requests

from media_monitoring import runs
from media_monitoring.proxies import lists

# (url, type): type is None when each line already starts with its type, like "http://...". Chosen by how many of
# their proxies answered a real comments request (2026-10-12): small checked lists beat the big scraped ones. The
# two SOCKS5 lists came 2026-10-14, when their proxies answered channel pages more than all the lists above together.
G = lists.GITHUB
SOURCES = [
    (G + "proxifly/free-proxy-list/main/proxies/all/data.txt", None),
    ("https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport"
     "&format=text", None),
    (G + "TheSpeedX/PROXY-List/master/http.txt", "http"),
    (G + "TheSpeedX/PROXY-List/master/socks4.txt", "socks4"),
    (G + "monosans/proxy-list/main/proxies/http.txt", "http"),
    (G + "monosans/proxy-list/main/proxies/socks4.txt", "socks4"),
    (G + "ErcinDedeoglu/proxies/main/proxies/http.txt", "http"),
    (G + "SoliSpirit/proxy-list/HEAD/http.txt", "http"),
    (G + "SoliSpirit/proxy-list/HEAD/https.txt", "http"),
    (G + "SoliSpirit/proxy-list/HEAD/socks4.txt", "socks4"),
    (G + "Firmfox/Proxify/HEAD/proxy/http.txt", "http"),
    (G + "Firmfox/Proxify/HEAD/proxy/https.txt", "http"),
    (G + "Firmfox/Proxify/HEAD/proxy/socks4.txt", "socks4"),
    (G + "Mohammedcha/ProxRipper/HEAD/full_proxies/http.txt", "http"),
    (G + "Mohammedcha/ProxRipper/HEAD/full_proxies/https.txt", "http"),
    (G + "Mohammedcha/ProxRipper/HEAD/full_proxies/socks4.txt", "socks4"),
    (G + "ProxyScraper/ProxyScraper/HEAD/socks4.txt", "socks4"),
    (G + "vmheaven/VMHeaven.io-Free-Proxy-List/HEAD/allproxy.txt", None),
    (G + "hproxy-com/free-proxy-list/HEAD/http.txt", "http"),
    (G + "hproxy-com/free-proxy-list/HEAD/https.txt", "http"),
    (G + "databay-labs/free-proxy-list/HEAD/http.txt", "http"),
    (G + "databay-labs/free-proxy-list/HEAD/socks4.txt", "socks4"),
    (G + "iplocate/free-proxy-list/HEAD/all-proxies.txt", None),
    (G + "dpangestuw/Free-Proxy/HEAD/All_proxies.txt", None),
    (G + "Bes-js/public-proxy-list/HEAD/proxies.txt", None),
    (G + "xyzs996/free-proxy-health-list/HEAD/http.txt", "http"),
    (G + "hproxy-com/free-proxy-list/HEAD/socks5.txt", "socks5"),
    (G + "SoliSpirit/proxy-list/HEAD/socks5.txt", "socks5"),
]
OUTPUT = "data/plain_proxies.txt"
SOURCES_OUTPUT = "data/plain_sources.txt"  # one line per proxy: "<proxy> <source> <source> ..."


def parse_line(line, default_type):
    """One line from a list as a proxy URL like "socks5://1.2.3.4:1080", or None."""
    line = line.strip()
    proxy_type = default_type
    if "://" in line:
        proxy_type, line = line.split("://", 1)
    parts = line.split(":")  # "ip:port" or "ip:port:extra"
    if proxy_type is None or len(parts) < 2:
        return None
    try:
        ip, port = ipaddress.IPv4Address(parts[0]), int(parts[1])
    except ValueError:
        return None
    proxy_type = proxy_type.lower()
    # In these lists, "https" means an HTTP proxy that can reach HTTPS sites
    proxy_type = {"https": "http", "socks5h": "socks5"}.get(proxy_type, proxy_type)
    if proxy_type not in ("http", "socks4", "socks5") or not 1 <= port <= 65535:
        return None
    return f"{proxy_type}://{ip}:{port}"


def fetch(source):
    """In a worker process: download one list and parse it. Returns (its proxies as a set, how many of its lines
    weren't proxies), or the error as text if the download failed."""
    url, default_type = source
    try:
        response = requests.get(url, timeout=30)
        response.raise_for_status()
    except Exception as error:
        return str(error) or type(error).__name__
    proxies, skipped = set(), 0
    for line in response.text.splitlines():
        if proxy := parse_line(line, default_type):
            proxies.add(proxy)
        elif line.strip():
            skipped += 1
    return proxies, skipped


def collect():
    """Download and parse every list, each in a process of its own, while this one asks when each last changed.
    Returns what fetch() returned for each list, and those times."""
    # "spawn" starts each process fresh, which works the same on macOS and Linux
    with ProcessPoolExecutor(min(len(SOURCES), os.cpu_count()), mp_context=get_context("spawn")) as pool:
        results = pool.map(fetch, SOURCES)  # all sent to the processes at once
        dates = asyncio.run(lists.all_changed([url for url, _ in SOURCES]))
        return list(results), dates


def save(results, dates):
    """Report each list from collect(), and save the proxies of them all. Returns the report's numbers."""
    now = datetime.now(timezone.utc)
    sources, rows = defaultdict(set), []  # {proxy: {list it was in, ...}}, and the report's lines
    for (url, _), found, when in zip(SOURCES, results, dates):
        name = lists.name(url)
        if isinstance(found, str):
            rows.append((name, found))
            continue
        proxies, skipped = found
        new = sum(1 for proxy in proxies if proxy not in sources)
        for proxy in proxies:
            sources[proxy].add(name)
        rows.append((name, when, len(proxies), new, skipped))
    lists.report(f"Plain proxies from {len(rows)} lists (HTTP, SOCKS4, SOCKS5)", rows, now)
    kinds = Counter(proxy.split("://", 1)[0] for proxy in sources).most_common()
    lists.total(len(sources), "unique proxies: " + ", ".join(f"{count:,} {kind}" for kind, count in kinds))
    os.makedirs("data", exist_ok=True)
    with open(SOURCES_OUTPUT, "w") as f:
        f.writelines(f"{proxy} {' '.join(sorted(names))}\n" for proxy, names in sources.items())
    with open(OUTPUT + ".tmp", "w") as f:
        f.writelines(proxy + "\n" for proxy in sources)
    os.replace(OUTPUT + ".tmp", OUTPUT)  # all at once: a collector reading it never sees half a list
    lists.note(f"saved to {OUTPUT} and {SOURCES_OUTPUT}")
    return {"lists": len(rows), "per_list": lists.as_numbers(rows), "unique": len(sources), "kinds": dict(kinds)}


def main():
    runs.add(plain=save(*collect()))  # to the row of "uv run proxies", which runs this in a process of its own


if __name__ == "__main__":  # only when run directly, not when imported
    main()
