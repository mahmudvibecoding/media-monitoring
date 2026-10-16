#!/bin/bash
# Deploy the web API and the website from this clone's current commit, as two services that run as their own users
# and start with the machine: media-monitoring-api and media-monitoring-web (deploy/*.service). Each deploy gets a
# release folder of its own, /opt/media-monitoring/releases/<time>-<commit>, where the commit is installed and the site
# built; the link /opt/media-monitoring/current says which release runs. If installing or building fails, the running
# release is left as it is; if the new one doesn't answer once started, the one before it is started again. Caddy, in
# front of both (deploy/Caddyfile), gets the address, HTTPS and a temporary shared password for everything.
#
#   ./deploy.sh            deploy this clone's current commit (uncommitted changes aren't deployed)
#   ./deploy.sh rollback   go back to the release before the running one
#
# Run it as root, after "./run.sh setup" (Node.js, pnpm and the services' users). The services' logs:
# journalctl -u media-monitoring-api, journalctl -u media-monitoring-web.
set -euo pipefail
cd "$(dirname "$0")"
ROOT=/opt/media-monitoring
KEEP=3  # releases kept, the running one included
WAIT=30  # seconds a started release has to answer in
SERVICES=(media-monitoring-api media-monitoring-web)
WEB_USER=media_monitoring_web
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
# The services' Python goes where their users can run it: uv's usual place is in /root, which they can't read
export UV_PYTHON_INSTALL_DIR="$ROOT/python" UV_PYTHON_PREFERENCE=only-managed

if [ "$(id -u)" -ne 0 ]; then
    echo "deploy.sh: run it as root"
    exit 1
fi
for user in media_monitoring_api "$WEB_USER"; do
    if ! id -u "$user" > /dev/null 2>&1; then
        echo "deploy.sh: there's no user $user yet: run ./run.sh setup first"
        exit 1
    fi
done
mkdir -p "$ROOT/releases"
exec 9> "$ROOT/deploy.lock"
if ! flock -n 9; then
    echo "deploy.sh: another deploy is running"
    exit 1
fi

answering() {
    # Both answer within WAIT seconds: the API's readiness check, which reaches the database, and the site's home page
    for _ in $(seq $((WAIT * 2))); do
        if curl -sf -o /dev/null --max-time 5 http://127.0.0.1:8000/api/health/ready &&
            curl -sf -o /dev/null --max-time 5 http://127.0.0.1:3000/; then
            return 0
        fi
        sleep 0.5
    done
    return 1
}

start() {
    # Point current at a release, and restart both services on it. A service that kept failing (5 times in 10 s) is
    # left stopped by systemd until that's cleared.
    ln -sfn "releases/$1" "$ROOT/current.new"
    mv -Tf "$ROOT/current.new" "$ROOT/current"
    systemctl reset-failed "${SERVICES[@]}" 2> /dev/null || true
    systemctl restart "${SERVICES[@]}"
}

logs() {
    journalctl -u media-monitoring-api -u media-monitoring-web -n 20 --no-pager -o cat || true
}

caddy_up() {
    # Caddy in front of both, with the Caddyfile the release has: installed once Caddy finds it valid, and reloaded
    # when it changed. The temporary shared password is made when there's none (the first deploy, or a deploy after
    # both files below are deleted, to change it): Caddy gets the user name and the password's hash from
    # /etc/caddy/site.env, and root can read the password itself in /etc/caddy/site-password.
    local caddyfile=$1 restart="" reload="" password check
    if ! command -v caddy > /dev/null; then
        echo "deploy.sh: Caddy isn't installed yet: run ./run.sh setup"
        return 1
    fi
    if [ ! -f /etc/caddy/site.env ]; then
        password=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
        (umask 077 && printf '%s\n' "$password" > /etc/caddy/site-password)
        printf 'SITE_USER=monitoring\nSITE_PASSWORD_HASH=%s\n' "$(caddy hash-password --plaintext "$password")" \
            > /etc/caddy/site.env
        chown root:caddy /etc/caddy/site.env
        chmod 640 /etc/caddy/site.env
        echo "### made the site's temporary password: user monitoring, password in /etc/caddy/site-password"
        restart=1  # Caddy reads site.env when it starts
    fi
    local dropin=/etc/systemd/system/caddy.service.d/media-monitoring.conf
    if [ ! -f "$dropin" ]; then
        mkdir -p "${dropin%/*}"
        printf '[Service]\nEnvironmentFile=/etc/caddy/site.env\n' > "$dropin"
        systemctl daemon-reload
        restart=1
    fi
    if ! cmp -s "$caddyfile" /etc/caddy/Caddyfile; then
        check=$(mktemp)
        # shellcheck disable=SC2046  # each line of site.env is one variable
        if ! env $(< /etc/caddy/site.env) caddy validate --config "$caddyfile" --adapter caddyfile > "$check" 2>&1; then
            tail -5 "$check"
            rm -f "$check"
            echo "deploy.sh: deploy/Caddyfile isn't valid, so Caddy keeps the one it has"
            return 1
        fi
        rm -f "$check"
        install -m 644 "$caddyfile" /etc/caddy/Caddyfile
        reload=1
    fi
    systemctl enable --quiet caddy
    if [ -n "$restart" ] || ! systemctl is-active --quiet caddy; then
        systemctl restart caddy
        echo "### Caddy started"
    elif [ -n "$reload" ]; then
        systemctl reload caddy
        echo "### Caddy reloaded with the new Caddyfile"
    fi
}

