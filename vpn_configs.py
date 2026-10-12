import asyncio
import base64
import binascii
import json
import re
from collections import Counter, defaultdict
from urllib.parse import parse_qsl, unquote, urlsplit

from curl_cffi import AsyncSession

GITHUB = "https://raw.githubusercontent.com/"
SOURCES = [
    GITHUB + "10ium/V2ray-Config/main/All_Configs_Sub.txt",
    GITHUB + "Argh94/V2RayAutoConfig/main/configs/ShadowSocks.txt",
    GITHUB + "Argh94/V2RayAutoConfig/main/configs/Vless.txt",
    GITHUB + "Argh94/V2RayAutoConfig/main/configs/Vmess.txt",
    GITHUB + "Argh94/V2RayAutoConfig/main/configs/Trojan.txt",
    GITHUB + "mheidari98/.proxy/main/all",
    GITHUB + "Leon406/SubCrawler/main/sub/share/vless",
    GITHUB + "ebrasha/free-v2ray-public-list/main/all_extracted_configs.txt",
    GITHUB + "itsyebekhe/PSG/main/subscriptions/xray/cdn",
    GITHUB + "hamedcode/port-based-v2ray-configs/main/sub/vless.txt",
    GITHUB + "hamedcode/port-based-v2ray-configs/main/sub/vmess.txt",
    GITHUB + "hamedcode/port-based-v2ray-configs/main/sub/trojan.txt",
    GITHUB + "miladtahanian/V2RayCFGDumper/main/sub.txt",
    # Added 2026-10-12. These mostly copy the lists above, so they keep those configs if a list
    # disappears; Giromo0 also brings configs no other list has (see docs/proxies-plan.md).
    GITHUB + "xiaoji235/airport-free/main/v2ray.txt",
    GITHUB + "Giromo0/Collector/main/All_Configs_Sub.txt",
    GITHUB + "Epodonios/v2ray-configs/main/All_Configs_Sub.txt",
    GITHUB + "barry-far/V2ray-Config/main/All_Configs_Sub.txt",
    GITHUB + "Surfboardv2ray/Proxy-sorter/main/submerge/converted.txt",
    GITHUB + "nyeinkokoaung404/V2ray-Configs/main/All_Configs_Sub.txt",
    GITHUB + "ALIILAPRO/v2rayNG-Config/main/sub.txt",
    GITHUB + "mahdibland/V2RayAggregator/master/sub/sub_merge.txt",
    GITHUB + "patterniha/Free-Configs/main/configs.txt",
    GITHUB + "roosterkid/openproxylist/main/V2RAY_RAW.txt",
    GITHUB + "MhdiTaheri/V2rayCollector/main/sub/mix",
]

# A link starts with one of these protocols; (?<!\w) stops "ss://" matching inside "vless://".
LINK = re.compile(r"(?<!\w)(?:vless|vmess|trojan|ss|hysteria2|hy2)://[^\s\"'<>`]+", re.IGNORECASE)
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE)
UNSUPPORTED_TRANSPORTS = {"xhttp", "splithttp", "kcp"}  # sing-box can't run these
SS_METHODS = {  # the Shadowsocks ciphers sing-box supports
    "2022-blake3-aes-128-gcm", "2022-blake3-aes-256-gcm", "2022-blake3-chacha20-poly1305",
    "aes-128-gcm", "aes-192-gcm", "aes-256-gcm", "chacha20-ietf-poly1305", "xchacha20-ietf-poly1305",
    "aes-128-ctr", "aes-192-ctr", "aes-256-ctr", "aes-128-cfb", "aes-192-cfb", "aes-256-cfb",
    "rc4-md5", "chacha20-ietf", "xchacha20", "none",
}
OUTPUT = "vpn_configs.txt"
SOURCES_OUTPUT = "vpn_sources.txt"  # one line per config: "<link> <source> <source> ..."


def decode_base64(text):
    """Decode base64 (standard or URL-safe alphabet), or return "" if it isn't base64."""
    text = "".join(text.split()).replace("-", "+").replace("_", "/")
    try:
        return base64.b64decode(text + "=" * (-len(text) % 4)).decode("utf-8", "replace")
    except (binascii.Error, ValueError):
        return ""


def find_links(text):
    """Find all links in a downloaded list. Some lists are one big base64 block."""
    links = LINK.findall(text)
    if len(links) < 3:
        links += LINK.findall(decode_base64(text))
    return links


