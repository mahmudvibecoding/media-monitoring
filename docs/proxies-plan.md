# Proxy plan

Status: plan only; nothing is built yet. Written 2026-10-11.

## Goal

Keep a pool of free proxies that work for YouTube right now, so the collector can send
InnerTube requests from many IP addresses instead of one.

## Decisions

- **Free proxies only, for now.** Start with plain HTTP (including lists labeled HTTPS),
  SOCKS4 and SOCKS5, which curl_cffi uses directly. VPN-type configs (vless, vmess, trojan,
  shadowsocks, hysteria2, wireguard) come later, through sing-box.
- **No database for proxies.** The pool lives in memory. Working proxies are saved to a
  file, so a restart doesn't start from zero.
- **No TLS certificate checks through proxies** (`verify=False`). All the data is public.
- **Requests** use curl_cffi with `impersonate="chrome"`, calling InnerTube `/browse` with an
  `X-Goog-FieldMask` header. The response is about 0.5 KB.

## How the parts fit together

```
sources → collector → checker → pool (in memory) → channel collector
                         ↑           │
                         └─ recheck ─┘

pool → working_proxies.txt   (written every minute, loaded on startup)
```

## 1. Sources

Checked on 2026-10-11, using the last commit that changed each list file (not the last
commit to the repository, which can be just a README change). Every file below had changed
that same day.

| Source | What it has | Entries on 2026-10-11 |
|---|---|---|
| proxifly/free-proxy-list | all types; each line starts with its type, like `socks5://…` | 57,144 |
| hookzof/socks5_list | SOCKS5 | 51,225 |
| ErcinDedeoglu/proxies | large combined lists (HTTP / SOCKS5) | 64,687 / 71,913 |
| TheSpeedX/PROXY-List | one file per type | about 2,400–2,700 each |
| monosans/proxy-list | small lists checked by their author | 117–603 each |
| ProxyScrape API | all types, `type://ip:port`; at most 2,000 per request (about 4,700 in total with `skip=` paging, not used for now) | 2,000 |

```python
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
```

Skip these:
- jetkai/proxy-list and ShiftyTR/Proxy-List: no updates since 2023.
- MuRongPIG/Proxy-Master: no updates since August 2025.
- mmpx12/proxy-list: its `http.txt` contained error text instead of proxies.
- vakhov/fresh-proxy-list: its list files haven't changed since February 2026; only the
  README still gets updated.

Remember which source each proxy came from, so sources that never produce a working
proxy can be dropped later.

## 2. Collector

Every 30 minutes:

1. Download every source.
2. Read each line in any of three formats: `ip:port`, `type://ip:port`, or `ip:port:extra`.
   Take the type from the line if it's there, otherwise from the type listed with the source
   (file names don't always say: hookzof's SOCKS5 list is called `proxy.txt`). In these lists,
   "https" means an HTTP proxy that can reach HTTPS sites, so treat it as `http`.
3. Skip lines that aren't a valid IP address and port (1–65535).
4. Remove duplicates, because the big lists copy each other.
5. Pass new candidates to the checker. Skip proxies that are already in the pool or still
   waiting out a failure.

## 3. Checker

- **Test:** send the real masked InnerTube `/browse` request through the proxy, for a known
  channel such as KunUZ (`UCVPst_iSyaVYpuOP4ogRhlw`).
- **Works:** HTTP 200, and the JSON contains `metadata.channelMetadataRenderer.title`.
- **Speed:** measured on 2026-10-11 on a 52-core server with 1 Gbit, using all ~142,000
  candidates.
  - **One process can't keep up.** At 10,000 checks at a time, a single process used a full
    CPU core and every check timed out (0 working). Split the checks across processes, with
    about 2,000 checks in flight per process. With 48 processes × 2,000, a full check takes
    about 40 seconds and finds as many working proxies as slower settings. At 3,000 per
    process, results became less consistent.
  - **20-second total timeout, with no connect timeout.** A 5-second connect limit halved
    the working proxies, because working free proxies are slow (median 7–9 s). 20 seconds
    found about 1.7 times as many as 10 seconds, and 30 seconds added almost nothing.
- **Open-file limit:** every connection uses an open file. Raise the limit at program start
  with `resource.setrlimit`: Linux allows up to 1,000,000, macOS at most 10,240.
