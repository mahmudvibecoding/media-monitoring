# Media monitoring

Monitors the YouTube channels listed in `channels.txt`: finds their new videos, fetches the videos' details, keeps
their views and likes up to date, and collects their comments, all into PostgreSQL. Requests go through thousands of
free VPN configs and plain proxies, so it works as fast as the server allows. It also collects the text messages of
public Telegram channels, and keeps their details up to date, from their public pages.

## Running it

On a Debian or Ubuntu machine, as root or as a user with sudo:

```bash
./run.sh
```

It sets the machine up if needed: PostgreSQL 18, sing-box, uv with Python and the packages, the database and its
tables, and the channels from `channels.txt`. Then it runs one round: fresh VPN proxies, then each of YouTube's
steps in turn, then Telegram's new messages.

```bash
DAYS=30 ./run.sh   # views, likes and comments for the last 30 days (365 by default)
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
plain proxies are many more addresses. `uv run telegram channels` isn't part of a round. Ctrl+C or `kill` stops a
step early: it saves what it has collected first, and the rest continues next run. `uv run youtube` or `uv run
telegram` alone lists the steps.

| Command | What it does |
|---|---|
| `uv run youtube channels` | refreshes every channel's name, handle, description, picture and subscriber count |
| `uv run youtube videos` | finds new videos in each channel's uploads list (a channel's first run reads its whole history) |
| `uv run youtube details [all]` | fetches the original title and description, exact publish time, length and kind (video or Short) of new videos (`all`: again for saved videos without an exact publish time) |
| `uv run youtube stats [days\|all]` | refreshes views and likes (videos from the last 365 days by default) |
| `uv run youtube comments [days\|all\|unread]` | collects new comments (videos from the last 365 days by default) |
| `uv run telegram channels` | refreshes every Telegram channel's title, description and subscriber count from its public page, and notes its newest message the first time |
| `uv run telegram messages` | reads every Telegram channel's new messages, and keeps those with text |
| `uv run proxies` | downloads VPN configs and plain proxies, and restarts sing-box with them in the background |
| `uv run proxies stop` | stops sing-box |
| `uv run proxies check [vpn\|plain]` | reports how many proxies work, by protocol or type and by list (optional) |

The database is `media_monitoring`; set `DATABASE_URL` to use another.

## The API

`uv run api` serves the web API on 127.0.0.1:8000, which only the server itself can reach: `/api/health` answers
while it runs, `/api/health/ready` once the database answers too (503 until then), and `/api/docs` lists every
endpoint. Its settings come from environment variables: `API_DATABASE_URL` (`dbname=media_monitoring` by default),
`API_HOST` and `API_PORT`. `uv run ruff check` and `uv run ruff format` check its code and lay it out.

`./run.sh setup` also creates `media_monitoring_api`: a system user, and a database user of the same name that can
read every table but change nothing. PostgreSQL lets that system user in as it without a password.

## Layout

```
run.sh                  sets the machine up and runs a round
channels.txt            the channels to monitor, one ID per line
schema.sql              the database tables
src/media_monitoring/
    commands.py         uv run youtube <step>, uv run telegram <step>
    youtube/            InnerTube, the API behind YouTube's website, and the steps: channels, videos, details,
                        stats, comments
    telegram/           Telegram's public channel pages, and the steps: channels, messages
    pool.py             the proxy pool every request goes through
    parallel.py         runs a step across processes
    db.py               the database connection
    proxies/            VPN configs, sing-box, plain proxies
    api/                the web API: uv run api
docs/                   how it works and why
data/                   downloaded and generated files (not in git)
```

How it works, and why it's built this way: [docs/monitoring.md](docs/monitoring.md) and
[docs/proxies.md](docs/proxies.md).
