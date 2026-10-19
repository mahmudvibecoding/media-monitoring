# Media monitoring

Monitors the YouTube channels listed in `youtube_channels.txt`: finds their new videos, fetches the videos' details,
keeps their views and likes up to date, and collects their comments, all into PostgreSQL. Requests go through
thousands of free VPN configs and plain proxies, so it works as fast as the server allows. It also collects the text
messages of the public Telegram channels in `telegram_channels.txt`, and keeps their details up to date, from their
public pages.

## Running it

On a Debian or Ubuntu machine, as root or as a user with sudo:

```bash
./run.sh
```

It sets the machine up if needed: PostgreSQL 18, sing-box, uv with Python and the packages, Node.js and pnpm for the
website, Caddy, the database and its tables, and the channels from `youtube_channels.txt` and
`telegram_channels.txt`. Then it runs one round: fresh VPN proxies, then each of YouTube's steps in turn, then
Telegram's channel details and new messages.

```bash
DAYS=30 ./run.sh   # views, likes and comments only for the videos of the last 30 days (every video by default)
./run.sh setup     # only set the machine up
```

To keep the data up to date, run it again and again: for example every 15 minutes from cron (`crontab -e`). A round
started while the last one is still running is skipped:

```
*/15 * * * * cd /path/to/media-monitoring && ./run.sh >> run.log 2>&1
```

## The steps

Each step can also run on its own, after `uv run proxies`. Every step goes through the VPN proxies, and brings in
the plain proxies by itself once those stop working, or once it has tested them all and has room for more tests:
YouTube blocks busy addresses for a while on video pages and comments, Telegram hides its pages from them, and the
plain proxies are many more addresses. Ctrl+C or `kill` stops a step early: it saves what it has collected first,
and the rest continues next run. `uv run youtube` or `uv run telegram` alone lists the steps.

| Command | What it does |
|---|---|
| `uv run youtube channels` | refreshes every channel's name, handle, description, picture and subscriber count |
| `uv run youtube videos` | finds new videos in each channel's uploads list (a channel's first run reads its whole history) |
| `uv run youtube details [all]` | fetches the original title and description, exact publish time, length and kind (video or Short) of new videos (`all`: again for saved videos without an exact publish time) |
| `uv run youtube stats [all\|days]` | refreshes views and likes (every video by default; with a number of days, only the videos published in them) |
| `uv run youtube comments [all\|days\|unread]` | collects new comments (every video by default; with a number of days, only the videos published in them) |
| `uv run telegram channels` | refreshes every Telegram channel's title, description, photo and subscriber count from its public page, and notes its newest message the first time |
| `uv run telegram messages` | reads every Telegram channel's new messages, and keeps those with text |
| `uv run telegram history [letters]` | reads back every Telegram channel's older messages, the channels with the fewest letters first, until its saved messages hold 10,000 letters (or the number given) and 100 messages, its first message, or 10,000 messages before its last one |
| `uv run telegram languages` | finds every Telegram channel's main language from its title, description and saved messages, with CLD2 |
| `uv run proxies` | downloads VPN configs and plain proxies, and restarts sing-box with them in the background |
| `uv run proxies stop` | stops sing-box |
| `uv run proxies check [vpn\|plain]` | reports how many proxies work, by protocol or type and by list (optional) |

Every round, every `uv run proxies` and every run of a step leaves its numbers in the `runs` table: when it ran, how it
ended, and what it counted.

The database is `media_monitoring`; set `DATABASE_URL` to use another.

## The API

`uv run api` serves the web API on 127.0.0.1:8000, which only the server itself can reach: `/api/health` answers while
it runs, `/api/health/ready` once the database answers too (503 until then), `/api/status` how many YouTube channels
(with a video), videos and comments and Telegram channels (with a saved message) and messages the database holds, and
`/api/docs` lists every endpoint, for admins. A failure is answered with one JSON shape, `{"error": "<code>", "message":
"...", "request_id": "..."}`, and the HTTP status that fits: a request waits at most 5 s for a database connection (503
after that), and a query runs at most 5 s (504). Every answer carries its request's ID in `X-Request-ID` (the one the
request came with, if any), and every log line is a JSON object, with that ID while a request is answered. Its settings
come from environment variables: `API_DATABASE_URL` (`dbname=media_monitoring` by default), `API_HOST` and `API_PORT`.
`uv run ruff check` and `uv run ruff format` check its code and lay it out.

`uv run api openapi` writes the description `/api/openapi.json` serves admins to `openapi.json`, without starting the
API: every endpoint, its parameters, and the exact JSON of its answers and errors. A change to the API goes into the
same commit as the file, so the change shows in its diff.

`./run.sh setup` also creates `media_monitoring_api`: a system user, and a database user of the same name that can
read the collected data but change none of it. PostgreSQL lets that system user in as it without a password. The
website's own tables (`app.sql`, which `deploy.sh` applies) it may also change.

