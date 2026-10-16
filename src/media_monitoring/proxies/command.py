"""The proxies command. By itself it gets fresh proxies: it downloads the public lists of VPN configs and of plain
proxies, then restarts sing-box with the new configs in the background, and returns once its local proxies are ready.

    uv run proxies                      download both, and (re)start sing-box in the background
    uv run proxies stop                 stop sing-box
    uv run proxies check [vpn|plain]    report how many proxies work, by protocol or type and by list (both kinds
                                        unless one is named; the VPN ones need sing-box running)

sing-box keeps running after this command ends and after its terminal closes. Its log is data/singbox/runner.log.
"""
import subprocess
import sys
import time

from media_monitoring.proxies import check, plain_proxies, vpn_proxies
from media_monitoring.proxies.singbox import FOLDER, stop_old

LOG = FOLDER / "runner.log"
USAGE = "usage: uv run proxies [stop | check [vpn | plain]]"
READY = "local proxies saved"  # what sing-box's runner prints once its proxies are listed in data/vpn_proxies.txt


def start_singbox():
    """Start sing-box's runner in the background, in a session of its own, so that it outlives this command and its
    terminal; it stops the one already running here first. Returns the line saying its proxies are ready, or None if
    it ended before that."""
    FOLDER.mkdir(parents=True, exist_ok=True)
    LOG.unlink(missing_ok=True)  # a new file: the runner it replaces writes its last line into the old one as it ends
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
        time.sleep(0.2)


def refresh():
    """Download both lists, and restart sing-box with the new configs in the background."""
    # The plain proxies' lists at the same time as the VPN ones, in a process of their own: saving them takes seconds
    # of Python that would otherwise slow this one down. Their report comes after the VPN one.
    plain = subprocess.Popen([sys.executable, "-m", plain_proxies.__name__], stdout=subprocess.PIPE, text=True)
    vpn_proxies.main()
    report, _ = plain.communicate()
    print("\n" + report, end="")
    if plain.returncode:
        sys.exit("the plain proxies' lists failed (see above)")
    print("\nstarting sing-box in the background...")
    ready = start_singbox()
    if ready is None:
        sys.exit(f"sing-box didn't start: see {LOG}")
    print(f"{ready}\nsing-box runs in the background (log: {LOG}); stop it with: uv run proxies stop")


def main():
    sys.stdout.reconfigure(line_buffering=True)  # print each line right away, also into a log file
    args = sys.argv[1:]
    if not args:
        refresh()
    elif args == ["stop"]:
        if not stop_old():
            print("no sing-box running here")
    elif args[0] == "check" and args[1:] in ([], ["vpn"], ["plain"]):
        if args[1:] != ["plain"]:
            check.check_vpn()
        if args[1:] == []:
            print()
        if args[1:] != ["vpn"]:
            check.check_plain()
    else:
        sys.exit(USAGE)