running=$(readlink "$ROOT/current" || true)
running=${running#releases/}

if [ "${1:-}" = rollback ]; then
    before=$(ls "$ROOT/releases" | sort | grep -x -B1 -- "$running" | head -1 || true)
    if [ -z "$running" ] || [ -z "$before" ] || [ "$before" = "$running" ]; then
        echo "deploy.sh: there's no release before ${running:-the running one} to go back to"
        exit 1
    fi
    echo "### going back from $running to $before"
    start "$before"
    if answering; then
        echo "### $before runs and answers"
        exit 0
    fi
    logs
    echo "deploy.sh: $before doesn't answer"
    exit 1
elif [ $# -gt 0 ]; then
    echo "deploy.sh: unknown argument $1 (see the top of deploy.sh)"
    exit 1
fi

started=$SECONDS
commit=$(git rev-parse --short HEAD)
release=$(date -u +%Y%m%d-%H%M%S)-$commit
folder=$ROOT/releases/$release
echo "### deploying $commit (\"$(git log -1 --format=%s)\") as $release"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "(this clone has uncommitted changes: they aren't deployed)"
fi

# If installing or building fails, the half-made release goes, and the running one is left as it is
trap 'rm -rf "$folder"; echo "deploy.sh: deploying $release failed; ${running:-nothing} runs"' ERR

mkdir "$folder"
git archive HEAD | tar -x -C "$folder"
echo "### installing the API's packages"
(cd "$folder" && uv sync --frozen --no-dev --compile-bytecode -q && .venv/bin/python -m compileall -q src)
echo "### installing the website's packages and building it"
(cd "$folder/web" && pnpm install --frozen-lockfile --silent)
if ! (cd "$folder/web" && pnpm build > build.log 2>&1); then
    tail -30 "$folder/web/build.log"
    false
fi
# Next writes its cache while it runs: the only place in a release the site's user may write
mkdir -p "$folder/web/.next/cache"
chown -R "$WEB_USER:$WEB_USER" "$folder/web/.next/cache"

# The services, as this commit has them
reload=""
for unit in "$folder"/deploy/*.service; do
    if ! cmp -s "$unit" "/etc/systemd/system/${unit##*/}"; then
        install -m 644 "$unit" /etc/systemd/system/
        reload=1
    fi
done
if [ -n "$reload" ]; then
    systemctl daemon-reload
fi
systemctl enable --quiet "${SERVICES[@]}"
trap - ERR

echo "### starting $release"
start "$release"
if ! answering; then
    logs
    if [ -n "$running" ]; then
        echo "### $release doesn't answer: going back to $running"
        start "$running"
        rm -rf "$folder"
        if answering; then
            echo "### $running runs again"
        else
            echo "deploy.sh: $running doesn't answer either"
        fi
    fi
    echo "deploy.sh: $release didn't answer"
    exit 1
fi

caddy_up "$folder/deploy/Caddyfile"

# The newest releases are kept, the one just started among them
ls "$ROOT/releases" | sort | head -n -"$KEEP" | while read -r old; do
    rm -rf "${ROOT:?}/releases/$old"
done
echo "### $release runs and answers ($((SECONDS - started)) s); releases kept: $(ls "$ROOT/releases" | wc -l)"
