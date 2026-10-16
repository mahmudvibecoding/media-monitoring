# Proxies

Every request to YouTube and Telegram goes through a proxy. This explains where the proxies come from, how the
collectors use them, and what we've learned about YouTube's and Telegram's limits. [monitoring.md](monitoring.md) explains
the collection itself.

## Why proxies

YouTube limits how much one address can ask for. To check 55,859 channels and hundreds of thousands of
videos in minutes, requests go out from thousands of different addresses. A proxy passes a request on, so
YouTube sees the proxy's address instead of the server's.

## Where they come from

- **VPN configs.** People share free VPN configurations publicly, mostly to help others get around internet
  censorship, and many GitHub projects collect them from Telegram channels into lists. `uv run proxies`
  downloads 41 of those lists, from 31 projects (one of them comes in numbered parts, as many as it has configs for
  that day, up to 15), then runs every config with sing-box, as a
  proxy on the server itself: about 110,000 of them, 1,000 per sing-box process, each group on its own local
  address (127.1.1.1, 127.1.2.1, and so on). A few thousand of them work at any time: about 4,200 when the
  lists were last chosen (2026-10-14), from 969 lists in GitHub projects active that week, by how many working
  configs each added.
- **Plain proxies.** `uv run proxies` also downloads 28 public lists of ordinary HTTP, SOCKS4 and SOCKS5 proxies, about
  510,000 in all. Only a few hundred work at a time (224 of 588,000 checked on 2026-10-14, most of them SOCKS5),
  but each one is another address, which video pages and comments can use (see below). Each collector process
  keeps its share of them in reserve, and brings them in once its VPN proxies stop working, or once it has
  tested all of those and has room for more tests.

