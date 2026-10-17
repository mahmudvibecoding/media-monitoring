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
- The counts are PostgreSQL's own running count of each table's rows: reading it takes a millisecond, while counting
  the rows takes 0.15 s for Telegram messages and minutes for the 194 million comments.
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

`/api/youtube/channels` gives admins 50 channels at a time, the biggest first or by name, and how many match; with
`search`, those whose name or handle has it in them. Through Caddy, a search takes about 13 ms, the first page 41 ms
(counting all 55,859 channels) and a search for a single letter 60 ms:
- Each channel's name and handle are kept searchable in a column of their own, `search_text`: in lowercase, and without
  apostrophes, which Uzbek writes oʻ and gʻ with in seven ways (Zo'r, Zoʻr, Zo‘r...), so that zor, zo'r and zoʻr find
  the same 442 channels. PostgreSQL brings it up to date as the collectors change them. A trigram index (pg_trgm) finds
  any part of it. Worked out during each search instead, it took 0.5 s for a search the index can't narrow down, like
  one letter.
- By name is alphabetical as people read it (ICU, with spaces, punctuation, symbols and currency signs passed over): the
  database's own order is by character codes, Zebra before apple, and many names start with spaces, 👤 or £.
- A page's channels are picked from its order's index alone, which holds their IDs and the search column, and only those
  50 are read from the table: a page far down takes milliseconds, not the 0.4 s of reading and sorting every channel.
  The page and the count are asked for at the same time, on two connections.
- `app.sql` has the column, the indexes and the order (`app.names`), so a deploy makes them: 3 s the first time, nothing
  after.

A channel's page asks for two things. `/api/youtube/channels/{id}` is the channel's details, with how many of its videos
there are of each kind: counting them takes a few milliseconds for most channels (40 videos, the median), and 50 ms for
the one with the most (20,176). `/api/youtube/channels/{id}/videos` is a page of its videos, newest first: the
collectors' own index, by channel and day, gives them in that order, so a page takes about 15 ms through Caddy even for
that channel, and one 400 pages down 100 ms. The videos aren't counted again for each page, which would add those 50 ms
to every page; the site takes their number from the channel's details.

A video's page asks for two things too. `/api/youtube/videos/{id}` is its details and how many of its comments have been
collected (YouTube's own count has the replies too, which aren't). `/api/youtube/videos/{id}/comments` is a page of its
comments, newest first: most videos have a few (5, the median), and theirs take milliseconds, but a video's comments are
sorted by their time on each request, so the video with the most, 128,669, takes 0.3 s for the first page and 0.75 s for
the last. YouTube says only how long ago a comment was written ("2 months ago"), which the collector counted back from
when it read it; the API also gives the unit it was said in, and whether the comment was edited.

### Telegram

`/api/telegram/channels` lists the Telegram channels the way YouTube's are listed: a search column and its trigram
index, an index for each order holding the search column, the page picked from the index alone, all in `app.sql`. Its
orders are the biggest first, by name, and the latest to post first; by name, the names without a letter or a digit come
after the rest, as 3,466 channels are called ".", "-" or an emoji. Without a search, how many there are is PostgreSQL's
running count, as on the overview: counting the 310,431 channels takes 80 ms each time. `/api/telegram/channels/{id}` is
a channel's details, with how many of its messages have been saved, and `/api/telegram/channels/{id}/messages` a page of
its messages, newest first, by the messages table's key: a few milliseconds, even for the channel with the most.

## The site

- Next.js 16 and React 19 in TypeScript, with shadcn/ui's components on Base UI.
- Every page but `/sign-in` needs someone signed in. Before a page loads, `src/proxy.ts` asks the API who's signed in
  and answers with a plain redirect: to `/sign-in` (and back afterwards), to `/change-password` for a temporary
  password, or on from `/sign-in` for someone signed in already. It does this before the page, because a redirect from
  inside a page comes after Next has begun sending it: a 200, followed only by the browser's scripts. The site's server
  passes the visitor's session cookie on to the API (`src/lib/api-server.ts`).
- Admins have a menu at the side (shadcn's sidebar): the overview, then each kind of collected data. It folds down to
  its icons, which it remembers in a cookie, and slides in over the page on a phone.
- The lists keep their search, order and page in the address, so Back, Forward and a copied link bring them back. They
  change the address through the browser's history rather than by loading the page again, and ask the API themselves,
  through Caddy; the server renders a list only when the page is loaded. A search starts 300 ms after the last key, and
  the last list stays, dimmed, while the next one loads.
- Channel pictures come from YouTube's image server at 88 px (8 KB each), not at the 900 px saved (114 KB).
- Video covers come from YouTube's image server at 320 × 180 (15 KB), loaded as they scroll into view: Next's image
  optimizer would fetch them through the site's server, which can't reach the internet.
- Dates and times are Tashkent's (UTC+5, the same all year), written by the site's own function (`src/lib/format.ts`),
  for the same reason as counts. A comment's time is only as precise as YouTube's wording: 16.10.2026, 14:05 for
  minutes, 16.10.2026, ≈14:00 for hours, ≈16.10.2026 for days and weeks, ≈10.2026 for months, ≈2025 for years.
- A visitor sees Russian until choosing Uzbek (Latin script) or English in the header; the choice is kept in a cookie
  for a year and, for someone signed in, in their account. Signing in keeps a language this browser chose before (and
  saves it to the account); without one, it switches to the account's. Addresses are the same in every language,
  since search engines see nothing but the sign-in page.
- Counts are written by the site's own function (`src/lib/format.ts`), not the browser's `Intl`: Chrome's Uzbek data
  writes 55,859 where Node's writes 55 859, and the browser would rewrite what the server rendered.
- The texts are in `web/messages/` (`ru.json`, `uz.json`, `en.json`): a key missing from one, or asked for by a page
  but not there, fails the typecheck.
- The font is Inter: Geist, Next's and shadcn's own, has no `ʻ`, which Uzbek writes oʻ and gʻ with.
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
