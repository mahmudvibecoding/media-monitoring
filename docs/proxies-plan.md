# Proxies

Status: in use since October 2026. Each monitoring round starts by getting fresh proxies
([monitoring-plan.md](monitoring-plan.md)).

## Why we need proxies

YouTube limits how much one address can ask for. To collect data on tens of thousands of
channels quickly, we send our requests from thousands of different addresses. A proxy is a
machine that passes our request on, so YouTube sees the proxy's address instead of ours.

## Where they come from

People share free VPN configurations publicly, mostly to help others get around internet
censorship. Many GitHub projects collect them from Telegram channels and publish them as lists.

We download 24 of those lists, about 70,000 configurations in total. A program called sing-box
turns each one into a proxy on our own server, and our real YouTube requests show which ones work.
Usually a few thousand work at a time, which is plenty.

We tried free public proxies first. They were slow and unreliable: they did only about 5% of
the work, and most failed on their first real request, so we removed them (the code is still
in the git history).

## How a collection run works

1. Download the 24 lists.
2. Start sing-box, which turns every configuration into a local proxy.
3. Send the real requests through the proxies, in random order. A new proxy gets a single
   request; if it hasn't answered within a second, the request also goes out through a proxy
   that already works, if one is free, so nothing waits long on a dead one. A failure there
   isn't held against the request.
4. Each proxy finds its own pace. Once YouTube answers through it, it carries 8 requests at a
   time, and one more whenever it keeps up while all of them are busy, up to 64. So with few
   proxies each one carries more, and with many each carries less. Each failure (no answer
   within 5 seconds) takes one request off its share.
5. A proxy whose share falls to zero rests for 30 seconds, or 60 if it never answered in this
   run (most of those are dead), then gets one request again. So proxies that come back are
   used again, even during long runs.

Every program starts fresh like this: proxies stop working within minutes, so a list of the
ones that worked in an earlier program wouldn't help.

A separate checker can still test every proxy once, to show which lists work best.

## What we learned

- **YouTube barely blocks us.** Even at 40,000 requests a second we got no blocks, so we don't
  slow down per address. The occasional random refusal is simply retried elsewhere.
- **Our server is the limit,** not YouTube or the proxies. Fetching details for all 55,859
  channels takes about 6 seconds.
- **Proxies come and go.** In a long run most of them fail now and then. When a single failure
  dropped a proxy for good, a long run slowed from 8,000 videos a second to 80; now failed
  proxies rest and are tried again.

## Risks

- **Lists disappear.** They're run by individuals, and several well-known ones from 2023 no
  longer exist. Most of ours are only a year or two old.
- **They copy each other.** That's useful: most configurations appear in several lists, so
  losing one list usually costs little. Six lists still have configurations nobody else has;
  losing all six would cost about a third of the working proxies.
- **To stay safe for years:**
  - watch each list's health automatically;
  - keep our own archive of configurations;
  - read the Telegram channels directly if the lists die;
  - test a paid proxy service as a backup.
