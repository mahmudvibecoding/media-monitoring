# Proxy plan

Status: written 2026-10-11 as a plan. The plain-proxy collector and checker, the VPN configs
and the channel collector (`channels.py`) are built; the long-running pool is not. Since
2026-10-12 the collector uses only VPN configs.

## Goal

Keep a pool of free proxies that work for YouTube right now, so the collector can send
InnerTube requests from many IP addresses instead of one.

## Decisions

- **VPN configs only** (since 2026-10-12). The collector sends its requests through VPN
  configs (vless, vmess, trojan, shadowsocks, hysteria2) that sing-box turns into local
  SOCKS5 proxies. Free plain proxies (HTTP, SOCKS4, SOCKS5) did only 4–7% of the
  collector's work, and most of them failed their first real request (see "Plain proxies
  vs VPN configs" under Pool). `proxies.py` stays: `check_vpn.py` uses its checker, and plain
  proxies come back by adding `working_proxies.txt` to `PROXY_FILES` in `channels.py`.
- **5-second check timeout** (since 2026-10-12, was 20 seconds): the same as a request in
  the collector, so checks finish 2.6 times faster with no loss of collecting speed.
- **No database for proxies.** The pool lives in memory. Working proxies are saved to a
  file, so a restart doesn't start from zero.
- **No TLS certificate checks through proxies** (`verify=False`). All the data is public.
- **Requests** use curl_cffi with `impersonate="chrome"`, calling InnerTube `/browse` with an
  `X-Goog-FieldMask` header. The response is about 0.5 KB.

## How the parts fit together

```
vpn_configs.py → singbox_runner.py → check_vpn.py → working_vpn_proxies.txt → channels.py
(24 public lists)  (a local SOCKS5     (the checker    (fastest first)
                   proxy per config)   from proxies.py)
```

Run order: `uv run vpn_configs.py`, then `uv run singbox_runner.py` (leave it running), then
in a second terminal `uv run check_vpn.py` and `uv run channels.py`.

The plain-proxy path still works if it's ever needed: `proxies.py` downloads the lists in
section 1, checks them and writes `working_proxies.txt`.

## VPN config sources

`vpn_configs.py` downloads 24 public lists from 19 GitHub repositories. They were reviewed on
2026-10-12 with the GitHub API and a full check of every config; "only here" counts working
configs that no other list has, which is what we'd lose if that list disappeared.

| List | Repository since | How it updates | Working | Only here |
|---|---|---|---|---|
| mheidari98/.proxy `all` | 2022 | hourly bot; wipes its git history weekly | 1,421 | 18 |
| 10ium/V2ray-Config `All_Configs_Sub.txt` | Jan 2025 | daily bot; 15 GB repository | 1,402 | **481** |
| Argh94/V2RayAutoConfig (Vless, Trojan, ShadowSocks, Vmess) | Jul 2025 | bot every 45 min, copying about 30 other lists; 14 GB | 950, 422, 164, 99 | 47, 47, 2, 10 |
| ebrasha/free-v2ray-public-list `all_extracted_configs.txt` | Jun 2025 | pushed from outside GitHub as one squashed commit | 886 | 62 |
| hamedcode/port-based-v2ray-configs (vless, trojan, vmess) | Jun 2025 | bot every 4 h; tests configs before publishing | 816, 223, 60 | **184, 79**, 9 |
| Giromo0/Collector `All_Configs_Sub.txt` (added) | Sep 2025 | constant bot; 8 GB | 739 | **120** |
| xiaoji235/airport-free `v2ray.txt` (added) | Oct 2024 | about daily | 688 | 0 |
| Epodonios/v2ray-configs `All_Configs_Sub.txt` (added) | Feb 2024 | constant bot; 25 GB | 589 | 0 |
| barry-far/V2ray-Config `All_Configs_Sub.txt` (added) | Jun 2025 | the same file as Epodonios: a mirror | 589 | 0 |
| Surfboardv2ray/Proxy-sorter `converted.txt` (added) | Apr 2024 | constant bot | 330 | 0 |
| Leon406/SubCrawler `vless` | 2021 (list since 2023) | bot 4–5 times a day | 289 | **121** |
| nyeinkokoaung404/V2ray-Configs `All_Configs_Sub.txt` (added) | Oct 2024 | constant bot | 224 | 0 |
| mahdibland/V2RayAggregator `sub_merge.txt` (added) | Sep 2022 | about twice a day | 125 | 0 |
| ALIILAPRO/v2rayNG-Config `sub.txt` (added) | Nov 2023 | constant bot | 113 | 2 |
| miladtahanian/V2RayCFGDumper `sub.txt` | 2024 (list since Feb 2026) | hourly, from Telegram channels | 86 | 4 |
| patterniha/Free-Configs `configs.txt` (added) | Aug 2026 | about daily; miladtahanian's source | 60 | 0 |
| roosterkid/openproxylist `V2RAY_RAW.txt` (added) | Apr 2021 | constant bot | 57 | 0 |
| itsyebekhe/PSG `cdn` | Jul 2025 | every 6 h, from Telegram channels | 56 | 56 |
| MhdiTaheri/V2rayCollector `sub/mix` (added) | Nov 2023 | constant bot | 42 | 1 |