Accounts are admins or customers. `/api/auth/sign-in` signs in with an email and a password and starts a session in a
cookie; `/api/auth/sign-out`, `/api/auth/me` (who's signed in) and `/api/auth/password` (change one's own) go with it.
There's no signing up: the first admin is added on the server, as root, from the clone:

```bash
uv run api add-admin admin@example.com "Ali Valiyev"   # prints a temporary password, changed at the first sign-in
```

`/api/youtube/channels`, for admins, lists the monitored YouTube channels that have a video collected, the biggest
first, a page at a time (`size`: up to 100 to a page, 50 by default), and how many match; with `search`, only those
whose name or handle has it in them, whatever the case of its letters and apostrophes aside (zor finds Zo‘r). `app.sql`
has the column and the indexes it reads them by. `/api/youtube/channels/{id}` gives a channel's details, with how many
of its videos have been collected, of each kind, and `/api/youtube/channels/{id}/videos` its videos, newest first (or
the most viewed, `sort=popular`, or the oldest, `sort=oldest`), 50 to a page, all of them or only videos (`kind=video`)
or only Shorts (`kind=short`), or those whose titles have a `search` in them, with their views, likes and comments.
`/api/youtube/videos/{id}` gives a video's details, with its channel's picture and subscribers and how many of its
comments have been collected, and `/api/youtube/videos/{id}/comments` its comments, newest first, 50 to a page, each
with when it was written, as precisely as YouTube said it.

`/api/telegram/channels` lists the monitored Telegram channels that have a message saved in the same way, 50 to a page,
the biggest first or the latest to post first (`sort=latest`), searched by name or @username, each with its latest
message; `/api/telegram/channels/{id}` gives a channel's details, with how many of its messages have been saved, and
`/api/telegram/channels/{id}/messages` its messages, newest first, 50 to a page, all of them or those with a `search` in
them.

`/api/runs`, for admins, lists the runs the `runs` table keeps, newest first, 20 to a page: each round with its steps,
and the runs started by hand; with `step`, only that step's runs. `/api/runs/latest` gives the newest round and every
step going now, and `/api/runs/{id}` one run with all its numbers. A run that still says it's running but hasn't said
anything for 5 minutes is given as lost: it was killed outright.

## The website

`web/` is the website: a Next.js app in TypeScript, in Russian, Uzbek and English. In `web/`:

```bash
pnpm install --frozen-lockfile   # the packages, as pnpm-lock.yaml lists them
pnpm build && pnpm start         # build it, then serve it on 127.0.0.1:3000
pnpm dev                         # serve it while working on it, updated on every change
```

`pnpm lint`, `pnpm typecheck` and `pnpm format` (or `pnpm format:check`) check its code and lay it out. Package
versions are pinned exactly, and pnpm only installs releases at least a day old.

Every page but `/sign-in` needs someone signed in: a visitor who isn't goes to `/sign-in`, and back afterwards, and an
account with a temporary password to `/change-password` until it has its own. The site is light and sober, and its
YouTube and Telegram pages look like YouTube's and Telegram's own. Admins have a menu at the side, which folds down to
its icons (Ctrl+B) and slides in on a phone: the overview, with how much the database holds (the channels with something
collected, and every video, comment and message), the last round and what runs now; YouTube's channels with a video
collected, a grid of their pictures, the biggest first, searched as one types, which fills the screen with as many as
fit, whose address keeps the search and the page (← and → turn the pages); Telegram's channels with a message saved, as
Telegram Web's chat list, with their latest messages, in two folders (the biggest, and the latest to post), searched as
one types; and at the bottom the activity, every round with its steps and every run started by hand, newest first, with
their numbers, and a page for each run with all its numbers. YouTube's pages are under YouTube's top bar, whose search
box suggests channels as one types. A YouTube channel's page is laid out like the channel on YouTube, with its About
box, its videos and Shorts in grids, newest, most viewed or oldest first, that load more as they're scrolled, each
playing silently while the mouse stays on it, and its search by title; a video's, like YouTube's watch page, with
YouTube's player and controls drawn by the page as YouTube's, which starts as the page opens and takes YouTube's keys,
its description, its comments, a Share box and more from its channel; a Short's, like YouTube's Shorts, a feed that
slides from one upright Short to the next with the wheel, a two-finger swipe or ↑ and ↓, with the comments and the
description in panels beside it; Telegram's pages look like Telegram Web, its wallpaper under floating panels: the chat
list at the left, and beside it a channel's chat, its messages as bubbles, the newest at the bottom, under their dates,
with its search (which a hashtag starts too) and its info panel. Anything in a list opens wherever it's clicked.
Customers, for now, see a greeting. The menu's foot has the user's name, the language and signing out.

