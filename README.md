# Media monitoring

Monitors the YouTube channels listed in `channels.txt`: finds their new videos, fetches the videos' details, keeps
their views and likes up to date, and collects their comments, all into PostgreSQL. Requests go through thousands of
free VPN configs and proxies, so it works as fast as the server allows.

## Running it

On a Debian or Ubuntu machine, as root or as a user with sudo:

```bash
./run.sh
```

It sets the machine up if needed: PostgreSQL 18, sing-box, uv with Python and the packages, the database and its
tables, and the channels from `channels.txt`. Then it runs one round: fresh VPN proxies, then each collector in turn.

```bash
DAYS=30 ./run.sh   # views, likes and comments for the last 30 days (90 by default)
./run.sh --plain   # video pages and comments also go through fresh free proxies
./run.sh setup     # only set the machine up
```

To keep the data up to date, run it again and again: for example every 15 minutes from cron (`crontab -e`), where
`flock` skips a round while the last one is still running:

```
*/15 * * * * cd /path/to/media-monitoring && flock -n /tmp/media-monitoring.lock ./run.sh >> run.log 2>&1
```

## The steps

Each step can also run on its own, while `singbox-runner` runs. Every step goes through the VPN proxies; add
`--plain` to also use the free proxies from `plain-proxies` (like `uv run comments 90 --plain`). They're many more
addresses, which helps `details` and `comments`, since their endpoint blocks busy addresses for a while.

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
| `uv run check-plain` | reports which free proxy lists work best, with a video page (optional) |

The database is `media_monitoring`; set `DATABASE_URL` to use another.

## Layout

```
run.sh                  sets the machine up and runs a round
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

How it works, and why it's built this way: [docs/monitoring.md](docs/monitoring.md) and
[docs/proxies.md](docs/proxies.md).
