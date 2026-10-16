#!/bin/bash
# Set this machine up if needed, then run one monitoring round: fresh proxies (new VPN configs for sing-box, and new
# plain proxies), then YouTube's steps in order: channel details, new videos, video details, views and likes, and
# comments; then Telegram's new messages. Run it again for the next round, for example every 15 minutes from cron (see
# README.md). Started while a round is still running, it skips its own.
#
#   ./run.sh              one round, through the VPN proxies; views, likes and comments for the last 365 days
#   DAYS=30 ./run.sh      the same for the last 30 days
#   ./run.sh setup        only set the machine up
#
# On a fresh Debian or Ubuntu machine it installs what's missing (PostgreSQL 18, sing-box, uv, Python and the
# packages, and Node.js and pnpm for the website), creates the database, its tables, the web API's user, which can
# only read them, and the website's user, and loads the channels to monitor from channels.txt (any file with channel
# IDs in it, like a CSV export; new IDs are added at every start). Run it as root or as a user with sudo. It
# (re)starts sing-box in the background with "uv run proxies" and stops it when the round ends, or on Ctrl+C or kill.
# Downloaded and generated files (proxy lists, sing-box configs and logs) go in data/. The website and its API are
# deployed with deploy.sh.
set -u
cd "$(dirname "$0")"
DAYS=${DAYS:-365}
DATABASE=media_monitoring
API_USER=media_monitoring_api  # the web API's user, on this machine and in PostgreSQL
WEB_USER=media_monitoring_web  # the website's user, on this machine only (see deploy.sh)
SING_BOX_VERSION=1.14.3  # the version the VPN configs were tested with
NODE_VERSION=26.12.0  # Node.js and pnpm, for the website (web/)
PNPM_VERSION=12.14.0
# Where uv and sing-box install themselves; cron's PATH has neither
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
only_setup=""
for argument in "$@"; do
    case "$argument" in
        setup) only_setup=1 ;;
        *) echo "run.sh: unknown argument $argument (see the top of run.sh)"; exit 1 ;;
    esac
done

# One at a time: a second round (started by hand, or by cron while a long round still runs) would restart sing-box
# under the first one, and the first one's end would stop the second one's sing-box
mkdir -p data
exec 9> data/run.lock
if command -v flock > /dev/null && ! flock -n 9; then
    echo "run.sh: a round is already running here, so this one is skipped"
    exit 0
fi

if [ "$(id -u)" -eq 0 ]; then sudo=""; else sudo="sudo"; fi

as_postgres() {
    # Run a command as PostgreSQL's own user, from a folder it may enter
    if [ -z "$sudo" ]; then (cd / && runuser -u postgres -- "$@"); else (cd / && sudo -u postgres "$@"); fi
}

