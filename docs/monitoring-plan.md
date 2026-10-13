# Monitoring plan

Status: being built (October 2026). The database tables and the proxy pipeline are done; the
collectors below come next, one at a time.

## What we want

We follow about 56,000 YouTube channels. The system should:
- find every video they publish, and save its details;
- keep the views and likes of recent videos up to date: those published in the last 90 days, a
  window we can change;
- collect new comments on those videos.

## How big the job is

Measured on our channel list:
- About a third of the channels are active (posted in the last 90 days), and about 40% haven't
  posted for over a year.
- Together they have about 8 million videos, and publish about 6,000 new ones a day.
- The 90-day window holds about 690,000 videos, with about 8 million comments, and at least
  44,000 new comments arrive each day.

## How it works

The system works in rounds, one after another (for example every 15 minutes). Each round runs
a few separate programs in a fixed order. Each one reads from the database what it needs, does
all of its work as fast as possible through our proxies (see [proxies-plan.md](proxies-plan.md)),
saves the results and stops. There are no schedules: every round simply checks everything again.

1. **Fresh proxies:** download the public VPN lists and start sing-box. There's no separate
   test: each program below finds the working proxies through its own real requests.
2. **Channel details:** refresh the name, handle, description, picture and subscriber count
   of every channel. Only the channels whose details changed are written.
3. **New videos:** read each channel's list of uploads, newest first, until reaching a video we
   already have. The list gives each video's ID and length. The first round reads every
   channel's whole history.
4. **Video details:** for each video without details, open its video page to get the title,
   description and upload day. The thumbnail's address is built from the video's ID.
5. **Views and likes:** for each video from the last 90 days, ask for its current views and
   likes, using the lightest request YouTube's website has for it. Only the latest numbers are
   kept. While a stream is live or upcoming, YouTube shows viewers instead of views, so its
   views stay empty until it ends.
6. **Comments:** for each video from the last 90 days, read its comments newest first: the
   whole list the first time, then only the new ones, down to the last one we have. Top-level
   comments only, no replies.

Then the round stops the proxies, waits, and the next round starts.

## What we keep

- **Channels:** name, handle, description, picture, subscriber count.
- **Videos:** title, description, length, upload day, thumbnail.
- **Views, likes and comment count:** each video's latest numbers, in one small row per video.
- **Comments:** text and author, top level only. YouTube only shows comment times like
  "2 hours ago", so the time is an estimate, plus the time we first saw the comment.

## Why only the upload day

The only request that gives a video's exact upload time is refused by YouTube at our volume
("confirm you're not a bot"). The video page works without limits, but shows only the day. For
videos found in later rounds, the time we first saw them is within one round of the upload.

## How much work it is

A round takes one or two minutes; the first one takes longer, because it reads all 8 million
videos and the existing comments. In tests, the server handled about 40,000 requests a second,
so even frequent rounds use a small part of its capacity.

## Still to decide

- How often rounds run.

## Still unknown

- Whether YouTube stays this tolerant over days and weeks; we tested minutes.

## Steps

1. Proxies, channel details and the database tables (done).
2. New videos (done).
3. Video details (done).
4. Views and likes (built).
5. Comments (built). A read that stops partway continues from there next time.
6. One script that runs the rounds: run.sh (built).