def split_address(text):
    """Split "user@host:port" into (user, host, port), or return None if it isn't valid."""
    try:
        parts = urlsplit("x://" + text)
        host, port = parts.hostname, parts.port  # .port raises ValueError if it isn't a number
    except ValueError:
        return None
    if not host or not port:
        return None
    user = unquote(parts.netloc.rpartition("@")[0])
    return user, host, port


def ss_credentials(user):
    """Shadowsocks credentials are "method:password", written plainly or in base64."""
    for text in (user, decode_base64(user)):
        method, _, password = text.partition(":")
        if method.lower() in SS_METHODS and password:
            return f"{method.lower()}:{password}"
    return None


def parse_vmess(payload):
    """vmess://BASE64(JSON) with the server in "add" and "port", and the user's UUID in "id"."""
    try:
        config = json.loads(decode_base64(payload))
        port = int(config["port"])
    except (ValueError, TypeError, KeyError):  # not JSON, not an object, or no valid port
        return None
    if not UUID.fullmatch(str(config.get("id"))) or not config.get("add") or not 1 <= port <= 65535:
        return None
    if str(config.get("net") or "tcp").lower() in UNSUPPORTED_TRANSPORTS:
        return None
    config.pop("ps", None)  # the name
    return "vmess", "vmess://" + json.dumps(config, sort_keys=True), "vmess://" + payload


def parse(link):
    """Return (protocol, key, clean_link), or None if the link is broken or sing-box can't run it.

    The key identifies a config: the same server and settings give the same key, whatever
    its #name, because the aggregators rename configs they copy from each other.
    """
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in link):  # control characters: a damaged link
        return None
    scheme, rest = link.split("://", 1)
    protocol = "hysteria2" if scheme.lower() == "hy2" else scheme.lower()
    rest = rest.split("#", 1)[0]  # drop the name
    if protocol == "vmess":
        return parse_vmess(rest)

    address, _, query = rest.partition("?")  # protocol://user@host:port?param=value&...
    if protocol == "ss" and "@" not in address:  # old style: ss://BASE64(method:password@host:port)
        address = decode_base64(address)
    parsed = split_address(address.rstrip("/"))
    if parsed is None:
        return None
    user, host, port = parsed
    if protocol == "ss":
        user = ss_credentials(user)
        if user is None:
            return None
    elif protocol == "vless" and not UUID.fullmatch(user):  # vless users are UUIDs
        return None
    elif protocol == "trojan" and not user:  # trojan needs a password
        return None
    params = dict(parse_qsl(query))
    if params.get("type", "tcp").lower() in UNSUPPORTED_TRANSPORTS:
        return None
    key = f"{protocol}://{user}@{host}:{port}?" + "&".join(f"{k}={v}" for k, v in sorted(params.items()))
    return protocol, key, f"{protocol}://{rest}"


async def download(session, url):
    response = await session.get(url, timeout=300)  # the biggest list is about 11 MB
    response.raise_for_status()
    return response.content.decode("utf-8", "replace")


async def collect():
    """Download all sources. Returns {key: (protocol, clean_link)} for the unique configs, and
    {key: {source, ...}} with every list each config appeared in."""
    async with AsyncSession() as session:
        results = await asyncio.gather(*(download(session, url) for url in SOURCES), return_exceptions=True)

    configs, sources = {}, defaultdict(set)
    for url, result in zip(SOURCES, results):
        name = url.removeprefix(GITHUB)
        if isinstance(result, Exception):
            print(f"FAILED   {name}: {result}")
            continue
        valid = new = skipped = 0
        for link in find_links(result):
            parsed = parse(link)
            if parsed is None:
                skipped += 1
                continue
            protocol, key, clean_link = parsed
            valid += 1
            if key not in configs:
                configs[key] = (protocol, clean_link)
                new += 1
            sources[key].add(name)
        print(f"{valid:>6} valid, {new:>6} new, {skipped:>6} skipped  {name}")

    print(f"\n{len(configs):>7}  unique configs in total")
    for protocol, count in Counter(p for p, _ in configs.values()).most_common():
        print(f"{count:>7}  {protocol}")
    return configs, sources


def main():
    configs, sources = asyncio.run(collect())
    with open(OUTPUT, "w") as f:
        f.write("".join(f"{link}\n" for _, link in sorted(configs.values())))
    with open(SOURCES_OUTPUT, "w") as f:
        f.write("".join(f"{link} {' '.join(sorted(sources[key]))}\n" for key, (_, link) in configs.items()))
    print(f"\nsaved to {OUTPUT} and {SOURCES_OUTPUT}")


if __name__ == "__main__":  # only when run directly, not when imported
    main()