"""Run every VPN config through sing-box, each on its own local SOCKS5 address, listed in data/vpn_proxies.txt.
"uv run proxies" starts it in the background. Whatever sing-box still runs from this folder is stopped first, so
starting it again restarts it with new configs."""
import json
import os
import random
import resource
import signal
import socket
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from multiprocessing import get_context
from pathlib import Path

from media_monitoring.proxies.converter import Unusable, to_outbound

INPUT = "data/vpn_configs.txt"  # from vpn_proxies.py
OUTPUT = "data/vpn_proxies.txt"  # one line per config: "socks5h://127.1.1.1:20000 <link>"
FOLDER = Path("data/singbox")  # the generated sing-box configs and logs
GROUP_SIZE = 1000  # configs per sing-box process
FIRST_PORT = 20000
LIMIT = None  # use only this many random configs; None uses all on Linux and 1000 on macOS


def address_and_port(i):
    """Where config number i listens.

    Linux: each group gets its own loopback address (127.1.1.1, 127.1.2.1, ...), so no other
    program's connections can take our ports. macOS only has 127.0.0.1, so there every config gets
    its own port instead; ports below 49152 are safe because macOS uses 49152+ for connections.
    """
    if sys.platform == "darwin":
        return "127.0.0.1", FIRST_PORT + i
    return f"127.1.{i // GROUP_SIZE + 1}.1", FIRST_PORT + i % GROUP_SIZE


def raise_open_files_limit():
    """Every port and connection needs an open file; sing-box inherits this limit from us."""
    _, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    for limit in (1_000_000, 10240):  # macOS refuses more than 10240
        try:
            resource.setrlimit(resource.RLIMIT_NOFILE, (min(limit, hard), hard))
            return
        except (ValueError, OSError):
            continue


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def stop_old():
    """Stop the sing-box left running from this folder: an earlier singbox, which stops its own sing-box processes
    as it ends, and sing-box processes one left behind (when a closed terminal ended it, for example). Their ports are
    about to be needed. Returns how many processes it stopped. Linux only: elsewhere, stop the old one by hand."""
    if not os.path.isdir("/proc"):
        return 0
    here, old = os.getcwd(), []
    for entry in os.listdir("/proc"):
        if not entry.isdigit() or int(entry) == os.getpid():
            continue
        try:
            with open(f"/proc/{entry}/cmdline", "rb") as f:
                args = [part.decode(errors="replace") for part in f.read().split(b"\0") if part]
            folder = os.readlink(f"/proc/{entry}/cwd")
        except OSError:
            continue  # it ended meanwhile, or isn't ours to read
        runner = len(args) > 1 and (os.path.basename(args[1]) == "singbox"  # started as a command of its own
                                    or "media_monitoring.proxies.singbox" in args)  # by uv run proxies
        leftover = args[:3] == ["sing-box", "run", "-c"] and len(args) > 3 and args[3].startswith(f"{FOLDER}/")
        if (runner or leftover) and folder == here:
            old.append(int(entry))
    if not old:
        return 0
    print(f"stopping the sing-box left running here ({len(old)} processes)...")
    for pid in old:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + 30
    while any(alive(pid) for pid in old) and time.monotonic() < deadline:
        time.sleep(0.2)
    for pid in old:
        if alive(pid):  # still there after 30 s
            os.kill(pid, signal.SIGKILL)
    return len(old)


def group_config(group):
    """A sing-box config for one group: one SOCKS5 inbound per config, routed to its outbound."""
    inbounds, outbounds, rules = [], [], []
    for i, outbound in group:
        host, port = address_and_port(i)
        inbounds.append({"type": "socks", "tag": f"in-{i}", "listen": host, "listen_port": port})
        outbounds.append(outbound)
        rules.append({"inbound": [f"in-{i}"], "action": "route", "outbound": outbound["tag"]})
    return {"log": {"level": "error"}, "inbounds": inbounds, "outbounds": outbounds, "route": {"rules": rules}}


def port_is_free(host, port):
    """True if nothing else listens on host:port (e.g. another copy of this runner)."""
    with socket.socket() as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)  # like sing-box: closed connections don't count
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False


