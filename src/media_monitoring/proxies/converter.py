"""Convert share links (vless, vmess, trojan, ss, hysteria2) into sing-box outbounds."""
import json
import re
import subprocess
from collections import Counter
from urllib.parse import parse_qsl

from media_monitoring.proxies.vpn_configs import decode_base64, split_address, ss_credentials

INPUT = "data/vpn_configs.txt"
OUTPUT = "data/outbounds.json"
HOSTNAME = re.compile(r"[A-Za-z0-9._-]+")
REALITY_KEY = re.compile(r"[A-Za-z0-9_-]{43}")  # 32 bytes in unpadded URL-safe base64
SHORT_ID = re.compile(r"(?:[0-9a-fA-F]{2}){0,8}")  # 0 to 8 bytes in hex
BROKEN_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")  # a "%" not followed by two hex digits
FINGERPRINTS = {"chrome", "firefox", "edge", "safari", "360", "qq", "ios", "android", "random", "randomized"}
VMESS_CIPHERS = {"auto", "none", "zero", "aes-128-gcm", "chacha20-poly1305", "aes-128-ctr"}
SS_PLUGINS = {"obfs-local": "obfs-local", "simple-obfs": "obfs-local", "v2ray-plugin": "v2ray-plugin"}


class Unusable(ValueError):
    """sing-box can't use this link; the message says why."""


def split_link(link):
    """Split "protocol://user@host:port?a=1&b=2#name" into (user, host, port, {params})."""
    rest = link.split("://", 1)[1].split("#", 1)[0]
    address, _, query = rest.partition("?")
    parsed = split_address(address.rstrip("/"))
    if parsed is None:
        raise Unusable("bad address")
    user, host, port = parsed
    return user, host, port, dict(parse_qsl(query))


def alpn_list(value):
    return [a.strip() for a in str(value or "").split(",") if a.strip()]


def tls_options(security, server_name, fingerprint, alpn, public_key="", short_id=""):
    """The "tls" block, or None for security=none. No certificate checks: all the data is public."""
    security = (security or "none").lower()
    if security not in ("tls", "reality"):
        return None
    tls = {"enabled": True}
    if server_name:
        if not HOSTNAME.fullmatch(server_name):
            raise Unusable("bad server name")
        tls["server_name"] = server_name
    if alpn:
        tls["alpn"] = alpn
    tls["utls"] = {"enabled": True, "fingerprint": fingerprint if fingerprint in FINGERPRINTS else "chrome"}
    if security == "reality":
        public_key, short_id = (public_key or "").rstrip("="), short_id or ""
        if not REALITY_KEY.fullmatch(public_key):
            raise Unusable("bad reality key")
        if not SHORT_ID.fullmatch(short_id):
            raise Unusable("bad reality short id")
        tls["reality"] = {"enabled": True, "public_key": public_key, "short_id": short_id}
    else:
        tls["insecure"] = True
    return tls


def transport_options(kind, host, path, service_name, header_type):
    """The "transport" block, or None for plain TCP."""
    kind = (kind or "tcp").lower()
    if path and BROKEN_ESCAPE.search(path):
        raise Unusable("bad path")  # e.g. "%2": the link was cut off
    if kind in ("tcp", "raw", "none"):
        if (header_type or "none").lower() == "http":
            raise Unusable("tcp with http header")  # sing-box can't fake HTTP headers on TCP
        return None
    if kind == "ws":
        path, _, query = (path or "/").partition("?")
        transport = {"type": "ws", "path": path or "/"}
        early_data = dict(parse_qsl(query)).get("ed", "")
        if early_data.isdigit():  # "/path?ed=2048": send the first data in a WebSocket header
            transport["max_early_data"] = int(early_data)
            transport["early_data_header_name"] = "Sec-WebSocket-Protocol"
        if host:
            transport["headers"] = {"Host": host}
        return transport
    if kind == "grpc":
        return {"type": "grpc", "service_name": service_name or ""}
    if kind == "httpupgrade":
        transport = {"type": "httpupgrade", "path": path or "/"}
        if host:
            transport["host"] = host
        return transport
    if kind in ("http", "h2"):
        transport = {"type": "http", "path": path or "/"}
        if host:
            transport["host"] = alpn_list(host)
        return transport
    if kind == "quic":
        return {"type": "quic"}
    raise Unusable("unsupported transport")


def add_tls_and_transport(outbound, tls, transport):
    if tls:
        if transport and transport["type"] in ("ws", "httpupgrade"):
            tls.pop("alpn", None)  # WebSocket needs HTTP/1.1; an "h2" ALPN would break it
        outbound["tls"] = tls
    if transport:
        outbound["transport"] = transport
    return outbound


def vless(link):
    user, host, port, q = split_link(link)
    outbound = {"type": "vless", "server": host, "server_port": port, "uuid": user}
    tls = tls_options(q.get("security"), q.get("sni") or q.get("host"), q.get("fp"), alpn_list(q.get("alpn")),
                      q.get("pbk"), q.get("sid"))
    transport = transport_options(q.get("type"), q.get("host"), q.get("path"), q.get("serviceName"),
                                  q.get("headerType"))
    if q.get("flow", "").startswith("xtls-rprx-vision") and tls and not transport:
        outbound["flow"] = "xtls-rprx-vision"  # vision only works on plain TCP with TLS
    return add_tls_and_transport(outbound, tls, transport)


