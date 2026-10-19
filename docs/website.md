# How the website works

The website shows what the system has collected, in Russian, Uzbek and English, at https://198.163.196.164. It's two
services behind Caddy: the web API, which reads the database, and the site, which renders the pages. The
[README](../README.md) has the commands; this explains how the parts fit, and why.

```
browser ── HTTPS ──> Caddy ── /api/... ──> API (FastAPI, 127.0.0.1:8000) ──> PostgreSQL, read only
                       └──── the rest ───> site (Next.js, 127.0.0.1:3000) ──> API
```

Only Caddy can be reached from outside. It gives each request an ID and passes it on. The site renders each page on
the server, asking the API directly, so the page arrives with its data; the browser then asks `/api/...` through Caddy
to keep it fresh.

## The API

- `/api/health` answers while it runs, `/api/health/ready` once the database answers too, `/api/status` with how much
  the database holds, and `/api/docs` lists them all. It and the description it shows, `/api/openapi.json`, are for
  admins only; `openapi.json` in the repo is the same description (`uv run api openapi`).
- The counts of videos, comments and messages are PostgreSQL's own running count of each table's rows: reading it takes
  a millisecond, while counting the rows takes 0.15 s for Telegram messages and minutes for the 194 million comments.
  The channels counted are those the lists show, with something collected (see below), counted from their indexes: 46 ms
  for YouTube's and 40 ms for Telegram's, at the same time.
- Every failure is the same JSON, `{"error": code, "message", "request_id"}`, with codes like `database_unavailable`
  (503), `database_timeout` (504) and `internal` (500); a crash's details only go to the log.
- A request waits at most 5 s for a database connection, and a query runs at most 5 s.
- It connects as `media_monitoring_api`, which can read the collected data and change none of it. The website's own
  tables, in the schema `app` (`app.sql`: accounts, their sessions and failed sign-ins), it may also change.
- Its log is JSON lines, one per request among them: method, path, status, milliseconds, the visitor's address, and
  the request's ID.

### Accounts

An account is an admin or a customer, each a person; there's no signing up (`uv run api add-admin` adds an admin on
the server). Signing in (`/api/auth/sign-in`) starts a session:
- Its token is in a cookie that page scripts can't read, sent only over HTTPS and not with requests that start on other
  sites; the database keeps only the token's hash, so the table alone can't be used to sign in.
- A session lasts up to 30 days and ends after 7 days unused; signing out, a password change (for the other sessions)
  and disabling the account end it at once.
- Passwords are Argon2id hashes (64 MiB, 3 passes: about 0.2 s to check). A wrong password and an email without an
  account get the same answer, after the same time, so it doesn't show which emails have accounts.
- After 10 failures for an email, or 50 from an address, within 15 minutes, sign-ins wait (429).
- A request that changes something, from another site's page (its Origin header), is refused.
- Sign-ins, failures, sign-outs and password changes go into the log, with the address, never a password.

### YouTube

`/api/youtube/channels` gives admins the channels a page at a time, the biggest first, and how many match: as many to a
page as `size` asks for, up to 100, as the site's grid asks for as many as fit the screen; with `search`, those whose
name or handle has it in them. Through Caddy, a search takes about 13 ms, the first page 41 ms
(counting all 55,859 channels) and a search for a single letter 60 ms:
- Each channel's name and handle are kept searchable in a column of their own, `search_text`: in lowercase, and without
  apostrophes, which Uzbek writes oʻ and gʻ with in seven ways (Zo'r, Zoʻr, Zo‘r...), so that zor, zo'r and zoʻr find
  the same 442 channels. PostgreSQL brings it up to date as the collectors change them. A trigram index (pg_trgm) finds
  any part of it. Worked out during each search instead, it took 0.5 s for a search the index can't narrow down, like
  one letter.
- A page's channels are picked from the order's index alone, which holds their IDs and the search column, and only
  those are read from the table: a page far down takes milliseconds, not the 0.4 s of reading and sorting every channel.
  The page and the count are asked for at the same time, on two connections.
- `app.sql` has the column and the indexes, so a deploy makes them: 3 s the first time, nothing after.

A channel's page asks for two things. `/api/youtube/channels/{id}` is the channel's details, with how many of its videos
there are of each kind: counting them takes a few milliseconds for most channels (40 videos, the median), and 50 ms for
the one with the most (20,176). `/api/youtube/channels/{id}/videos` is a page of its videos, newest first, or the oldest
first (`sort=oldest`): the collectors' own index, by channel and day, gives them in either order, so a page takes about
15 ms through Caddy even for that channel, and one 400 pages down 100 ms. The most viewed first (`sort=popular`) read
every video's views, which are a table of their own: a few milliseconds for most channels, 0.25 s for the biggest (0.9 s
the first time, from disk). With `search`, only the videos whose titles have it in them, whatever the case of the
letters and apostrophes aside, as the channels' search: reading every title of the channel's takes a millisecond for
most channels and 0.27 s for the biggest. The videos aren't counted again for each page, which would add those 50 ms to
every page.