- **Conntrack:** a full check opens about 3,500 new connections per second. Each one stays
  in the kernel's connection tracking table for about 120 seconds, so the table peaked at
  240,000–340,000 entries. A default Ubuntu server with Docker holds 262,144, and when the
  table is full the server drops packets for every app. On any server that runs the
  checker, raise `net.netfilter.nf_conntrack_max`; the test server uses 8,388,608.
- **Abuse reports:** connecting to 142,000 addresses within a minute can look like a port
  scan to the hosting provider. Run the checker on a server that has no other important
  apps.
- **Schedule:** free proxies are very unreliable.
  - Of the proxies that worked, only about a third worked again 10 minutes later, while
    others that had failed started working.
  - Nine back-to-back full checks found 5,071 different working proxies, against about
    1,450 per check.
  - So don't use per-proxy retry timers. Recheck all candidates every few minutes (a full
    check takes about 45 seconds), and keep the proxies that worked in recent checks.
- **Wrong types:** lists often label proxies with the wrong type, and some addresses work
  under several types (e.g. `http://8.215.25.3:2080` and `socks4://8.215.25.3:2080`).
  Test the listed type first. Later, measure whether retrying failed `http` proxies as
  `socks5` finds enough extra proxies to be worth it.

## 4. Pool

What the program keeps in memory for each working proxy:

| Field | Why |
|---|---|
| proxy URL, e.g. `socks5://1.2.3.4:1080` | how curl_cffi connects to it |
| source | to judge sources later |
| latency | to prefer fast proxies |
| next allowed request time | the per-proxy speed limit |
| requests in progress | so one proxy isn't overloaded |
| resting until, blocks in a row | for cooldowns and retirement |
| successes, blocks | to measure how long proxies last |

**Picking a proxy:** choose one that isn't resting and whose speed limit allows a request
now, preferring fast ones.

**Speed limit:** start at 1 request every 10 seconds per IP address. Raise it slowly while
watching how often YouTube blocks. Count per IP, not per proxy URL: one IP often appears
with several ports or types (e.g. 45.74.31.42 and 45.74.31.46 on many ports), and YouTube
sees them all as the same IP.

**Sorting responses:**

| Response | What it means | What to do |
|---|---|---|
| 200 with the fields you asked for | success | record it |
| 200 with "This channel does not exist." | the channel is gone | save that; not the proxy's fault |
| 400 | the field mask is out of date | stop and fix the mask; not the proxy's fault |
| 429, 403, a captcha page, or anything other than the expected JSON | YouTube blocked this proxy | rest it 1 minute, then 5, then 30; retire it after 3 blocks in a row |
| timeout, refused connection, 407, other proxy errors | the proxy is broken | send it back to the checker |
| 500–599 | YouTube's own error | retry later; not the proxy's fault |

**Retries:** if a request fails because of the proxy, retry it on a different proxy, up to
5 tries in total.

**Reuse connections:** keep sending a proxy's requests over the same connection. A new TLS
handshake with YouTube costs about 6.5 KB and adds time.

## 5. Checkpoint file

- Every minute, write the working proxies to `working_proxies.txt`, one URL per line,
  fastest first.
- Write to a temporary file, then swap it in with `os.replace`, so a crash never leaves
  half a file behind.
- On startup, load the file and recheck those proxies first, so the pool is ready in
  seconds.
- Only one process writes the file. Any others only read it.

## 6. Measure from day one

- Candidates per collection, and how many of them are new.
- How many proxies work at any moment.
- How long a working proxy keeps working.
- How many requests a proxy handles before YouTube blocks it.
- How many new candidates and working proxies each source produces. A list that brings
  nothing new for a day has probably stopped updating.

These numbers decide the speed limit and the recheck intervals. They also show whether free
proxies can carry your daily volume.

## Build order

1. **Collector** (done): download and read the sources, and print how many candidates you got.
2. **Checker** (done, tuned on the test server 2026-10-11): test the candidates with several
   processes, print the working ones, and save them to `working_proxies.txt`.
3. **Checkpoint file:** save and load the working proxies.
4. **Pool:** use it in the channel collector, with speed limits, response sorting and retries.
5. **Tune:** run for a day, review the measurements, adjust the numbers, and drop useless sources.
6. **Later:** VPN-type configs through sing-box.
