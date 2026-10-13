# Proxies

Every request to YouTube goes through a proxy. This explains where the proxies come from, how the
collectors use them, and what we've learned about YouTube's limits. [monitoring.md](monitoring.md) explains
the collection itself.

## Why proxies

YouTube limits how much one address can ask for. To check 55,859 channels and hundreds of thousands of
videos in minutes, requests go out from thousands of different addresses. A proxy passes a request on, so
YouTube sees the proxy's address instead of the server's.

## Where they come from

- **VPN configs.** People share free VPN configurations publicly, mostly to help others get around internet
  censorship, and many GitHub projects collect them from Telegram channels into lists. `uv run proxies`
  downloads 24 of those lists, from 19 projects, then runs every config with sing-box, as a
  proxy on the server itself: about 67,000 of them, 1,000 per sing-box process, each group on its own local
  address (127.1.1.1, 127.1.2.1, and so on). A few thousand of them work at any time.
- **Free proxies.** `uv run proxies` also downloads 26 public lists of free HTTP and SOCKS4 proxies, about 330,000
  in all. Only about 1% work, but each one is another address, which video pages and comments can use (see
  below). They're used only when asked for with `--plain`. Free SOCKS5 proxies are left out: none of them worked.

Every round downloads both again and restarts sing-box with the new configs, in the background: `uv run proxies`
does all of it in one command, and `uv run proxies stop` stops sing-box.

## How the collectors use them

There's no separate test: the collectors' real requests show which proxies work. Each run starts with every
proxy untested, in random order, because proxies stop working within minutes: a list of the ones that worked
in an earlier run wouldn't help.

1. An untested proxy gets one request. If there's no answer within a second, the request also goes out
   through a proxy that already works, if one is free, so nothing waits long on a dead proxy. A failed test
   doesn't count against the request.
2. Once YouTube answers through a proxy, it carries 8 requests at a time, and one more each time it answers
   while all of them are busy, up to 64. With few working proxies each one carries more, and with many each
   carries less.
3. Each failure (no answer within 5 seconds, or an answer that isn't YouTube's) takes one request off the
   proxy's share. At zero the proxy rests for 30 seconds, or 60 if it never answered in this run (most of
   those are dead), then gets one request again. So proxies that come back are used again, even in long
   runs.
4. A failed request is sent again, up to 5 times.
5. Working proxies always come first: untested ones only get requests that would otherwise wait.
6. Near the end of a run, when there's no new work left, a slow request also goes out through a second
   working proxy, so the last few don't hold up the run.
7. YouTube refuses a request now and then (403 or 429). That alone changes nothing: the request is retried
   elsewhere. Only if 8 of a proxy's last 10 answers are refusals does that proxy pause for 30 seconds.

Each process has its own share of the proxies. Certificates aren't checked through proxies, since all the
data is public. A proxy can answer in YouTube's place, so an answer only counts as YouTube's if it looks
like one: a 400 error, for example, only if it's YouTube's own error message.

## Video pages and comments

Video pages and comments come from a different YouTube endpoint (`next`). It blocks an address after a few
minutes of heavy use: every request from it then gets a "Sorry, unusual traffic" page, which takes 20 to 25
seconds to arrive. So a proxy that fails there rests 15 minutes instead of 30 seconds, and with `--plain` the
details and comments steps also use the free proxies, for as many addresses as possible.

The comments step can run for hours (`comments all`), so it also takes in refreshed lists while it runs:
sing-box's proxies are tested again when it restarts with new configs, and with `--plain`, new free proxies
join when `uv run proxies` runs again. When every proxy rests at once, it waits for them instead of stopping.

## What we've learned

- **YouTube barely limits the other requests.** Channels, uploads lists, and views and likes ran at up to
  40,000 requests a second with no blocks, so there's no speed limit per address. An occasional refusal is
  simply retried elsewhere.
- **For those, the server is the limit,** not YouTube or the proxies: the work keeps all of its cores busy.
  Refreshing all 55,859 channels takes about 7 seconds, and views and likes go at 32,000 to 45,000 videos a
  second.
- **Video pages and comments are limited by addresses.** With about 2,800 VPN addresses, comments came in at
  about 250,000 a second for 3 minutes, then slid to about 10,000 a second within 8 minutes as the addresses
  got blocked. About 3,000 working free proxies raised the peak, but it slid the same way. How long a block
  lasts, and how fast one address can go without one, isn't measured yet.
- **Proxies come and go.** In a long run most of them fail now and then. When a single failure dropped a
  proxy for good, a long run slowed from 8,000 videos a second to 80; now failed proxies rest and come back.
- **Bandwidth isn't a limit.** A video page takes about 700 bytes down and 530 up, so even 12,000 a second
  use only about 65 Mbit/s down and 50 up.

## Checking the lists

`uv run check-vpn` sends one real request through every VPN proxy and reports how many work, by protocol and
by list. `uv run check-plain` does the same for the free proxies, by type and by list, with a video page, since
that's what they're used for. The collectors don't need either; they show which lists are worth keeping.

## Weak points

- **Lists disappear.** They're run by individuals, and several well-known ones from 2023 no longer exist.
  Most of ours are only a year or two old.
- **They copy each other.** That helps: most configs appear in several lists, so losing one list costs
  little. Six lists still carry configs no other list has; losing all six would cost about a third of the
  working proxies.
- **If the lists die,** the configs can still be read from the Telegram channels they're collected from, or
  a paid proxy service can take their place.
