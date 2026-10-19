# How monitoring works

The system follows the YouTube channels in `youtube_channels.txt` and keeps four things up to date in PostgreSQL:
the channels' details, every video they publish, the views and likes of recent videos, and the comments on
them. It also collects the text messages of the public Telegram channels in `telegram_channels.txt`, and keeps their
details up to date (see [Telegram](#telegram)). The [README](../README.md) shows how to run it;
[proxies.md](proxies.md) explains the proxies every request goes through.

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
7. **Telegram messages** (`telegram messages`). Read every Telegram channel's new messages, and keep those with
   text (see [Telegram](#telegram)).

Each step loads what it needs from the database, works as fast as the proxies answer, saves as it goes, and
stops. On the 52-core server the work is split between up to 48 processes (four cores stay free for
sing-box), each with up to 500 items in progress at a time. The items go out in batches of up to 1,000 (fewer in a
small run, so that each process takes about 20): a process asks for the next batch once few of its last one's items
are left to start, so one whose proxies work faster takes more, and none sits idle while another still has many left.
With fixed equal shares, the last 57,000 of 8 million videos in a comments run took 2 of its 7 minutes, a few
processes working alone; with batches, 46 s, 35 of them on a single video.

Every round, every `uv run proxies` and every run of a step, whether in a round or by hand, leaves a row in the
`runs` table (`src/media_monitoring/runs.py`):
- **As it starts:** the step and its argument, and the round it's in, if it's in one.
- **Every few seconds, while it works:** how many items it has done and saved, and its requests a second; a step
  killed outright (out of memory, say) stops updating, and stays "running".
- **As it ends:** how it ended (finished, stopped by Ctrl+C or kill, or failed), its last line, and every count:
  each outcome of its items (ok, failed, gone, ...), its requests by outcome, its proxy tests, and the proxies still
  working. `uv run proxies` keeps each list's numbers instead (found, new, skipped, when it last changed), the unique
  configs and proxies by protocol, and how many proxies sing-box started.

A step never fails for its row: without the table, it says so once and works as before. The website's activity pages
show the rows (see [How the website works](website.md#runs)).

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
- **`runs`:** every round and run of a step, as they went (see [Rounds](#rounds)).

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

## Telegram

`telegram_channels` holds the 298,077 public Uzbek Telegram channels in `telegram_channels.txt` (a channel's ID and
username on each line), keyed by Telegram's ID for the channel: a list of channels found through their public pages
(September 2026), without the 12,354 [deleted](#channels-deleted). Everything comes from those public pages,
`t.me/s/<username>`, which anyone can read without an account. They only work by username, so a channel that changes
its username can't be followed any more.

### New messages

`uv run telegram messages`, the last step of a round, reads every channel's new messages:

- **The messages after the last one.** For each channel it asks for the messages after its last message, the request
  a channel's page makes as you scroll down. Most channels have nothing new, a 2-byte answer. An answer brings up to
  20 messages (Telegram counts each item of an album as one), so a channel with more news is asked again after the
  newest one it brought, until an answer is empty.
- **Busy channels, 10 pages at a time.** A channel's message IDs are consecutive, so a channel with more than two
  pages of news keeps 10 pages asked for at once, starting 20 IDs apart, the next one going out as soon as one comes
  back. Some taxi ad channels post about 30,000 messages a day: a backlog of 10,000 is read in about 30 seconds.
- **Messages with text.** A message's own text, or its photo's, video's or album's caption, is kept as plain text,
  with its line breaks; a link hidden behind words keeps its address after them, in brackets. Messages without text
  (stickers, voice messages, photos without a caption, notices like "pinned a photo") aren't kept.
- **Nothing lost, nothing twice.** A channel's new messages and its new last message, text or not, are saved in one
  transaction, and the last message only moves as far as the pages read without a gap. If a run stops or crashes,
  what wasn't saved is read again next run.
- **Hidden pages.** Telegram doesn't refuse an address that asks too fast; it hides pages from it instead,
  redirecting them as it does for a channel without a public page. A hidden page goes out again through another
  proxy, up to ten times, and a channel that fails every time is asked again once every channel has had its turn,
  30 seconds after it failed at the earliest: by then the load has dropped. Telegram never answered "nothing new"
  to hide a page: at about 30,000 requests a second, such answers stayed at the level that deleted messages explain.
- **Usernames move.** Each message carries its channel's ID, so a page whose messages belong to another channel is
  left out: its username moved.

The first run, on October 16, 2026, read what was posted since the channels' last messages were noted the day
before: 196,496 messages from 27,357 channels. A run a few minutes after another takes about 70 seconds: on 305,065
channels it found 13,428 messages in 4,290 of them; 1,181 channels failed at first, and 1,011 of those were read when
asked again at the end.

### Channel details

`uv run telegram channels`, run by hand rather than in the rounds, refreshes each channel's title, description, photo
and subscriber count from its public page. It doesn't save the messages that page shows: `telegram messages` does.

- **One page per channel.** The page shows the channel's title, description and counters, and its 20 or so newest
  messages. It rounds subscriber counts of 1,000 and more to three digits (1.14M). Only the channel's plain page,
  `t.me/<username>`, has the exact count, but Telegram answers about 10 of those a second per address, against
  hundreds of public pages.
- **The photo's address, not the photo.** The page shows the channel's photo, 160 × 160 (about 10 KB), on Telegram's
  image server (cdn1.telesco.pe, ...); the website loads it from there. The address is the same from one request to
  the next, and the step saves whatever address the page shows, so a new photo replaces the old. A channel without a
  photo has Telegram's stand-in there, its initials, which isn't kept.
- **The newest message, once.** A channel without a last message yet gets the newest one on its page (for an album,
  its last item), so reading its messages can start there. While the page's newest message is still that one, its time
  is taken from the page again: a time is the message's date link's, and one read wrong, like a scheduled stream's
  time in its notice ("Live stream scheduled for Oct 18 at 16:00"), is put right.
- **Through the proxies, like YouTube's steps.** A hidden page goes out again through another proxy, up to ten
  times, and the proxy keeps working: Telegram hides some channels from an address, not all of them. From the
  server's own address alone, Telegram hid about half the pages at 500 a second; at about 30,000 requests a second,
  it also kept hiding those channels for about 12 minutes afterwards, from other visitors too.

### History

`uv run telegram history`, run by hand, reads back the channels' older messages, the channels with the fewest
letters first, as far as each needs:

- **Up to 10,000 letters and 100 messages.** A channel is read back until its saved messages hold both 10,000
  letters (`telegram history 1000`: 1,000) and 100 messages, its first message is reached, or 10,000 messages before
  its last one are: a channel posting photos without captions for years would bring few letters for many pages.
  Letters are counted without links, as `letters()` in `schema.sql` does; each channel keeps the count of its saved
  messages' letters, which a trigger adds to whichever step saves them.
- **The messages before the oldest one read.** That's the request a channel's page makes as you scroll up: 20
  messages before a given one, or an empty answer before the first. After two pages one after another, a channel
  keeps up to 10 pages asked for at once, starting 20 IDs apart, but no more than the letters and messages it still
  lacks need at the rate its pages brought them so far.
- **It goes on where it stopped.** How far back each channel is read (`history_from`; 0 once its first message is
  reached) is saved with its messages, in one transaction, and only as far as the pages read without a gap; the
  next run starts there. The messages with text are kept as `telegram messages` keeps them, those already saved
  skipped, and the channel's last message doesn't move. Hidden pages and moved usernames are handled as in
  `telegram messages`, failed channels asked again at the end.

Its first runs, on October 18, 2026, went to 1,000 letters (101,107 channels in 389 seconds), then part of the way
to 100,000, then to 10,000 letters and 100 messages: 251,375 channels in 765 seconds, at about 4,900 pages a second,
saving 23.3 million messages. Then 184,941 channels had both, 118,038 had less but were read back to their first
message, and the 36.5 million saved messages took 15 GB.

### Languages

`uv run telegram languages`, run by hand, finds each channel's main language with CLD2 (Google's Compact Language
Detector 2), from its title, description and saved messages joined up, and saves its code in
`telegram_channels.language`: `uz`, `ru`, `en` and so on; `uz-Arab` for Uzbek in Arabic script, which is also what
CLD2 calls the South Azerbaijani of Iran's channels; NULL without text. It needs no network: 48 processes take ranges
of channel IDs and read their messages in the messages table's key order. On the channels labelled by hand, CLD2
named a message's language right 97.5% of the time from its first 50 letters in Uzbek, and 98% from 100 in Russian.

### Channels deleted

On October 18, 2026, 12,282 channels were deleted, with their 529,597 messages:

- **Unrelated or unsure** (1,288 and 6,236): of the 41,999 channels not in Uzbek, those a model found unrelated to
  Uzbekistan, or couldn't tell about. Gemma 4 (26B-A4B, 8-bit) read each one's username, title, description and its
  messages up to 2,000 letters, on the A40 server, in 68 minutes, and answered with one letter.
- **Without messages** (4,758 more): channels without a saved message, whatever their language: pages Telegram never
  showed a post on (channels gone, or names now someone else's) and channels whose posts have no text.

On October 19, 72 more went, with their 541,225 messages: the channels that had posted 300 messages a day or more
over the three days before (304 to 11,847 a day), mostly taxi ride ads, with shops and a betting-signals channel.
After a three-day gap they had brought half of a run's new messages, and kept it running minutes after every other
channel was done.

`telegram_channels.txt` doesn't have them, so they don't come back.

### What's kept

- **`telegram_channels`:** each channel's username, title, description, subscriber count, photo's address, its
  last message read (ID and time), how far back its history is read, the letters in its saved messages, and its
  main language.
- **`telegram_messages`:** each message with text: its ID (an album's first item), when it was published (to the
  second), the text, and when we first saw it.

Not collected: messages' photos, videos and other media; views and reactions; where a forwarded message came from;
replies and edits; and comments, which Telegram doesn't show without an account.
