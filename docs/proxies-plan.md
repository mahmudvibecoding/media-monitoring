# Proxies

Status: in use since October 2026. Still to build: keeping the pool fresh continuously, as part
of the monitoring program ([monitoring-plan.md](monitoring-plan.md)).

## Why we need proxies

YouTube limits how much one address can ask for. To collect data on tens of thousands of
channels quickly, we send our requests from thousands of different addresses. A proxy is a
machine that passes our request on, so YouTube sees the proxy's address instead of ours.

## Where they come from

People share free VPN configurations publicly, mostly to help others get around internet
censorship. Many GitHub projects collect them from Telegram channels and publish them as lists.

We download 24 of those lists, about 70,000 configurations in total. A program called sing-box
turns each one into a proxy on our own server, and we test each with one real YouTube request.
Usually a few thousand work at a time, which is plenty.

We tried free public proxies first. They were slow and unreliable: they did only about 5% of
the work, and most failed on their first real request, so we removed them (the code is still
in the git history).

## How a collection run works

1. Download the 24 lists.
2. Start sing-box, which turns every configuration into a local proxy.
3. Test every proxy with one request, allowing 5 seconds. Slower proxies barely help anyway,
   and the short limit makes the test take about 9 seconds.
4. Send the real requests through the proxies that passed, retrying failures through others.

## What we learned

- **YouTube barely blocks us.** Even at 40,000 requests a second we got no blocks, so we don't
  slow down per address. The occasional random refusal is simply retried elsewhere.
- **Our server is the limit,** not YouTube or the proxies. Fetching details for all 55,859
  channels takes about 6 seconds.
- **Proxies wear out under heavy use,** so a program that runs continuously must keep testing
  and refreshing them.

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