Every round downloads both again and restarts sing-box with the new configs, in the background: `uv run proxies`
does all of it in one command, and `uv run proxies stop` stops sing-box. Its report shows the same for every list of
both kinds: when it was last updated (from the file's commit feed on GitHub), how many configs or proxies it has, how
many of those no list above it had, and how many couldn't be used.

## How the collectors use them

Each run starts with every proxy untested, in random order, because proxies stop working within minutes: a list
of the ones that worked in an earlier run wouldn't help.

1. Testing runs apart from the work. Each proxy gets one request of the collector's own kind, for a channel or
   video that has been up for years. A dead proxy's test costs little: a connection attempt that gets nothing
   back. How many tests run at a time follows the CPU the work leaves unused. Each collector process starts with
   100 at a time. Twice a second, the main process doubles that while more than 20% of the server's CPU is idle,
   as when few proxies work, and halves it while less than 10% is, up to 1,000 and down to 25. A process whose
   own core is nearly full tests fewer, whatever the rest of the server does. VPN proxies are always tested
   before plain ones.
2. Real requests only go through proxies that passed their test, so none waits on a dead one. A proxy that
   passed carries 8 requests at a time, and one more each time it answers while all of them are busy, up to
   64. With few working proxies each one carries more, and with many each carries less.
3. Each failure (no answer within 5 seconds, or an answer that isn't YouTube's) takes one request off the
   proxy's share. At zero the proxy rests, then is tested again, and so is a proxy that failed its test. A rest
   lasts 25 to 35 seconds, at random, so proxies that failed together come back at different times. So proxies
   that recover are used again within a minute, even in long runs, though with few tests at a time a proxy may
   wait longer in line for its test.
4. A failed request is sent again through another proxy, up to 5 times.
5. Near the end of a run, when there's no new work left, a request without an answer after a second also goes
   out through a second working proxy, so the last few don't hold up the run.
6. YouTube refuses a request now and then (403 or 429). That alone changes nothing: the request is retried
   elsewhere. Only if 8 of a proxy's last 10 answers are refusals does that proxy pause, for 45 to 75 seconds
   like a rest.

Each process has its own share of the proxies. Certificates aren't checked through proxies, since all the
data is public. A proxy can answer in YouTube's place, so an answer only counts as YouTube's if it looks
like one: a 400 error, for example, only if it's YouTube's own error message.

## Video pages and comments

Video pages and comments come from a different YouTube endpoint (`next`). It blocks an address after a few
minutes of heavy use: every request from it then gets a "Sorry, unusual traffic" page, which takes 20 to 25
seconds to arrive, so it shows up as failures, and the proxy rests like any other. And once the working VPN
proxies of a collector process fall to a quarter of the most it had (or all of them rest), or once it has tested
them all and has room for more tests, the process brings in its share of the plain proxies: many more addresses.
They're tested after the VPN ones, and the VPN ones that come back from their rest carry work again next to them.

The comments step can run for hours (`youtube comments all`), so it also takes in refreshed lists while it runs:
sing-box's proxies are tested again when it restarts with new configs, and new plain proxies join when `uv run
proxies` runs again (or replace the reserve, if it isn't in use yet). When every proxy rests at once, it waits
for them instead of stopping.

## Telegram

Telegram doesn't refuse a busy address: it hides its channel pages from it, redirecting each one to the channel's
plain page as if the channel had no public page. Telegram's step counts that as hidden: the page goes out again
through another proxy, up to ten times, and unlike a request YouTube blocks, it never pauses the proxy, since Telegram
hides some channels from an address, not all of them. A channel that really has no public page is redirected through
every proxy, and counts as failed.

## What we've learned

- **YouTube barely limits the other requests.** Channels, uploads lists, and views and likes ran at up to
  40,000 requests a second with no blocks, so there's no speed limit per address. An occasional refusal is
  simply retried elsewhere.
- **For those, the server is the limit,** not YouTube or the proxies: the work keeps all of its cores busy.
  Refreshing all 55,859 channels takes about 7 seconds, and views and likes go at 32,000 to 45,000 videos a
  second.
- **Video pages and comments are limited by addresses.** With about 2,800 VPN addresses, comments came in at
  about 250,000 a second for 3 minutes, then slid to about 10,000 a second within 8 minutes as the addresses
  got blocked. About 3,000 working plain proxies raised the peak, but it slid the same way. How long a block
  lasts, and how fast one address can go without one, isn't measured yet.
- **Proxies come and go.** In a long run most of them fail now and then. When a single failure dropped a
  proxy for good, a long run slowed from 8,000 videos a second to 80; now failed proxies rest and come back.
- **Testing more proxies at once slows the work.** With 500 tests at a time in each process instead of 100, a
  channels run found about 6,500 working proxies instead of 1,600, but took 14 to 15 seconds instead of 8 to 10
  (with another run keeping the server busy). Testing 500 at a time only while requests waited for a free proxy
  was slower too, on a quiet server: channels took 11 seconds instead of 7 to 8, uploads lists 14 to 15 instead of
  11 to 12, and views and likes 10 instead of 6, while comments were no faster. Following the CPU the work leaves
  unused instead kept channels and uploads lists as fast as 100 at a time, and refreshed 90 days of views and likes
  in 24 seconds instead of 26 to 27, with 20,000 tests instead of 49,000.
- **Comments runs one after another slow each other down.** Each run gets more addresses blocked on the `next`
  endpoint, and the blocks outlast the gap to the next run: four full comments runs in a row took 50, 66 and 106
  seconds, and the fourth was still going after 530.
- **Bandwidth isn't a limit.** A video page takes about 700 bytes down and 530 up, so even 12,000 a second
  use only about 65 Mbit/s down and 50 up.

## Checking the lists

`uv run proxies check` sends one real request through every proxy and reports how many work: the VPN ones by
protocol and by list, and the plain ones by type and by list. Both kinds are checked the same way, with a channel
page. `uv run proxies check vpn` or `check plain` checks one kind. The collectors don't need it; it shows which
lists are worth keeping.

## Weak points

- **Lists disappear.** They're run by individuals, and several well-known ones from 2023 no longer exist.
  Most of ours are only a year or two old.
- **They copy each other.** That helps: most configs appear in several lists, so losing one list costs
  little. Some still carry working configs no other list has: on 2026-10-14 the biggest such share, OpenRay's,
  was about a fifth of all the working ones.
- **If the lists die,** the configs can still be read from the Telegram channels they're collected from, or
  a paid proxy service can take their place.
