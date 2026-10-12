"""Run every VPN config through sing-box, each on its own local SOCKS5 address."""
import json
import random
import resource
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

from converter import Unusable, to_outbound

INPUT = "vpn_configs.txt"
OUTPUT = "vpn_proxies.txt"  # one line per config: "socks5h://127.1.1.1:20000 <link>"
FOLDER = Path("singbox")  # the generated sing-box configs and logs
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


def group_config(group):
    """A sing-box config for one group: one SOCKS5 inbound per config, routed to its outbound."""
    inbounds, outbounds, rules = [], [], []
    for i, outbound in group:
        host, port = address_and_port(i)
        inbounds.append({"type": "socks", "tag": f"in-{i}", "listen": host, "listen_port": port})
        outbounds.append(outbound)
        rules.append({"inbound": [f"in-{i}"], "action": "route", "outbound": outbound["tag"]})
    return {"log": {"level": "error"}, "inbounds": inbounds, "outbounds": outbounds, "route": {"rules": rules}}


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


def start_groups(configs, processes):
    """Start one sing-box process per group. Returns {group number: (process, group)} for those that started.

    Each process is added to `processes` as soon as it starts, so all of them can be stopped even if
    this is interrupted halfway.
    """
    FOLDER.mkdir(exist_ok=True)
    groups = [configs[g:g + GROUP_SIZE] for g in range(0, len(configs), GROUP_SIZE)]
    started = {}
    for number, group in enumerate(groups, 1):
        path = FOLDER / f"group-{number}.json"
        path.write_text(json.dumps(group_config(group)))
        log = open(FOLDER / f"group-{number}.log", "w")
        process = subprocess.Popen(["sing-box", "run", "-c", str(path)], stdout=log, stderr=log)
        processes.append(process)
        started[number] = (process, group)

    running = {}
    for number, (process, group) in started.items():
        if wait_until_ready(process, *address_and_port(group[-1][0])):
            running[number] = (process, group)
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

    configs, links_by_index = [], {}
    for link in links:
        try:
            outbound = to_outbound(link, f"out-{len(configs)}")
        except Unusable:
            continue
        links_by_index[len(configs)] = link
        configs.append((len(configs), outbound))

    # Stop the sing-box processes on Ctrl+C and on "kill", so they don't keep holding the ports.
    signal.signal(signal.SIGINT, signal.default_int_handler)  # Ctrl+C, even if started in the background
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    processes = []
    try:
        print(f"starting {len(configs)} configs in {-(-len(configs) // GROUP_SIZE)} sing-box processes...")
        began = time.monotonic()
        running = start_groups(configs, processes)
        print(f"{len(running)} processes running after {time.monotonic() - began:.0f} s")

        with open(OUTPUT, "w") as f:
            for _, group in running.values():
                for i, _ in group:
                    host, port = address_and_port(i)
                    f.write(f"socks5h://{host}:{port} {links_by_index[i]}\n")
        print(f"{sum(len(g) for _, g in running.values())} local proxies saved to {OUTPUT}; press Ctrl+C to stop")

        while True:
            time.sleep(5)
            for number, (process, _) in list(running.items()):
                if process.poll() is not None:
                    print(f"group {number} stopped unexpectedly (exit code {process.returncode})")
                    del running[number]
    except KeyboardInterrupt:
        pass
    except FileNotFoundError:
        print("sing-box isn't installed (see step 2)")
    finally:
        for process in processes:
            process.terminate()
        for process in processes:
            process.wait()
        print("all sing-box processes stopped")


if __name__ == "__main__":
    main()