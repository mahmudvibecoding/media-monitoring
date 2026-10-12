# Monitoring plan

Status: plan, not built yet (October 2026).

## What we want

We follow about 56,000 YouTube channels. The monitoring system should:
- notice new videos soon after they're published and save their details;
- keep the views and likes of recent videos up to date: those published in the last 90 days,
  a window we can change;
- collect new comments on those videos.

## How big the job is

Measured on our channel list:
- About a third of the channels are active (posted in the last 90 days), and about 40% haven't
  posted for over a year.
- They publish about 6,000 new videos a day, so the 90-day window holds about 557,000 videos.
- Those videos have about 8 million comments, and at least 44,000 new comments arrive each day.

## Where the data comes from

YouTube's website shows all of this publicly. For each need we use the lightest way of asking
for it, sent through our proxies (see [proxies-plan.md](proxies-plan.md)):
- **New videos:** every channel has a small public feed of its 15 newest videos, with exact
  publish times, views and likes. Checking it tells us what's new.
- **A channel's full upload list:** a safety net for the rare video the feed misses, and the
  source of video durations.
- **Views and likes:** a trimmed-down request for a video's page.
- **Comments:** one request returns a video's 20 newest comments and its total comment count.

Each of these was tried on every channel or every recent video, and YouTube blocked none of
the requests. YouTube's official API was considered too: its free daily quota is far too small
for this many channels.

## How it works

One program runs all the time. The database remembers, for every channel and video, when it
should be checked next. The program keeps picking whatever is due, fetches it, saves the
result and sets the next check time.

How often something is checked depends on how fast it changes:
- Channels that post often are checked every few minutes, quiet ones every few hours.
- A video's numbers move fast in its first hours, so a new video is refreshed every 15 minutes
  at first, then less and less often, down to once a day near the end of its 90 days. After
  that it's no longer tracked.
- A video whose comments have stopped coming is checked for comments less often.

The proxy list is refreshed inside the same program, because proxies wear out quickly.

## What we keep

- **Videos:** title, description, publish time, length, type (normal video, Short or live
  stream), and the latest views, likes and comment count.
- **History:** every refresh of the numbers, so we can see how a video grows over time.
- **Comments:** text, author, likes and replies. YouTube only shows comment times like
  "2 hours ago", so the time is an estimate, plus the exact time we first saw the comment.

## How much work it is

About 6 million requests a day. In tests, the server handled 40,000 requests a second, so this
uses a tiny fraction of its capacity, and we can check more often if we want fresher numbers.

## Still unknown

- Whether YouTube stays this tolerant over days and weeks; we tested minutes.
- How late the new-video feeds can be.
- How to treat live streams, whose view counts mean "watching now" while live.

## Steps

1. Database tables for videos, their history and comments.
2. A shared request engine, taken from today's channel collector.
3. Finding new videos.
4. Refreshing views and likes.
5. Collecting comments.
6. Keeping the proxy pool fresh inside the program.
7. Filling in the last 90 days once, then running it continuously.
