#!/bin/bash
# Set this machine up if needed, then run one monitoring round: fresh proxies (new VPN configs for sing-box), then
# the collectors in order: channel details, new videos, video details, views and likes, and comments. Run it again
# for the next round, for example every 15 minutes from cron (see README.md).
#
#   ./run.sh              one round, through the VPN proxies; views, likes and comments for the last 90 days
#   DAYS=30 ./run.sh      the same for the last 30 days
#   ./run.sh --plain      video pages and comments also go through fresh free proxies (plain-proxies)
#   ./run.sh setup        only set the machine up
#
# On a fresh Debian or Ubuntu machine it installs what's missing (PostgreSQL 18, sing-box, uv, Python and the
# packages), creates the database and its tables, and loads the channels to monitor from channels.txt (any file
# with channel IDs in it, like a CSV export; new IDs are added at every start). Run it as root or as a user with
# sudo. It starts its own sing-box (stop any other singbox-runner first) and stops it when the round ends, or on
# Ctrl+C or kill. Downloaded and generated files (proxy lists, sing-box configs and logs) go in data/.
set -u
cd "$(dirname "$0")"
DAYS=${DAYS:-90}
DATABASE=media_monitoring
SING_BOX_VERSION=1.14.3  # the version the VPN configs were tested with
RUNNER_LOG=data/singbox/runner.log
# Where uv and sing-box install themselves; cron's PATH has neither
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
runner=""
only_setup=""
plain=""  # "--plain" for the steps that read YouTube's next endpoint (details, comments)
for argument in "$@"; do
    case "$argument" in
        setup) only_setup=1 ;;
        --plain) plain="--plain" ;;
        *) echo "run.sh: unknown argument $argument (see the top of run.sh)"; exit 1 ;;
    esac
done

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

stop_singbox() {
    if [ -n "$runner" ]; then
        kill -TERM -- "-$runner" 2> /dev/null  # its whole process group: uv, the runner and every sing-box
        while kill -0 "$runner" 2> /dev/null; do sleep 1; done
        runner=""
    fi
}

start_singbox() {
    mkdir -p data/singbox
    setsid uv run singbox-runner > "$RUNNER_LOG" 2>&1 < /dev/null &
    runner=$!
    # Ready once the local proxies are saved, even if a group of configs failed to start. If the runner ends
    # before that, none started (e.g. another singbox-runner holds the ports).
    until grep -q "local proxies saved" "$RUNNER_LOG" 2> /dev/null; do
        if ! kill -0 "$runner" 2> /dev/null; then
            tail -3 "$RUNNER_LOG"
            return 1
        fi
        sleep 1
    done
    tail -1 "$RUNNER_LOG"
}

setup
if [ -n "$only_setup" ]; then
    exit 0
fi

trap stop_singbox EXIT  # also after Ctrl+C or kill
trap 'exit 130' INT
trap 'exit 143' TERM

started=$(date +%s)
echo "### $(date -u '+%F %T') round"
uv run vpn-configs | tail -1
if [ -n "$plain" ]; then
    uv run plain-proxies | tail -1
fi
if ! start_singbox; then
    echo "### sing-box didn't start"
    exit 1
fi
for step in "channels" "videos" "details $plain" "stats $DAYS" "comments $DAYS $plain"; do
    echo "### $(date -u +%T) $step"
    uv run $step
done
echo "### $(date -u +%T) round done in $(( $(date +%s) - started )) s"
