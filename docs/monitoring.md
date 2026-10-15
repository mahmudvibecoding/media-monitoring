# How monitoring works

The system follows the YouTube channels in `channels.txt` and keeps four things up to date in PostgreSQL:
the channels' details, every video they publish, the views and likes of recent videos, and the comments on
them. It also keeps the details of public Telegram channels up to date (see
[Telegram channels](#telegram-channels)). The [README](../README.md) shows how to run it; [proxies.md](proxies.md)
explains the proxies every request goes through.

## The size of the job

On October 13, 2026:
- 55,859 channels. About a third (20,395) posted in the last 90 days, and over 40% (24,778) haven't posted
  for more than a year.
- 8.0 million videos, with about 7,800 new ones a day. The last 90 days hold about 690,000.
- 193 million comments: every available video's comment list has been read in full. They take 55 GB of the
  database's 63 GB.

## Rounds

`run.sh` runs one round and stops; running it again, for example every 15 minutes from cron, keeps the data up
to date. A round started while another is still running is skipped. A round doesn't guess what changed: it checks
everything again, in this order.

1. **Fresh proxies** (`uv run proxies`). Download the public lists of VPN configs and of plain proxies, and
   restart sing-box with the new configs, in the background. It stops when the round ends.
2. **Channels** (`youtube channels`). Refresh every channel's name, handle, description, picture and subscriber
   count. Only the channels whose details changed are written.
3. **New videos** (`youtube videos`). Read each channel's uploads list, newest first, until reaching a video already
   saved, recognized by the channel's 100 newest saved videos (all a round needs). The list gives each video's ID;
   details fetches the rest. A channel's first run reads its whole history.
4. **Video details** (`youtube details`). For each video that has no title yet, ask for the details YouTube's own
   player gets: the title and description as the creator wrote them (others are shown a translation when the
   creator added one), when it was published (to the second), the exact length, and whether it's a Short. A
   video YouTube shows nothing for (removed, private, or blocked where the proxy is) is marked unavailable and
   tried again every round. `youtube details all` fetches them again for every saved video without an exact publish
   time, newest first: once, for videos saved before details took them from the player.
5. **Views and likes** (`youtube stats 365`). Ask for the current views and likes of every video published in the last
   365 days, with the lightest request YouTube's own video page makes to refresh its counts. A video without an
   exact publish time counts by its upload day, and one without either (a stream that hasn't started) from when
   it was found.
6. **Comments** (`youtube comments 365`). Read the comments of the same videos, newest first, until reaching comments
   already saved. The most viewed videos go first, so their long lists don't hold up the end of the run.

Each step loads what it needs from the database, works as fast as the proxies answer, saves as it goes, and
stops. On the 52-core server the work is split between up to 48 processes (four cores stay free for
sing-box), each with up to 500 items in progress at a time.

## A round in numbers

The round that started at 02:13 UTC on October 13, 2026, when views, likes and comments covered the last 90
days:

| Step | Work | Time |
|---|---|---|
| Fresh proxies | 24 VPN lists and 26 plain-proxy lists; 66,666 configs running in sing-box | about 1 min |
| Channels | 55,859 channels, 58 of them changed | 7 s |
| New videos | 55,859 channels, 42 new videos | 19 s |
| Video details | 540 videos without details | 20 s |
| Views and likes | 688,514 videos, 32,000 a second | 21 s |
| Comments | 688,514 videos, 799 new comments | 58 s |

The whole round took about three minutes, so with a round every 15 minutes the server is idle most of the
time. Bigger jobs take longer: views and likes for all 8 million videos (`youtube stats all`) take about three and a
half minutes, and reading every video's comments the first time took hours.

## What's kept

- **`youtube_channels`:** each channel's name, handle, description, picture and subscriber count (empty when
  hidden).
- **`youtube_videos`:** each video's channel, title, description, length, publish time and its day, kind
  (`video` or `short`), whether YouTube shows it, and when a round first found it. The thumbnail's address is built from the
  video's ID.
- **`youtube_video_stats`:** one small row per video: its latest views and likes and when they were
  refreshed, the comment count YouTube shows (replies included), whether its whole comment list has been
  read, and where an unfinished read continues.
- **`youtube_comments`:** top-level comments, no replies: the author's channel and name, the text, the time
  as YouTube shows it ("2 hours ago"), the time estimated from that, and when we first saw the comment.
- **`youtube_comments_newest`:** each video's 40 newest comment IDs as of its last finished read, newest first.

`schema.sql` creates the tables. `run.sh` runs it at every start, and it only adds what's missing.

## Why it's built this way

- **Every round checks everything.** It takes about three minutes, and it's simpler and more complete than
  guessing what changed. A new video is found within one round of its upload.
- **Details only for new videos.** The player's answer is the only one with the original title, the exact length
  and the Shorts flag, but YouTube checks for bots when it's asked in bulk: tens of thousands of requests in
  minutes are mostly refused ("confirm you're not a bot"), while a round's new videos get through. A first run
  on a channel list with millions of saved videos therefore takes many rounds, or `youtube details all` runs, to fill in
  their details.
- **Only the latest views and likes.** Each video has one row, overwritten at every refresh, so the table
  doesn't grow with every round. It's kept apart from the videos table, so a refresh rewrites a few bytes
  instead of the title and description, and half of each table page stays free, so the new row fits next to
  the old one. When the numbers lived in the videos table, saving them stalled the disk.
- **Empty views and likes.** While a stream is live or upcoming, YouTube shows viewers instead of views, so
  its views stay empty until it ends. Likes are empty when they're turned off, as on videos made for kids.
- **Estimated comment times.** YouTube shows only "2 hours ago" or "3 years ago", so the estimate is only as
  precise as that. The time we first saw a comment is exact.
- **Long comment lists continue where they stopped.** Some videos have hundreds of thousands of comments.
  Every 20 pages a read notes where it is, so if it stops (a page keeps failing, or the run ends), the next
  run continues from there instead of starting over.
- **A run loads only each video's newest comments.** To find where a read stops, a run has to recognize the
  comments it already has at the top of each list. A page holds about 20 comments, so those are among the video's
  40 newest, which a run reads with the list of videos. Loading every saved comment instead would take a 360-day
  run a minute or more of scattered disk reads before its first page.
- **Fast saving.** Each process saves what it has collected every 2 seconds, with COPY, PostgreSQL's fastest
  way to add rows. Saves don't wait for the disk: a crash could lose the last second of them, which the next
  round collects again. `run.sh` also sets PostgreSQL up for heavy writing: a quarter of the memory as its
  cache (at most 16 GB), a checkpoint every 30 minutes, and a compressed write log.
- **Small answers.** Each request asks YouTube only for the fields it needs. If YouTube rejects 20 requests
  in a row, those fields have probably changed, and the run stops with an error instead of collecting
  nothing.

## Not collected

- Replies to comments, and the comments' likes.
- How views and likes change over time: only the latest numbers are kept.
- Exact upload times (see above).

## Telegram channels

`telegram_channels` holds 310,333 public Uzbek Telegram channels, from a list of channels found through their public
pages (September 2026), keyed by Telegram's ID for the channel. `uv run telegram channels` refreshes their title,
description and subscriber count from each channel's public page, `t.me/s/<username>`, which anyone can read without
an account. It isn't part of the rounds.

- **One page per channel.** The page shows the channel's title, description and counters, and its 20 or so newest
  messages. It rounds subscriber counts of 1,000 and more to three digits (1.14M). Only the channel's plain page,
  `t.me/<username>`, has the exact count, but Telegram answers about 10 of those a second per address, against
  hundreds of public pages.
- **The newest message, once.** A channel without a last message yet gets the newest one on its page (for an album,
  its last item: Telegram numbers each item), so reading its messages can start there.
- **Usernames move.** A channel can change its username, and another channel can take the old one. Each message on
  the page carries the channel's ID, so a page whose messages belong to another channel is left out.
- **Through the proxies, like YouTube's steps.** Telegram doesn't refuse an address that asks too fast; it hides
  pages from it instead, redirecting them as it does for a channel without a public page. A hidden page goes out
  again through another proxy, up to five times, so each address asks for few pages. From the server's own address
  alone, Telegram hid about half the pages at 500 a second; at about 30,000 requests a second, it also kept hiding
  those channels for about 12 minutes afterwards, from other visitors too.
