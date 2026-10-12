"""Download public lists of free HTTP and SOCKS proxies into plain_proxies.txt, one proxy per line. They give video
pages and comments (YouTube's next endpoint, which blocks an address after heavy use) many more addresses than the
VPN configs. Most of them don't work; the pool finds the ones that do by itself (see pool.py).
"""
import asyncio
import ipaddress

from curl_cffi import AsyncSession

# (url, type): type is None when each line already starts with its type, like "http://...". Chosen by how many of
# their proxies answered a real comments request (2026-10-12): SOCKS5 lists are left out, since none of their
# proxies did, and small checked lists beat the big scraped ones.
G = "https://raw.githubusercontent.com/"
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
]
OUTPUT = "plain_proxies.txt"


def parse_line(line, default_type):
    """One line from a list as a proxy URL like "socks4://1.2.3.4:1080", or None."""
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
    if proxy_type == "https":  # in these lists, "https" means an HTTP proxy that can reach HTTPS sites
        proxy_type = "http"
    if proxy_type not in ("http", "socks4") or not 1 <= port <= 65535:  # free SOCKS5 proxies don't work
        return None
    return f"{proxy_type}://{ip}:{port}"


async def download(session, url):
    response = await session.get(url, timeout=30)
    response.raise_for_status()
    return response.text


async def main():
    async with AsyncSession() as session:
        # All sources at once; return_exceptions=True keeps one failed download from stopping the others
        results = await asyncio.gather(*(download(session, url) for url, _ in SOURCES), return_exceptions=True)
    proxies = set()
    for (url, default_type), result in zip(SOURCES, results):
        if isinstance(result, Exception):
            print(f"FAILED   {url}: {result}")
            continue
        found = {proxy for line in result.splitlines() if (proxy := parse_line(line, default_type))}
        print(f"{len(found):>7}  {url}")
        proxies |= found
    with open(OUTPUT, "w") as f:
        f.writelines(proxy + "\n" for proxy in proxies)
    print(f"{len(proxies):>7}  saved to {OUTPUT}")


if __name__ == "__main__":
    asyncio.run(main())
