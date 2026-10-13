"""Fresh proxies in one command: download the public lists of VPN configs and of free proxies, then restart sing-box
with the new configs in the background, and return once its local proxies are ready.

    uv run proxies         download both, and (re)start sing-box in the background
    uv run proxies stop    stop sing-box

sing-box keeps running after this command ends and after its terminal closes. Its log is data/singbox/runner.log.
"""
import subprocess
import sys
import time

from media_monitoring.proxies import plain_proxies, vpn_proxies
from media_monitoring.proxies.singbox import FOLDER, stop_old

LOG = FOLDER / "runner.log"
READY = "local proxies saved"  # what sing-box's runner prints once its proxies are listed in data/vpn_proxies.txt


def start_singbox():
    """Start sing-box's runner in the background, in a session of its own, so that it outlives this command and its
    terminal; it stops the one already running here first. Returns the line saying its proxies are ready, or None if
    it ended before that."""
    FOLDER.mkdir(parents=True, exist_ok=True)
    with open(LOG, "w") as log:
        runner = subprocess.Popen([sys.executable, "-m", "media_monitoring.proxies.singbox"], stdin=subprocess.DEVNULL,
                                  stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    while True:
        lines = LOG.read_text().splitlines()
        ready = [line for line in lines if READY in line]
        if ready:
            return ready[-1]
        if runner.poll() is not None:
            print("\n".join(lines[-3:]))
            return None
        time.sleep(1)


def main():
    sys.stdout.reconfigure(line_buffering=True)  # print each line right away, also into a log file
    if sys.argv[1:] == ["stop"]:
        if not stop_old():
            print("no sing-box running here")
        return
    if sys.argv[1:]:
        sys.exit("usage: uv run proxies [stop]")
    vpn_proxies.main()
    plain_proxies.main()
    print("\nstarting sing-box in the background...")
    ready = start_singbox()
    if ready is None:
        sys.exit(f"sing-box didn't start: see {LOG}")
    print(f"{ready}\nsing-box runs in the background (log: {LOG}); stop it with: uv run proxies stop")
