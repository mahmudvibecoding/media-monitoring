"""Download the public lists of free VPN configs (vless, vmess, trojan, ss, hysteria2) into data/vpn_configs.txt,
and which lists each config came from into data/vpn_sources.txt. singbox then runs each config as a local
proxy, listed in data/vpn_proxies.txt: the VPN proxies every collector goes through."""
import asyncio
import base64
import binascii
import json
import os
import re
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone
from multiprocessing import get_context
from urllib.parse import parse_qsl, unquote, urlsplit

from curl_cffi import AsyncSession

from media_monitoring.proxies import lists
from media_monitoring.proxies.lists import GITHUB

# Au1rxx's checked configs come in numbered parts, as many as it has configs for that day (10 at most so far, 1 or 2
# some days): a part that isn't there today isn't a failure
PARTS = [GITHUB + f"Au1rxx/free-vpn-subscriptions/main/output/all-verified/v2ray-base64-{n:04d}.txt"
         for n in range(1, 16)]
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
    # disappears; Giromo0 also brings configs no other list has.
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
    # Added 2026-10-14: of 670 lists in GitHub repositories active that week, those adding the most configs that worked
    # and that the lists above didn't have, most first (about 2,100 working, next to 1,900 from the lists above)
    GITHUB + "sakha1370/OpenRay/main/output/all_valid_proxies.txt",
    GITHUB + "liketolivefree/kobabi/main/sub_all.txt",
    *PARTS,
    GITHUB + "10ium/V2ray-Config/main/Splitted-By-Protocol/vless.txt",
    GITHUB + "10ium/V2ray-Config/main/Splitted-By-Protocol/trojan.txt",
    GITHUB + "10ium/V2ray-Config/main/Splitted-By-Protocol/vmess.txt",
    GITHUB + "wuqb2i4f/xray-config-toolkit/main/output/base64/mix-uri",
    GITHUB + "Argh94/Proxy-List/main/All_Config.txt",
    GITHUB + "itsyebekhe/PSG/main/lite/subscriptions/xray/cdn.b64",
    GITHUB + "shabane/kamaji/master/hub/b64/merged.txt",
    GITHUB + "Leon406/SubCrawler/main/sub/share/a11",
    GITHUB + "DukeMehdi/FreeList-V2ray-Configs/main/Configs/All-DukeMehdi-Configs.txt",
    GITHUB + "whoahaow/rjsxrd/main/githubmirror/bypass/bypass-all.txt",
    GITHUB + "Barabama/FreeNodes/HEAD/nodes/merged.txt",
    GITHUB + "0xRadikal/Free-v2ray-Configs/main/all/configs.txt",
    GITHUB + "Firmfox/Proxify/main/v2ray_configs/separated_by_protocol/mixed.txt",
    GITHUB + "Mahdi0024/ProxyCollector/master/sub/proxies.txt",
]

# A link starts with one of these protocols; (?<!\w) stops "ss://" matching inside "vless://".
LINK = re.compile(r"(?<!\w)(?:vless|vmess|trojan|ss|hysteria2|hy2)://[^\s\"'<>`]+", re.IGNORECASE)
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE)
CONTROL = re.compile(r"[\x00-\x1f\x7f]")  # control characters, which only a damaged link has
UNSUPPORTED_TRANSPORTS = {"xhttp", "splithttp", "kcp"}  # sing-box can't run these
SS_METHODS = {  # the Shadowsocks ciphers sing-box supports
    "2022-blake3-aes-128-gcm", "2022-blake3-aes-256-gcm", "2022-blake3-chacha20-poly1305",
    "aes-128-gcm", "aes-192-gcm", "aes-256-gcm", "chacha20-ietf-poly1305", "xchacha20-ietf-poly1305",
    "aes-128-ctr", "aes-192-ctr", "aes-256-ctr", "aes-128-cfb", "aes-192-cfb", "aes-256-cfb",
    "rc4-md5", "chacha20-ietf", "xchacha20", "none",
}
OUTPUT = "data/vpn_configs.txt"
SOURCES_OUTPUT = "data/vpn_sources.txt"  # one line per config: "<link> <source> <source> ..."
PIECE = 1 << 20  # characters of a list parsed as one piece of work: a big list is parsed by several processes at once