setup() {
    # System packages: PostgreSQL 18 comes from PostgreSQL's own repository (Ubuntu's is older; the tables need 18)
    if ! command -v curl > /dev/null || ! psql --version 2> /dev/null | grep -q " 18\."; then
        command -v apt-get > /dev/null || { echo "setup: this needs a Debian or Ubuntu machine (apt-get)"; exit 1; }
        echo "### installing curl and PostgreSQL 18"
        $sudo apt-get update -q
        $sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -q curl ca-certificates postgresql-common
        $sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y > /dev/null
        $sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -q postgresql-18
    fi

    # sing-box, which turns the VPN configs into local proxies
    if ! command -v sing-box > /dev/null; then
        echo "### installing sing-box $SING_BOX_VERSION"
        case "$(uname -m)" in aarch64 | arm64) arch=arm64 ;; *) arch=amd64 ;; esac
        name="sing-box-$SING_BOX_VERSION-linux-$arch"
        folder=$(mktemp -d)
        curl -fsSL "https://github.com/SagerNet/sing-box/releases/download/v$SING_BOX_VERSION/$name.tar.gz" |
            tar -xz -C "$folder"
        $sudo install -m 755 "$folder/$name/sing-box" /usr/local/bin/sing-box
        rm -rf "$folder"
    fi

    # Node.js, from nodejs.org and checked against the checksums it publishes, into /usr/local; then pnpm through it
    if [ "$(node --version 2> /dev/null)" != "v$NODE_VERSION" ]; then
        echo "### installing Node.js $NODE_VERSION"
        case "$(uname -m)" in aarch64 | arm64) arch=arm64 ;; *) arch=x64 ;; esac
        name="node-v$NODE_VERSION-linux-$arch"
        folder=$(mktemp -d)
        curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$name.tar.gz" -o "$folder/$name.tar.gz"
        if ! curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | grep " $name.tar.gz\$" |
                (cd "$folder" && sha256sum -c --quiet -); then
            echo "setup: the Node.js download doesn't match its checksum"
            exit 1
        fi
        $sudo tar -xzf "$folder/$name.tar.gz" -C /usr/local --strip-components=1 --no-same-owner \
            --exclude="$name/CHANGELOG.md" --exclude="$name/LICENSE" --exclude="$name/README.md"
        rm -rf "$folder"
    fi
    if [ "$(pnpm --version 2> /dev/null)" != "$PNPM_VERSION" ]; then
        echo "### installing pnpm $PNPM_VERSION"
        $sudo npm install --global --no-fund --no-audit --no-update-notifier --loglevel=error "pnpm@$PNPM_VERSION" \
            > /dev/null
    fi

    # Caddy, in front of the website and its API (deploy/Caddyfile, which deploy.sh installs), from Caddy's own signed
    # apt repository: it faces the internet, so its security fixes come with "apt upgrade" rather than a version pinned
    # here. It's left stopped until deploy.sh configures it.
    if ! command -v caddy > /dev/null; then
        echo "### installing Caddy"
        keyring=/usr/share/keyrings/caddy-stable-archive-keyring.gpg
        curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | $sudo gpg --dearmor --yes -o "$keyring"
        curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt |
            $sudo tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null
        $sudo chmod o+r "$keyring" /etc/apt/sources.list.d/caddy-stable.list
        $sudo apt-get update -q
        $sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -q caddy
        $sudo systemctl stop caddy
    fi

    # uv, and through it Python and the packages in uv.lock
    if ! command -v uv > /dev/null; then
        echo "### installing uv"
        curl -LsSf https://astral.sh/uv/install.sh | sh > /dev/null
    fi
    uv sync --frozen -q

    # The database: a role for this user, the database and its tables
    pg_isready -q || $sudo systemctl start postgresql 2> /dev/null || $sudo service postgresql start
    me=$(whoami)
    if [ "$(as_postgres psql -Atc "SELECT 1 FROM pg_roles WHERE rolname = '$me'")" != 1 ]; then
        as_postgres createuser "$me"
    fi
    if [ "$(as_postgres psql -Atc "SELECT 1 FROM pg_database WHERE datname = '$DATABASE'")" != 1 ]; then
        echo "### creating the database $DATABASE"
        as_postgres createdb -O "$me" "$DATABASE"
    fi
    psql -q -v ON_ERROR_STOP=1 -d "$DATABASE" -f schema.sql

    # The web API's user: a system user without a password, shell or home, and a database user of the same name,
    # which PostgreSQL lets it in as without a password. It can read every table, including ones added later, and
    # change nothing.
    if ! id -u "$API_USER" > /dev/null 2>&1; then
        echo "### creating $API_USER, the web API's user, which can only read the database"
        $sudo useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$API_USER"
    fi
    if [ "$(as_postgres psql -Atc "SELECT 1 FROM pg_roles WHERE rolname = '$API_USER'")" != 1 ]; then
        as_postgres createuser "$API_USER"
    fi
    psql -q -v ON_ERROR_STOP=1 -d "$DATABASE" -c "GRANT CONNECT ON DATABASE $DATABASE TO $API_USER" \
        -c "GRANT USAGE ON SCHEMA public TO $API_USER" -c "GRANT SELECT ON ALL TABLES IN SCHEMA public TO $API_USER" \
        -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO $API_USER"

    # The website's user: a system user without a password, shell or home, and no access to the database
    if ! id -u "$WEB_USER" > /dev/null 2>&1; then
        echo "### creating $WEB_USER, the website's user"
        $sudo useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$WEB_USER"
    fi

    # Settings for heavy writing, set once: a quarter of the memory as PostgreSQL's cache (at most 16 GB), a
    # checkpoint every 30 minutes or 64 GB of write log, and a compressed write log. The cache needs a restart.
    cache=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 4096 ))  # MB
    if [ "$cache" -gt 16384 ]; then cache=16384; fi
    if [ "$(psql -d "$DATABASE" -Atc "SELECT setting::bigint / 128 FROM pg_settings WHERE name = 'shared_buffers'")" \
         -lt "$cache" ]; then
        echo "### tuning PostgreSQL for heavy writing (a ${cache} MB cache) and restarting it"
        as_postgres psql -q -c "ALTER SYSTEM SET shared_buffers = '${cache}MB'" \
            -c "ALTER SYSTEM SET max_wal_size = '64GB'" -c "ALTER SYSTEM SET checkpoint_timeout = '30min'" \
            -c "ALTER SYSTEM SET wal_compression = 'zstd'"
        $sudo systemctl restart postgresql 2> /dev/null || $sudo service postgresql restart
        until pg_isready -q; do sleep 1; done
    fi

    # The channels to monitor: the IDs in channels.txt (ones already in the database are skipped)
    if [ -f channels.txt ]; then
        grep -o 'UC[A-Za-z0-9_-]\{22\}' channels.txt | sort -u |
            psql -q -v ON_ERROR_STOP=1 -d "$DATABASE" -c "CREATE TEMP TABLE listed (channel_id text)" \
                -c "\copy listed from pstdin" \
                -c "INSERT INTO youtube_channels (channel_id) SELECT channel_id FROM listed ON CONFLICT DO NOTHING"
    fi
    channels=$(psql -d "$DATABASE" -Atc "SELECT count(*) FROM youtube_channels")
    if [ "$channels" -eq 0 ]; then
        echo "setup: no channels to monitor yet: put their IDs in channels.txt (one per line, or any CSV export)"
        exit 1
    fi

    # Proxy checks open many connections at once: let the kernel's connection tracking (if it's on) hold them
    tracking=/proc/sys/net/netfilter/nf_conntrack_max
    if [ -f "$tracking" ] && [ "$(cat "$tracking")" -lt 4194304 ]; then
        echo "net.netfilter.nf_conntrack_max = 4194304" | $sudo tee /etc/sysctl.d/90-media-monitoring.conf > /dev/null
        $sudo sysctl -q -p /etc/sysctl.d/90-media-monitoring.conf || true
    fi
    echo "### set up: $channels channels to monitor"
}

setup
if [ -n "$only_setup" ]; then
    exit 0
fi

trap 'uv run proxies stop > /dev/null' EXIT  # also after Ctrl+C or kill
trap 'exit 130' INT
trap 'exit 143' TERM

started=$(date +%s)
echo "### $(date -u '+%F %T') round"
if ! uv run proxies > data/proxies.log 2>&1; then
    tail -3 data/proxies.log
    echo "### the proxies didn't start"
    exit 1
fi
tail -2 data/proxies.log | head -1
for step in "youtube channels" "youtube videos" "youtube details" "youtube stats $DAYS" "youtube comments $DAYS" \
            "telegram messages"; do
    echo "### $(date -u +%T) $step"
    uv run $step 9>&-  # without the lock: a step left running after the round can't hold up the next ones
done
echo "### $(date -u +%T) round done in $(( $(date +%s) - started )) s"