A video's page asks for three things. `/api/youtube/videos/{id}` is its details, its channel's picture and subscribers,
and how many of its comments have been collected (YouTube's own count has the replies too, which aren't).
`/api/youtube/videos/{id}/comments` is a page of its comments, newest first: most videos have a few (5, the median), and
theirs take milliseconds, but a video's comments are sorted by their time on each request, so the video with the most,
128,669, takes 0.3 s for the first page and 0.75 s for the last. YouTube says only how long ago a comment was written
("2 months ago"), which the collector counted back from when it read it; the API also gives the unit it was said in, and
whether the comment was edited. Beside the video, its channel's newest videos are the first page the channel's own page
asks for. A Short's page asks for its details, its channel's, and its channel's Shorts in the order of the grid it was
opened from: the Shorts after it in its feed are in that list, and only each one's details and comments are asked for as
it comes.

### Which channels are listed

Both lists show only the channels with something collected, and count only those: a YouTube channel with a video, a
Telegram channel with a saved message (55,600 of 55,859 on October 17, 2026, and 298,169 of 310,431 on October 18).
Each channel keeps whether it has in a column of its own, `has_videos` or `has_messages`, which a trigger sets as the
collectors save videos and messages; the lists' indexes hold only those channels. Looked up in the videos' and
messages' tables on each request, counting them took 0.9 s and 0.3 s (Telegram's 30,272 then). A channel's page can
still be opened by its address.

### Telegram