def wait_until_ready(process, host, port, timeout=60):
    """True once the group's last port accepts connections; False if sing-box exits or never gets there."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            return False
        try:
            with socket.create_connection((host, port), timeout=1):
                return True
        except OSError:
            time.sleep(0.2)
    return False


def build_group(number, first, links):
    """In a worker process: one group's sing-box config, written to its file. Config number first + k is links[k],
    on that number's address and port; a link sing-box can't use leaves its port unused. Returns
    [(config number, link), ...] for the configs in the group."""
    group = []
    for i, link in enumerate(links, first):
        try:
            group.append((i, to_outbound(link, f"out-{i}"), link))
        except Unusable:
            continue
    if group:
        (FOLDER / f"group-{number}.json").write_text(json.dumps(group_config([(i, out) for i, out, _ in group])))
    return [(i, link) for i, _, link in group]


def start_groups(groups, processes):
    """Start one sing-box process per group, given as [(group number, [(config number, link), ...]), ...] from
    build_group. Returns {group number: (process, configs)} for those that started.

    Each process is added to `processes` as soon as it starts, so all of them can be stopped even if
    this is interrupted halfway.
    """
    started = {}
    for number, configs in groups:
        if not configs:
            continue
        # Another singbox on these addresses would hold the group's ports: one of them shows it. Nothing else takes
        # ports here (outgoing connections get ports from 32768 up).
        host, port = address_and_port(configs[0][0])
        if not port_is_free(host, port):
            print(f"group {number} skipped: its ports are in use, e.g. {host}:{port} (is another singbox running?)")
            continue
        log = open(FOLDER / f"group-{number}.log", "w")
        process = subprocess.Popen(["sing-box", "run", "-c", str(FOLDER / f"group-{number}.json")], stdout=log,
                                   stderr=log)
        processes.append(process)
        started[number] = (process, configs)

    running = {}
    for number, (process, configs) in started.items():
        if wait_until_ready(process, *address_and_port(configs[-1][0])):
            running[number] = (process, configs)
        else:
            process.terminate()
            log = (FOLDER / f"group-{number}.log").read_text().strip().splitlines()
            print(f"group {number} failed to start: {log[-1] if log else 'no log'}")
    return running


def main():
    sys.stdout.reconfigure(line_buffering=True)  # print each line right away, also into a log file
    raise_open_files_limit()
    with open(INPUT) as f:
        links = [line.strip() for line in f if line.strip()]
    limit = LIMIT or (1000 if sys.platform == "darwin" else None)  # a Mac can't take them all
    if limit:
        links = random.sample(links, min(limit, len(links)))

    # Each group's configs are converted and written by a process of its own, while the old sing-box stops
    FOLDER.mkdir(parents=True, exist_ok=True)
    starts = range(0, len(links), GROUP_SIZE)
    # "spawn" starts each process fresh, which works the same on macOS and Linux
    with ProcessPoolExecutor(max(1, min(len(starts), os.cpu_count())), mp_context=get_context("spawn")) as pool:
        built = pool.map(build_group, range(1, len(starts) + 1), starts, [links[g:g + GROUP_SIZE] for g in starts])
        stop_old()  # its ports are needed next
        groups = list(enumerate(built, 1))
    usable = sum(len(configs) for _, configs in groups)
    # Stop the sing-box processes on Ctrl+C and on "kill", so they don't keep holding the ports.
    signal.signal(signal.SIGINT, signal.default_int_handler)  # Ctrl+C, even if started in the background
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    processes = []
    try:
        print(f"starting {usable} configs in {sum(bool(configs) for _, configs in groups)} sing-box processes...")
        began = time.monotonic()
        running = start_groups(groups, processes)
        print(f"{len(running)} processes running after {time.monotonic() - began:.0f} s")
        if not running:
            return

        with open(f"{OUTPUT}.tmp", "w") as f:
            for _, configs in running.values():
                for i, link in configs:
                    host, port = address_and_port(i)
                    f.write(f"socks5h://{host}:{port} {link}\n")
        os.replace(f"{OUTPUT}.tmp", OUTPUT)  # all at once: a collector reading it never sees half a list
        print(f"{sum(len(g) for _, g in running.values())} local proxies saved to {OUTPUT}")

        while True:
            time.sleep(5)
            for number, (process, _) in list(running.items()):
                if process.poll() is not None:
                    print(f"group {number} stopped unexpectedly (exit code {process.returncode})")
                    del running[number]
    except KeyboardInterrupt:
        pass
    except FileNotFoundError:
        print("sing-box isn't installed (./run.sh setup installs it)")
    finally:
        for process in processes:
            process.terminate()
        for process in processes:
            process.wait()
        print("all sing-box processes stopped")


if __name__ == "__main__":
    main()
