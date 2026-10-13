#!/bin/bash
# The monitoring rounds, one after another. Each round gets fresh proxies (new VPN configs for sing-box and new free
# proxies), then runs the collectors in order: channel details, new videos, video details, views and likes, and
# comments. A round starts every ROUND_MINUTES minutes, or right after the last one if that took longer.
#
#   ./run.sh                          rounds every 15 minutes; views, likes and comments for the last 90 days
#   ROUND_MINUTES=30 DAYS=30 ./run.sh
#
# It starts its own sing-box (stop any other singbox_runner.py first) and stops it on Ctrl+C or kill.
set -u
cd "$(dirname "$0")"
ROUND_MINUTES=${ROUND_MINUTES:-15}
DAYS=${DAYS:-90}
RUNNER_LOG=singbox/runner.log
runner=""

stop_singbox() {
    if [ -n "$runner" ]; then
        kill -TERM -- "-$runner" 2>/dev/null  # its whole process group: uv, the runner and every sing-box
        while kill -0 "$runner" 2>/dev/null; do sleep 1; done
        runner=""
    fi
}

start_singbox() {
    mkdir -p singbox
    setsid uv run singbox_runner.py > "$RUNNER_LOG" 2>&1 < /dev/null &
    runner=$!
    until grep -q "local proxies saved\|Traceback\|failed to start\|another singbox_runner" "$RUNNER_LOG" 2>/dev/null; do
        kill -0 "$runner" 2>/dev/null || break
        sleep 1
    done
    tail -1 "$RUNNER_LOG"
    grep -q "local proxies saved" "$RUNNER_LOG"
}

trap 'stop_singbox; exit' INT TERM

while true; do
    started=$(date +%s)
    echo "### $(date -u '+%F %T') round"
    uv run vpn_configs.py | tail -1
    uv run plain_proxies.py | tail -1
    stop_singbox
    if ! start_singbox; then
        echo "### sing-box didn't start; trying again in a minute"
        sleep 60
        continue
    fi
    for step in "channels.py" "videos.py" "details.py" "stats.py $DAYS" "comments.py $DAYS"; do
        echo "### $(date -u +%T) $step"
        uv run $step
    done
    rest=$((started + ROUND_MINUTES * 60 - $(date +%s)))
    if [ "$rest" -gt 0 ]; then
        echo "### $(date -u +%T) round done; next one in $rest s"
        sleep "$rest" &
        wait $!  # in the background, so Ctrl+C stops it right away
    fi
done