`/api/telegram/channels` lists the Telegram channels the way YouTube's are listed: a search column and its trigram
index, an index for each order holding the search column, the page picked from the index alone, all in `app.sql`. Its
orders are the biggest first and the latest to post first, 50 to a page, each channel with the first 200 characters of
its latest saved message, which the messages table's key gives at once (10 ms for a page). Counting the 298,169
channels with a saved message takes 40 ms, from an index of their own that holds nothing else (2 MB); through an
order's index, it took 180 ms. `/api/telegram/channels/{id}` is a channel's details, with how many of its messages
have been saved, and `/api/telegram/channels/{id}/messages` a page of its messages, newest first, by the messages
table's key: a few milliseconds, even for the channel with the most; with a search, those whose text has it in them
(lowercase, apostrophes aside, as the lists' searches), which reads all the channel's messages: 50 ms for the one with
the most (7,000).

### Runs

`/api/runs` gives admins the rows of the `runs` table (see [How monitoring works](monitoring.md#rounds)), 20 at a time,
newest first: the rounds, each with its steps in the order they ran, and the runs started by hand; with `step`, only
that step's runs, in rounds or by hand; `/api/runs/{id}` is one run with all its numbers, or a round with its steps.
Lists leave out the numbers of each proxy list `uv run proxies` read (about 10 KB a run); its own page has them.
- A run writes its numbers every few seconds while it works, so a row that still says running but hasn't changed for 5
  minutes belongs to a run killed outright (out of memory, the machine going down), which never wrote how it ended: the
  API gives it as lost. A round is lost once neither it nor any of its steps has changed for 5 minutes.
- Each lookup has an index of its own in `schema.sql`: the rounds and the runs by hand, a step's runs, and a round's
  steps. Pages are picked and counted from them, so they stay quick as rows pile up: about 900 a day, with a round every
  15 minutes.

## The site

- Next.js 16 and React 19 in TypeScript, with shadcn/ui's components on Base UI.
- Light only, and sober: white, near-black and greys, with color only for a status (running, stopped, failed). YouTube's
  pages look like YouTube's own, in its sizes, measured on youtube.com: its font, Roboto, and its colors; its top bar,
  which stays at the top as a page scrolls and from page to page, with a way up (from a video to its channel, from a
  Short to its channel's Shorts, from a channel to the channels), its logo (the very one its site shows) and its search
  box; its pills, chips, tabs and tooltips; its grids of covers, with the views by its play sign and how long ago the
  short way (▷ 48K • 3d ago, as YouTube's lists write them now), the blue that comes round a card under the mouse, and
  the white "New" on a video out less than a week beside another; its watch page, its Shorts' player, its channel's
  About box and its Share box; and its red line along the top while the next page is on its way. Telegram's look like
  Telegram Web's (web.telegram.org/a, measured there) as it looks on the visitor's device, which the browser's name
  tells: in Roboto, or in the system's font and Apple's sizes on a Mac or an iPhone. Its default wallpaper (its four
  colors blended as Telegram draws them, without its pattern) lies under its floating panels, with its corners rounder
  at the ends where the browser can draw them (squircles): the chat list at the left, with its ☰ (the site's menu) and
  its search field, its folders on a floating bar (the biggest channels, and the latest to post), and its rows, each
  with its latest message and when, the open chat's blue; a chat's top bar floating over it, which, as the chat, takes
  the chat's whole width, as in Telegram's desktop app (Telegram Web's keeps its chat to a column in the middle), its
  bubbles at its left, in groups with their tails, its links as Telegram shows them (one hidden behind words as the
  words), its dates, which stay at the top while it scrolls and fade once it stops, and its round button back down to
  the newest messages; and its info panel, beside the chat or over it. A click ripples as in Telegram, and dates are
  Telegram's words (14:05, Mon, Oct 9 in the list; Today, Yesterday, Thursday, October 9 over the messages).
- Every page but `/sign-in` needs someone signed in. Before a page loads, `src/proxy.ts` asks the API who's signed in
  and answers with a plain redirect: to `/sign-in` (and back afterwards), to `/change-password` for a temporary
  password, or on from `/sign-in` for someone signed in already. It does this before the page, because a redirect from
  inside a page comes after Next has begun sending it: a 200, followed only by the browser's scripts. The site's server
  passes the visitor's session cookie on to the API (`src/lib/api-server.ts`).
- Admins have a menu at the side (shadcn's sidebar) and no bar above the page, which takes the window's whole width
  (each page keeps its own: the activity 1,280 px at most, a YouTube channel's page 1,284 px as YouTube's): the
  activity, YouTube and Telegram, and at its foot who's signed in, with the language and signing out. On a wide screen
  it's a strip 79 px wide, always there, as YouTube's narrow menu: each item a square of 70 px, its icon (24 px) with
  its name under it. On a phone it slides in over the page, where a thin bar opens it (on YouTube's pages, the ☰ in
  YouTube's top bar; on Telegram's, the ☰ over the chat list, which a wide screen doesn't show: there, only a search's ←
  comes in beside the field).
- Anything in a list (a channel, a video, a run) opens its page wherever it's clicked, not only on its name; a Ctrl- or
  middle-click opens it in a new tab, as a link does.
- YouTube's channel list keeps its search, order and page in the address, so Back, Forward and a copied link bring it
  back. Its grid fills the screen and no more, so its page's buttons are always in view: a page holds as many channels
  as fit (36 on a 2000 × 1200 window, 4 on a phone), so the browser asks for them itself, once it has measured the grid.
  Its pages have a button to the one before and the next, and ← and → turn them. They change the address through the
  browser's history rather than by loading the page again, and ask the API themselves, through Caddy. "/" goes to the
  search box and Escape empties it. YouTube's search box is in its top bar: on the channels' list it searches them as
  one types; on its other pages it suggests channels as one types, as YouTube suggests searches (↑ and ↓ go through
  them, Enter or a click opens one), and Enter searches the list. A channel's tabs end in YouTube's magnifier, which
  opens a field that searches the channel's videos by their titles as one types (the address keeps it), listed as
  YouTube lists results.
- Telegram's chat list keeps its folder and its search to itself, as Telegram's does: it belongs to the layout of
  Telegram's pages, so it stays, scrolled where it was, as chats open and close. It arrives with the page (the first
  folder's first 50 channels) and loads more as it's scrolled; Escape or ← ends a search. A row's chat is fetched ahead once the pointer comes over it (not for every row in view: dozens of
  requests); a click turns the row blue at once, and the chat follows as soon as it's there. With less than 926 px of room,
  a chat takes it all and ← goes back to the list; with less than 601, the list takes the whole screen too. A chat's
  search (its magnifier, or Ctrl+F) shows only the messages with what's searched in them, marked, and a hashtag searches
  for itself, as in Telegram; Esc closes the search, then the info, then the chat. A click on the channel's link in its
  info copies it, and a message's round button (under the mouse, or always on a touch screen) opens it on Telegram.
- A video plays in its page, in YouTube's own player (its privacy-enhanced address, youtube-nocookie.com), which starts
  it as the page opens: with sound once one has clicked something on the site, as browsers allow. One the player can't
  play here (removed, private, kept from the country it's watched in, not to be played on other sites), a Short too,
  shows the player's own screen in its place, which says why, as YouTube's watch page does: the player tells the page
  only that it can't (the same code, 150, for all of them). The player is as wide as its column but no taller than
  leaves room for the title under it (16:9 of the screen's height less 116 px), as on YouTube, with the next videos
  beside it from 1,000 px of the page's width, and under the description below that (full-width cards on a phone). Its
  controls are the page's own, as YouTube's watch page has them: the red line of where it's at (what's loaded lighter,
  the time under the mouse, a click or a drag takes the video there), play and pause, the next video (the first beside
  it), the sound and its slider, the time, the speed and the full screen, which hide 3 s after the mouse stops while it
  plays; a click plays and pauses, a double click fills the screen, and YouTube's signs come and fade in the middle as
  one plays, pauses, jumps or changes the sound. YouTube's keys work on the page (K or the space bar, J and L, ← and →,
  ↑ and ↓ while the player has the focus, M, F, Shift+N, 0 to 9), times in the description and the comments take the
  player there, and Share gives the video's link, from the second it's at if asked. Next keeps a page one has left
  alive, hidden, for going back to it, so a player is given its address only as its page shows (by an effect, which a
  hidden page doesn't run), never by a page in the background, is unloaded as its page goes (nothing plays unseen), and
  is loaded again on going back, from the second it had got to (which the player tells a page that says it's listening);
  a card's preview is unloaded too. In a channel's grids and beside a video, a video or a Short plays silently in its
  card once the mouse has stayed on it half a second, as on YouTube, until the mouse leaves; a click still opens its
  page. Whatever its address asks, YouTube's player puts its own ⏸ in the middle of the video for about 4 s each time a
  video starts, goes on after a pause, jumps or changes, and a page can't reach into it to hide it (drawn many times as
  big and shrunk back, the player made it too small to see, but Chrome then flashed and crashed). As a playlist of
  itself, its way to play a video round again, it would add ⏮ and ⏭ beside it, so the players here are never playlists:
  the page starts a video again at its end (`src/components/youtube-embed.tsx`).
- A Short opens on its own page, `/youtube/shorts/{id}`, as YouTube's do: a feed that slides up and down, a Short to a
  screen, each upright, as tall as the screen allows, with the channel and the title over its bottom and YouTube's round
  buttons beside it (the comments open their panel, the title the description's), and the next one's top under it. The
  feed is the Short opened, then those after it in the order of the grid it was opened from, as YouTube's is, and it
  loads on as it's scrolled. It's the browser's own scrolling, snapped to one Short at a time (CSS scroll snapping, as
  YouTube's), so the wheel, a two-finger swipe and a finger slide it smoothly, and ↑, ↓ and the arrows at the right
  slide it a Short at a time. The Short the feed comes to rest on plays (its player loaded only once it's at rest, so
  nothing heavy happens while it slides), with the page's own controls over YouTube's player (a click plays and pauses,
  the sound button, the red line that says where it's at); the others show their upright pictures (1080 × 1920), which
  stay until a Short has started, so sliding to it doesn't go black. The address and the tab's title change to the Short
  playing in place, without a step in the history, as YouTube's: Back goes back to where the Shorts were opened from.
  The player is 160 px taller than its frame at each end, so what YouTube puts along them (its title, its logo, a
  Short's like count) falls outside it.
- Going from one page to another, the page stays as it is until the next one is ready, then gives way to it whole, as on
  YouTube; while it's on its way, a line runs along the top of the window (YouTube's red on its pages, Telegram's blue
  on Telegram's, dark grey elsewhere: `src/components/page-link.tsx`), from 120 ms on, so a page that's ready at once
  shows none, and what was clicked shows it at once (the menu's item, a chat's row). There are no grey shapes in
  between: React keeps a loading state (`loading.tsx`) up for at least 300 ms, however quickly the page comes, so with
  them every click turned the page grey for a third of a second. Without them, on the site run locally, a page
  replaced the one before 40 to 75 ms after the click (300 to 370 ms with them); a channel's page that took the API
  390 ms came after the red line, the channel list still there. Back and Forward bring a page back as it was, at once.
- Buttons and tabs inside a page (a channel's tabs and orders, the pages of the channel list and of the activity, the
  activity's steps, Telegram's folders, a Short's comments) don't load the page again, and what each is likely to show
  is asked for ahead, so it's there when it's clicked: the other tab or folder and the pages either side once the page
  is there, an order, a step or a Short's comments once the pointer comes over its button (on a touch screen, as the
  finger touches it). What isn't there yet comes as soon as it is, the list before it staying as it was meanwhile,
  dimmed only from 150 ms on, so one that comes sooner doesn't flash. On the site run locally, with 100 ms added to
  every request, a click showed what it asked for 14 to 31 ms later (116 to 143 ms without asking ahead), and a Short's
  comments, the pointer 250 ms on their button, came with their panel instead of 125 ms after it.
- A search starts at each key, without waiting for the typing to stop. A search a later key has replaced is called off
  in the browser (the API still finishes it), and the last results stay until the new ones come, dimmed from 150 ms on.
  On YouTube's pages the address follows each key without a step in the history (a channel's search makes one as it
  starts and one as it ends). The page has the new address a moment after the key, so a box keeps what it has written
  until the page has caught up, and the page's address never puts back what was typed before
  (`src/lib/use-search-box.ts`). On the site run locally, with 100 ms added to every request and keys 120 ms apart,
  results came 120 to 150 ms after the last key, against about 440 ms when a search waited 300 ms for the typing to
  stop; a channel's videos, YouTube's suggestions and a chat's messages most often came before the last key, an earlier
  one having found the same.
- A channel's videos, a video's comments, Telegram's chat list and a channel's messages load more as they're scrolled,
  as on YouTube and in Telegram, 50 at a time: the page arrives with the first 50. Telegram's chat opens at the newest
  message, at the bottom, and loads older ones above as it's scrolled up.
- Counts in lists are cut short, as YouTube and Telegram write them (2.19M subscribers, 48K views), with the exact
  number on hover; times are how long ago (3 h ago, 2 days ago; in YouTube's lists 3d ago, 3 дн. назад, as YouTube's
  lists write them), with the exact time on hover. How long ago is counted in the browser: Next won't let the server
  read the clock while it prerenders a page, so the server writes the date and the browser turns it into how long ago.
- The activity, the home page (`/`), has how much the database holds, then the runs as the API gives them, one step's
  alone with its list of steps, a page at a time (the address keeps the step and the page: `/?step=…&page=…`;
  `/activity`, where they used to be, sends there with them), and a page for each run (`/activity/{id}`) with every
  number it kept: its items' outcomes, its requests and proxy tests by outcome, its proxies; for `uv run proxies`, a row
  per list. A step's texts are looked up by its name as the table has it (`activity.steps` in the messages), and so are
  its outcomes' names; one without a text shows as it is. The runs' first page, and any page with a run going, are asked
  for again every 5 s. How long a run has been going is counted to its last update, not to the browser's clock, so the
  server's page and the browser's agree.
- Channel pictures come from YouTube's image server at twice the size shown (192 px in the grid), not at the 900 px
  saved (114 KB), and Telegram's from its own, at the one size its pages give, 160 px (10 KB). Video covers come from
  YouTube's image server, loaded as they scroll into view: 640 × 480 (27 KB as WebP) in a channel's grids, or 480 × 360
  for a video that hasn't got the bigger one (YouTube answers with a 120 × 90 grey picture instead), and 480 × 360
  beside a video; a Short's is its upright picture, cut out of those. Next's image optimizer would fetch them through
  the site's server, which can't reach the internet. A picture that doesn't load leaves a figure (YouTube) or the
  channel's first letter on Telegram's colors (Telegram).
- Dates and times are Tashkent's (UTC+5, the same all year), written by the site's own function (`src/lib/format.ts`),
  for the same reason as counts. A comment's time is only as precise as YouTube's wording: 16.10.2026, 14:05 for
  minutes, 16.10.2026, ≈14:00 for hours, ≈16.10.2026 for days and weeks, ≈10.2026 for months, ≈2025 for years.
- A visitor sees Russian until choosing Uzbek (Latin script) or English (in the menu's foot, or in the header of the
  sign-in page); the choice is kept in a cookie for a year and, for someone signed in, in their account. Signing in
  keeps a language this browser chose before (and saves it to the account); without one, it switches to the account's.
  Addresses are the same in every language, since search engines see nothing but the sign-in page.
- Counts are written by the site's own function (`src/lib/format.ts`), not the browser's `Intl`: Chrome's Uzbek data
  writes 55,859 where Node's writes 55 859, and the browser would rewrite what the server rendered.
- The texts are in `web/messages/` (`ru.json`, `uz.json`, `en.json`): a key missing from one, or asked for by a page but
  not there, fails the typecheck. The activity's runs are only in English, whatever the language chosen, their numbers,
  dates and times too: their texts are only in `en.json`, and the runs and a run's page have an English frame of their
  own (`EnglishOnly`). Its name, Activity, is English in every language's file too; the database's numbers above the
  runs are in the language chosen.
- The font is Inter, Roboto on YouTube's pages, and Telegram Web's on Telegram's (Roboto, or the system's on Apple's
  devices): Geist, Next's and shadcn's own, has no `ʻ`, which Uzbek writes oʻ and gʻ with; these have it.
- `web/src/api/` is the API's client, generated from `openapi.json` (`pnpm api`), so an endpoint or a field the API
  doesn't have fails the typecheck. Requests are built on one placeholder address, `http://api`, on the server and in
  the browser alike, and sent on from it: TanStack Query's keys include that address, and they must match for the
  browser to reuse what the server loaded.
- While rendering, the server waits at most 3 s for the API and doesn't ask again. In the browser, a failed request is
  asked again twice (unless it was wrong), a request waits at most 15 s, and the home page's counts refresh every 30 s.
- A failed request shows a message in the visitor's language, its ID (the one in the API's and Caddy's logs) and a
  button to ask again. A missing page gets a 404 page, a page that fails while rendering gets an error page with its
  code, and if the frame itself fails, a last page says so in all three languages.

## Deploying

`./deploy.sh` installs the clone's current commit in a new release folder, `/opt/media-monitoring/releases`, and
builds the site there; if that fails, what runs isn't touched. Then it points `/opt/media-monitoring/current` at the
release, restarts both services, and checks that they answer within 30 s, or goes back to the release before. It
keeps 3 releases, about 92 MB each (packages are hard-linked from uv's and pnpm's stores), and takes about 27 s.
Building in place would change files the running site serves; a new folder also leaves the one before to go back to.

Python is in `/opt/media-monitoring/python` because the services' users can't read `/root`, where uv puts it. The
services start with the machine and come back 2 s after they stop. The site runs as `media_monitoring_web`, which has
no access to the database. systemd locks both down: the system is read-only to them, they can't see `/root` or
`/home` or gain privileges, and they can reach nothing but this machine (`systemd-analyze security`: 1.1 of 10).

## Caddy

- The certificate is Let's Encrypt's, for the IP address itself; those last about 6 days, and Caddy renews them. With a
  domain, the domain takes the address's place in `deploy/Caddyfile`.
- `http://` goes on to `https://`. Answers are compressed and carry security headers: HTTPS only, no framing by other
  sites, no guessing of content types.
- On the server itself the same site answers on http://127.0.0.1:8080, for checks.
- Caddy comes from its own apt repository, not a pinned version: it faces the internet, so its security fixes come with
  `apt upgrade`.

## Versions

Each package is its newest stable release at least a day old (pnpm holds back newer ones, since a hijacked release is
usually pulled within hours), pinned exactly. TypeScript is 6, not 7, which the lint rules' TypeScript support doesn't
cover; ESLint is 10 although Next's lint plugins list only 9, which is no longer supported, and their rules work the
same on it.