A visitor sees Russian until they choose another language, in the menu's foot (or the sign-in page's header); the choice
is kept in a cookie for a year, and, once they're signed in, in their account, which the site switches to when they sign
in in another browser. The texts are in `messages/` (`ru.json`, `uz.json`, `en.json`), looked up by key: a key missing
from a language, or one a page asks for that isn't there, fails the typecheck. The activity is only in English, its
texts only in `en.json`. The components are shadcn/ui's, on Base UI, kept in `src/components/ui/` as shadcn writes them
(`pnpm exec shadcn add <name>` adds one). The font is Inter, Roboto on YouTube's pages, and Telegram Web's on Telegram's
(Roboto, or the system's on Apple's devices), each with every letter of the three languages, Uzbek's ʻ included; the
site is light only.

The site reads the API through a typed client in `src/api/`, which `pnpm api` writes from `../openapi.json` (run it
after `uv run api openapi`); it isn't edited by hand, and asking for an endpoint or a field the API doesn't have fails
the typecheck. While a page is rendered on the server, requests go straight to the API (`API_URL`,
`http://127.0.0.1:8000` by default); in the browser they go to the site's own `/api/...`, which Next passes on to the
API. TanStack Query loads a page's data on the server, so the page arrives with it, and the browser keeps it fresh:
the home page's counts are asked for again every 30 seconds.

While data loads, gray placeholders in its shape stand in. When a request fails, the page says why in the visitor's
language, from the API's error code (or that the API didn't answer at all), with the request's ID, which the API's
log has too, and a button to ask again. A page rendered on the server waits at most 3 s for the API, and the browser
15 s. An address the site doesn't have gets a 404 page; a page that fails while it's rendered gets an error page with
Next's error code, which the site's log has too; and if the frame itself fails, a last page says so in all three
languages.

## Deploying the website and the API

On the server, as root, from the clone (after `./run.sh setup`):

```bash
./deploy.sh            # deploy this clone's current commit
./deploy.sh rollback   # go back to the release before the running one
```

It installs the commit in a release folder of its own in `/opt/media-monitoring/releases` (the API's packages, and the
site, built), brings the website's own tables up to date (`app.sql`: the accounts, in the schema `app`, and the indexes
the site's pages read the collected data by), points `/opt/media-monitoring/current` at the release, and restarts two
services: `media-monitoring-api` (127.0.0.1:8000) and `media-monitoring-web` (127.0.0.1:3000). They start with the
machine and come back 2 s after they stop. A failed install, build or table update leaves the running release as it is,
a release that doesn't answer within 30 s is replaced by the one before it, and the last 3 are kept. The API runs as
`media_monitoring_api`, which can change the website's own tables but only read the collected data, and the site as
`media_monitoring_web`, which can't reach the database. systemd locks both down: the system is read-only to them, they
can't see `/root` or `/home`, and they can reach nothing but this machine (`systemd-analyze security` rates them 1.1 of
10). Their logs: `journalctl -u media-monitoring-api` and `journalctl -u media-monitoring-web`.

Caddy is in front of both (`deploy/Caddyfile`, which `deploy.sh` installs): the site is at https://198.163.196.164,
with `/api/...` going to the API and everything else to the site, and `http://` sent on to `https://`. Its
certificate comes from Let's Encrypt, for the IP address itself; those last about 6 days, and Caddy renews them.
Answers carry security headers (HTTPS only, no framing by other sites, no guessing of content types), and each request
gets an ID, which the API's log and Caddy's (`journalctl -u caddy`) both show. On the server itself, the same site
answers on http://127.0.0.1:8080, for checks. Once there's a domain, it goes into the Caddyfile in place of the
address. More in [docs/website.md](docs/website.md).

## Layout

```
run.sh                  sets the machine up and runs a round
deploy.sh               deploys the website and the API; deploy/ has their services and Caddy's setup
youtube_channels.txt    the YouTube channels to monitor, one ID per line
telegram_channels.txt   the Telegram channels to monitor, a channel's ID and username on each line
schema.sql              the database tables
app.sql                 the website's own tables (accounts), in the schema app, and its indexes on the collected data
openapi.json            the web API's description: uv run api openapi
src/media_monitoring/
    commands.py         uv run youtube <step>, uv run telegram <step>
    youtube/            InnerTube, the API behind YouTube's website, and the steps: channels, videos, details,
                        stats, comments
    telegram/           Telegram's public channel pages, and the steps: channels, messages, history
    pool.py             the proxy pool every request goes through
    parallel.py         runs a step across processes
    db.py               the database connection
    proxies/            VPN configs, sing-box, plain proxies
    api/                the web API: uv run api
web/                    the website (Next.js): pages in src/app/, texts in messages/, the API's client in src/api/
docs/                   how it works and why
data/                   downloaded and generated files (not in git)
```

How it works, and why it's built this way: [docs/monitoring.md](docs/monitoring.md), [docs/proxies.md](docs/proxies.md)
and, for the website, its API and their deployment, [docs/website.md](docs/website.md).