Of 69,654 configs, 3,516 worked in that check (5-second timeout, 9 seconds for all).

**How reliable they are:**
- **No single list is safe for years.** Collectors that were well known in 2023 are gone
  (soroushmirzaei/telegram-configs-collector, yebekhe/TelegramV2rayCollector,
  iPsycho1/multi-proxy-config-fetcher), others moved (aiboboxx/v2rayfree became
  free-nodes/v2rayfree), and several of our lists are only about a year old. The ecosystem
  as a whole has kept going since about 2021, so the plan is to make lists replaceable.
- **They copy each other.** Argh94 reads about 30 other lists, mheidari98 crawls other lists,
  and most configs first appear in public Telegram channels, which miladtahanian and PSG
  scrape. A change at Telegram, or at the CDN in front of many servers (two thirds of working
  configs exit from a different address than they connect to), could hit many lists at once.
- **Huge repositories:** 10ium (15 GB), Argh94 (14 GB), Epodonios (25 GB) and barry-far
  (10 GB) are far above GitHub's recommended size, so GitHub could step in.

**The 11 lists added on 2026-10-12** brought only about 1,500 new configs (our lists already
copy them), but they back up the old ones: working configs that only one list carries fell
from 48% of the pool to 35%, and losing mheidari98 would now cost 18 working configs
instead of about 350. Six lists still carry configs nobody else has: 10ium, hamedcode,
Leon406, Giromo0, ebrasha and itsyebekhe (together about 1,100 of 3,516).

**Candidates checked and skipped** (2026-10-12):
- No useful working configs: LonUp/NodeList, mostafasadeghifar/v2ray-config (0 of 605),
  ZywChannel/free, Pawdroid/Free-servers (1 of 8 despite 19,000 stars),
  AlienVPN402 (1 of 906), w1770946466/Auto_proxy, ts-sf/fly, SonzaiEkkusu/V2RayDumper,
  xsparvin/Submahsanetxsparvin (10 of 827).
- Stale or irregular: LalatinaHub/Mineral (no updates in 30 days), ermaozi/get_subscribe,
  WilliamStar007/ClashX-V2Ray-TopFreeProxy.
- Copies of lists we already take: 10ium/V2Hub3, giromo/Collector2, MhdiTaheri/V2rayCollector_Py.
- Small, every config already elsewhere: 4n0nymou3/multi-proxy-config-fetcher,
  peasoft/NoMoreWalls, HakurouKen/free-node.
- Broken links: free-nodes/v2rayfree (moved), MahsaNetConfigTopic/config (gone),
  mahsanet/MahsaFreeConfig (unreadable).

**Still to do, to depend on these lists for years:**
- Save the per-source counts from every check and warn when a list stops changing for 2 days
  or brings nothing unique for a week.
- Keep an archive of every config ever seen, with when it was first seen and last worked, so
  the pool survives lists disappearing, and so we learn how long configs last.