def vmess(link):
    config = json.loads(decode_base64(link.split("://", 1)[1].split("#", 1)[0]))
    net = str(config.get("net") or "tcp").lower()
    host = str(config.get("host") or "")
    cipher = str(config.get("scy") or "auto").lower()
    outbound = {
        "type": "vmess", "server": str(config["add"]), "server_port": int(config["port"]),
        "uuid": config["id"], "security": cipher if cipher in VMESS_CIPHERS else "auto",
        "alter_id": int(config.get("aid") or 0),
    }
    security = "tls" if str(config.get("tls")).lower() == "tls" else "none"
    tls = tls_options(security, config.get("sni") or host, config.get("fp"), alpn_list(config.get("alpn")))
    # v2rayN puts the gRPC service name in "path" and the TCP header type in "type"
    transport = transport_options(net, host, config.get("path"), config.get("path"), config.get("type"))
    return add_tls_and_transport(outbound, tls, transport)


def trojan(link):
    user, host, port, q = split_link(link)
    outbound = {"type": "trojan", "server": host, "server_port": port, "password": user}
    tls = tls_options(q.get("security", "tls"), q.get("sni") or q.get("peer") or q.get("host"), q.get("fp"),
                      alpn_list(q.get("alpn")), q.get("pbk"), q.get("sid"))
    transport = transport_options(q.get("type"), q.get("host"), q.get("path"), q.get("serviceName"),
                                  q.get("headerType"))
    return add_tls_and_transport(outbound, tls, transport)


def shadowsocks(link):
    rest = link.split("://", 1)[1].split("#", 1)[0]
    address, _, query = rest.partition("?")
    if "@" not in address:  # old style: ss://BASE64(<method>:<password>@<host>:<port>)
        address = decode_base64(address)
    user, host, port = split_address(address.rstrip("/"))
    method, _, password = ss_credentials(user).partition(":")
    outbound = {"type": "shadowsocks", "server": host, "server_port": port, "method": method, "password": password}
    plugin = dict(parse_qsl(query)).get("plugin")
    if plugin:
        name, _, options = plugin.partition(";")
        if name not in SS_PLUGINS:
            raise Unusable("unsupported ss plugin")
        outbound["plugin"] = SS_PLUGINS[name]
        # sing-box wants a number for v2ray-plugin's "mux"; links also say "mux=true" or "mux=undefined"
        options = options.replace("mux=true", "mux=1").replace("mux=false", "mux=0")
        outbound["plugin_opts"] = ";".join(
            part for part in options.split(";") if part and not (part.startswith("mux=") and not part[4:].isdigit())
        )
    return outbound


def hysteria2(link):
    user, host, port, q = split_link(link)
    outbound = {"type": "hysteria2", "server": host, "server_port": port, "password": user}
    obfs = q.get("obfs", "")
    if obfs == "salamander":
        outbound["obfs"] = {"type": "salamander", "password": q.get("obfs-password", "")}
    elif obfs:
        raise Unusable("unsupported hysteria2 obfs")
    server_name = q.get("sni") or host
    if not HOSTNAME.fullmatch(server_name):
        raise Unusable("bad server name")
    outbound["tls"] = {"enabled": True, "server_name": server_name, "insecure": True, "alpn": ["h3"]}
    return outbound


CONVERTERS = {"vless": vless, "vmess": vmess, "trojan": trojan, "ss": shadowsocks, "hysteria2": hysteria2}


def to_outbound(link, tag):
    """Return the sing-box outbound for a share link. Raises Unusable if sing-box can't use it."""
    protocol = link.split("://", 1)[0].lower()
    if protocol not in CONVERTERS:
        raise Unusable("unsupported protocol")
    try:
        outbound = CONVERTERS[protocol](link)
    except Unusable:
        raise
    except (ValueError, KeyError, TypeError, AttributeError) as error:  # a missing or malformed field
        raise Unusable("malformed link") from error
    outbound["tag"] = tag
    return outbound


def main():
    with open(INPUT) as f:
        links = [line.strip() for line in f if line.strip()]
    outbounds, skipped = [], Counter()
    for link in links:
        try:
            outbounds.append(to_outbound(link, f"out-{len(outbounds)}"))
        except Unusable as error:
            skipped[str(error)] += 1

    print(f"{len(outbounds)} of {len(links)} links converted")
    for kind, count in Counter(o["type"] for o in outbounds).most_common():
        print(f"{count:>7}  {kind}")
    print("skipped:")
    for reason, count in skipped.most_common():
        print(f"{count:>7}  {reason}")

    with open(OUTPUT, "w") as f:
        json.dump({"outbounds": outbounds}, f, indent=1)
    try:
        result = subprocess.run(["sing-box", "check", "-c", OUTPUT], capture_output=True, text=True)
    except FileNotFoundError:
        print(f"\nsaved to {OUTPUT}; sing-box isn't installed, so it wasn't checked")
        return
    print(f"\nsing-box check of {OUTPUT}:", "OK" if result.returncode == 0 else result.stderr.strip()[:1000])


if __name__ == "__main__":
    main()