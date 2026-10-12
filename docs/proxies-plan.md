# Proxy plan

Status: written 2026-10-11 as a plan. The collector, checker, VPN configs and the channel
collector (`channels.py`) are built; the long-running pool is not.

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
  - **Everything in one wave:** 96 processes × 1,500 checks (144,000 in flight) finish a full
    check in about 25 seconds instead of about 36 seconds. Across six paired runs they found
    as many working proxies as 48 × 2,000. The rule: if processes × checks per process covers
    all candidates, there's a single 20-second wave. More processes than CPU cores is fine,
    because the checks used only about 10 cores in total.
  - **No gradual start:** starting checks at 10,000, 20,000 or 50,000 per second instead of
    all at once made no measurable difference. The effect was smaller than the ±40%
    minute-to-minute swing of free proxies.
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
  - Numbers from 9 full checks about a minute apart:
    - Different working proxies after 1, 2, 3, 5 and 9 checks: 1,188, 2,073, 2,502, 3,359
      and 5,071, still growing.
    - A proxy that worked has a 38% chance of working in the next check.
    - Of the 5,071, 1,630 worked only once and 58 worked every time.
    - History predicts reliability. Proxies that worked in at least 4 of the first 6 checks
      worked 63% of the time afterwards, and those that worked in all 6 worked 82%.
    - A pool built from the last 5 checks holds about 3,700 proxies and contains 71% of the
      proxies that work in the next check.
  - Plan: keep each proxy's results from the last 5–10 checks, and use the most reliable and
    fastest ones first.
- **Wrong types:** lists often label proxies with the wrong type, and some addresses work
  under several types (e.g. `http://8.215.25.3:2080` and `socks4://8.215.25.3:2080`).
  Test the listed type first. Later, measure whether retrying failed `http` proxies as
  `socks5` finds enough extra proxies to be worth it.

## 4. Pool

What `channels.py` keeps in memory for each proxy:

| Field | Why |
|---|---|
| proxy URL, e.g. `socks5://1.2.3.4:1080` | how curl_cffi connects to it |
| slots in a shared queue | at most 8 requests in flight through one proxy |
| last 10 answers | to spot a block storm |
| resting until | the pause after a storm |

**Picking a proxy:** a request takes the next free slot from the queue and puts it back when
it ends, so fast proxies come back sooner and carry more of the work. A proxy starts with one
slot, so a dead one holds up a single request; once YouTube answers through it, it gets all 8.

**No speed limit per IP** (decided 2026-10-12), so no exit-IP lookup either. Measured with the
channel request (`/browse` with a field mask) on the 52-core test server:
- **YouTube doesn't block for speed.** Groups of IPs ran for 5 minutes at fixed speeds from 1
  request every 10 s to about 6 successful requests per second per IP: 0–0.1% of answers were
  403/429, never two in a row on one IP. Then with no limit at all, about 40,000 requests per
  second through about 5,900 proxies for a minute (about 7 per second per proxy on average,
  more through the fast ones): 0.00% blocked. YouTube also answers 500 "Internal error" to
  about 0.1% of requests, spread over many proxies; retrying elsewhere fixes it.
- **The limit is our CPU.** One process tops out at about 900 channels per second, so speed
  grows with processes: 32 processes gave 30,000 per second, 48 gave 40,000 (75% of the
  machine's CPU busy, 7 cores of it sing-box). About 60% of a process's CPU goes to
  curl_cffi's Python layer (setting options and parsing every response), the rest to curl
  itself; driving curl directly could roughly double the speed per core if it's ever needed.
- **Traffic:** 2.9 KB per request; at 40,000 per second about 200 Mbit/s down and 100 up.
- **Full run:** all 55,859 channels in about 6 seconds with 48 processes, against 67 seconds
  at 2 requests per second per IP and 7 min 52 s at 1 request per 10 s per IP.
- **Don't use curl's PIPEWAIT** (requests through a proxy waiting to share one connection):
  with many proxies to the same host, nearly every request waited until its timeout.
- **Proxies wear out at full speed.** In one minute, 88% of plain proxies and 17% of VPN
  configs failed at least once and were dropped (a third of those worked again right after).
  That doesn't matter for a run of seconds, but a long-running collector needs the checker to
  keep refilling the pool.

**Sorting responses:**

| Response | What it means | What to do |
|---|---|---|
| 200 with the fields you asked for | success | record it |
| 200 with "This channel does not exist." | the channel is gone | save that; not the proxy's fault |
| 400 | the field mask is out of date | stop and fix the mask; not the proxy's fault |
| 429 or 403 | usually a random block | retry through another proxy; the proxy keeps its speed. Only a storm (8 of a proxy's last 10 answers blocked) pauses that proxy for 30 seconds |
| an answer that isn't YouTube's JSON | the proxy mangled it | treat the proxy as broken |
| timeout (5 s), refused connection, 407, other proxy errors | the proxy is broken | drop it for this run |
| 500–599 | YouTube's own error | retry through another proxy; not the proxy's fault |

**Retries:** a failed request is retried through another proxy right away, up to 5 tries in
total. At the end of a run, a request without an answer after 1 second also goes out through
another proxy, and the first answer wins, so a few slow proxies don't hold up the finish.

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
4. **Pool** (done in `channels.py`, 2026-10-12): proxy slots, response sorting and retries;
   no speed limit per IP.
5. **Tune:** run for a day, review the measurements, adjust the numbers, and drop useless sources.
6. **Later:** VPN-type configs through sing-box.
