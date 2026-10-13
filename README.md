# Media monitoring

Monitors the YouTube channels listed in `channels.txt`: finds their new videos, fetches the videos' details, keeps
their views and likes up to date, and collects their comments, all into PostgreSQL. Requests go through thousands of
free VPN configs and proxies, so it works as fast as the server allows.

## Running it

On a Debian or Ubuntu machine, as root or as a user with sudo:

```bash
./run.sh
```

At every start it sets the machine up if needed: PostgreSQL 18, sing-box, uv with Python and the packages, the
database and its tables, and the channels from `channels.txt`. Then it runs a round every 15 minutes: fresh
proxies, then each collector in turn.

```bash
ROUND_MINUTES=30 DAYS=30 ./run.sh   # a round every 30 minutes; views, likes and comments for the last 30 days
./run.sh setup                      # only set the machine up
```

## The steps

Each step can also run on its own, while `singbox-runner` runs:

| Command | What it does |
|---|---|
| `uv run channels` | refreshes every channel's name, handle, description, picture and subscriber count |
| `uv run videos` | finds new videos in each channel's uploads list (a channel's first run reads its whole history) |
| `uv run details` | fetches the title, description and upload day of videos that don't have them yet |
| `uv run stats [days\|all]` | refreshes views and likes (videos from the last 90 days by default) |
| `uv run comments [days\|all\|unread]` | collects new comments (videos from the last 90 days by default) |
| `uv run vpn-configs` | downloads the public lists of VPN configs |
| `uv run plain-proxies` | downloads the public lists of free proxies |
| `uv run singbox-runner` | runs the VPN configs as local proxies |
| `uv run check-vpn` | reports which VPN lists work best (optional) |

The database is `media_monitoring`; set `DATABASE_URL` to use another.

## Layout

```
run.sh                  sets the machine up and runs the rounds
channels.txt            the channels to monitor, one ID per line
schema.sql              the database tables
src/media_monitoring/
    youtube.py          InnerTube, the API behind YouTube's website
    pool.py             the proxy pool every request goes through
    parallel.py         runs a collector across processes
    db.py               the database connection
    collectors/         channels, videos, details, stats, comments
    proxies/            VPN configs, sing-box, free proxies
docs/                   how it works and why
data/                   downloaded and generated files (not in git)
```

How it works, and why it's built this way: [docs/monitoring-plan.md](docs/monitoring-plan.md) and
[docs/proxies-plan.md](docs/proxies-plan.md).