- If the GitHub lists die, read the public Telegram channels directly.
- Test a paid fallback once (datacenter proxies or an IPv6 range): the planned monitoring
  needs about 6 million requests a day.

## 1. Sources

These are the plain-proxy lists. They're not used for collecting since 2026-10-12, but
`proxies.py` still has them.

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
    all candidates, there's a single wave that lasts about as long as the timeout. More
    processes than CPU cores is fine, because the checks used only about 10 cores in total.
  - **No gradual start:** starting checks at 10,000, 20,000 or 50,000 per second instead of
    all at once made no measurable difference. The effect was smaller than the ±40%
    minute-to-minute swing of free proxies.
  - **5-second total timeout, with no separate connect timeout** (since 2026-10-12).
    Longer timeouts find more proxies: on 2026-10-11, 20 seconds found about 1.7 times as
    many as 10 seconds, and 30 seconds added almost nothing. But those slow proxies barely
    work in the collector, which also gives each request 5 seconds. Four runs on 2026-10-12,
    alternating 20 s and 5 s checks, each followed by 30 seconds of collecting at full speed:

    | Check timeout | Check time (plain + VPN) | Working proxies | Collector speed |
    |---|---|---|---|
    | 20 s | 47–48 s | 5,326–6,933 | 40,069–41,346 channels/s |
    | 5 s | 18–19 s | 3,342–3,892 | 41,086–41,690 channels/s |

    With the 20-second check, proxies whose check took 10–20 seconds did only 2% of the
    collector's successful requests, and 85% of them did none. The 5-second pool also
    started faster: about 8,850 channels in the first second instead of 4,000–7,700. The
    measured check times include the checker's own load (thousands of handshakes at once):
    no proxy measured under 2 seconds, although VPN configs answer in about 0.3 seconds
    once connected.
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
    check takes about 10 seconds with the 5-second timeout), and keep the proxies that
    worked in recent checks.
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

**Plain proxies vs VPN configs** (measured 2026-10-12, which is why the collector now uses
only VPN configs):
- In four 30-second runs at full speed with both kinds, plain proxies did only 4–7% of the
  successful requests and VPN configs 93–96%. Of the plain proxies that passed the check,
  82–87% did no work at all: they failed their first real request.
- Full runs of all 55,859 channels, each after a fresh 5-second check, alternating:

  | | Plain + VPN | VPN only |
  |---|---|---|
  | Run time | 6.5 s, 6.3 s | 6.1 s, 6.4 s |
  | Channels filled after 4 seconds | 53,847, 49,445 | 55,332, 54,757 |
  | Broken requests | 77, 73 | 42, 24 |

- VPN only for 30 seconds at full speed: 40,405 channels per second, 0 blocks, 0.1% broken
  requests, and 85% of the configs still usable at the end (about two thirds with both
  kinds).
- What it costs: fewer distinct addresses (an earlier count found about 1,160 VPN exit IPs,
  against about 1,820 with plain proxies included), which didn't matter because VPN
  addresses already carried about 95% of the load. And all proxies now come from the public
  VPN lists (see "VPN config sources"), so plain proxies are the fallback if those dry up.
- What it saves: no more testing 143,000 random addresses per check, which took 10 seconds
  of each check, looks like a port scan to the hosting provider, and fills the connection
  tracking table.

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

- Every minute, write the working proxies to `working_vpn_proxies.txt`, one per line,
  fastest first (`working_proxies.txt` for plain proxies).
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
2. **Checker** (done, tuned on the test server 2026-10-11; 5-second timeout since 2026-10-12):
   test the candidates with several processes, print the working ones, and save them to
   `working_proxies.txt`.
3. **Checkpoint file:** save and load the working proxies.
4. **Pool** (done in `channels.py`, 2026-10-12): proxy slots, response sorting and retries;
   no speed limit per IP.
5. **Tune:** run for a day, review the measurements, adjust the numbers, and drop useless sources.
6. **VPN configs through sing-box** (done 2026-10-12): `vpn_configs.py`, `converter.py`,
   `singbox_runner.py` and `check_vpn.py`. Since 2026-10-12 the collector uses only these.