def decode_base64(text):
    """Decode base64 (standard or URL-safe alphabet), or return "" if it isn't base64."""
    text = "".join(text.split()).replace("-", "+").replace("_", "/")
    try:
        return base64.b64decode(text + "=" * (-len(text) % 4)).decode("utf-8", "replace")
    except (binascii.Error, ValueError):
        return ""


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
    if CONTROL.search(link):
        return None
    scheme, rest = link.split("://", 1)
    protocol = "hysteria2" if scheme.lower() == "hy2" else scheme.lower()
    rest = rest.split("#", 1)[0]  # drop the name
    if protocol == "vmess":
        return parse_vmess(rest)

    address, _, query = rest.partition("?")  # protocol://user@host:port?param=value&...
    if protocol == "ss" and "@" not in address:  # old style: ss://BASE64(<method>:<password>@<host>:<port>)
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
    """A list's text, or None for a part that isn't published today (see PARTS)."""
    response = await session.get(url, timeout=300)  # the biggest list is about 21 MB
    if response.status_code == 404 and url in PARTS:
        return None
    response.raise_for_status()
    return response.content.decode("utf-8", "replace")


async def download_all():
    """Every list's text (or its error), and when each one last changed, all at once."""
    async with AsyncSession() as session:
        # return_exceptions=True keeps one failed download from stopping the others
        texts = asyncio.gather(*(download(session, url) for url in SOURCES), return_exceptions=True)
        dates = asyncio.gather(*(lists.changed(session, url) for url in SOURCES))
        return await texts, await dates


def readable(text):
    """A downloaded list with its links in plain sight: some lists are one big base64 block, which has no "://"."""
    return text if "://" in text else decode_base64(text)


def pieces(text):
    """The text in pieces of about PIECE characters, cut at line ends: a link never spans lines."""
    start = 0
    while start < len(text):
        end = text.find("\n", start + PIECE)
        end = len(text) if end == -1 else end + 1
        yield text[start:end]
        start = end


def parse_piece(text):
    """In a worker process: the links in a piece of a list, as ([(protocol, key, clean_link), ...], how many links
    were skipped)."""
    found, skipped = [], 0
    for link in LINK.findall(text):
        parsed = parse(link)
        if parsed is None:
            skipped += 1
        else:
            found.append(parsed)
    return found, skipped


def collect():
    """Download all sources, and parse them in pieces spread over processes: on one core it takes about a minute.
    Returns {key: (protocol, clean_link)} for the unique configs, {key: {source, ...}} with every list each config
    appeared in, and the numbers of the report, for the run's row (see runs.py)."""
    texts, dates = asyncio.run(download_all())
    now = datetime.now(timezone.utc)
    work = [(n, piece) for n, text in enumerate(texts) if isinstance(text, str) for piece in pieces(readable(text))]
    found_in, skipped_in = defaultdict(list), Counter()
    # "spawn" starts each process fresh, which works the same on macOS and Linux
    with ProcessPoolExecutor(max(1, min(len(work), os.cpu_count())), mp_context=get_context("spawn")) as pool:
        for (n, _), (found, skipped) in zip(work, pool.map(parse_piece, [piece for _, piece in work])):
            found_in[n] += found
            skipped_in[n] += skipped

    configs, sources, rows, missing = {}, defaultdict(set), [], 0
    for n, (url, text) in enumerate(zip(SOURCES, texts)):
        name = lists.name(url)
        if text is None:
            missing += 1
            continue
        if isinstance(text, Exception):
            rows.append((name, text))
            continue
        found, skipped = found_in[n], skipped_in[n]
        if len(found) + skipped < 3 and "://" in text:  # hardly any links: the list may be base64 after all
            more, more_skipped = parse_piece(decode_base64(text))
            found, skipped = found + more, skipped + more_skipped
        new = 0
        for protocol, key, clean_link in found:
            if key not in configs:
                configs[key] = (protocol, clean_link)
                new += 1
            sources[key].add(name)
        rows.append((name, dates[n], len({key for _, key, _ in found}), new, skipped))

    lists.report(f"VPN configs from {len(rows)} lists (vless, vmess, trojan, ss, hysteria2)", rows, now)
    if missing:
        lists.note(f"({missing} of Au1rxx's {len(PARTS)} possible parts aren't published today)")
    protocols = Counter(protocol for protocol, _ in configs.values()).most_common()
    lists.total(len(configs), "unique configs: " + ", ".join(f"{count:,} {protocol}" for protocol, count in protocols))
    numbers = {"lists": len(rows), "per_list": lists.as_numbers(rows), "unique": len(configs),
               "protocols": dict(protocols), "parts_unpublished": missing}
    return configs, sources, numbers


def main():
    """Download, report and save the configs; returns the report's numbers"""
    configs, sources, numbers = collect()
    os.makedirs("data", exist_ok=True)
    with open(OUTPUT, "w") as f:
        f.write("".join(f"{link}\n" for _, link in sorted(configs.values())))
    with open(SOURCES_OUTPUT, "w") as f:
        f.write("".join(f"{link} {' '.join(sorted(sources[key]))}\n" for key, (_, link) in configs.items()))
    lists.note(f"saved to {OUTPUT} and {SOURCES_OUTPUT}")
    return numbers


if __name__ == "__main__":  # only when run directly, not when imported
    main()