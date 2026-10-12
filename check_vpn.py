"""Check every local VPN proxy from vpn_proxies.txt, and count what works per protocol and per source.

Keep singbox_runner.py running in another terminal while this runs.
"""
import time
from collections import Counter, defaultdict

from proxies import check_all

INPUT = "vpn_proxies.txt"  # from singbox_runner.py: "<local proxy> <link>"
SOURCES_FILE = "vpn_sources.txt"  # from vpn_configs.py: "<link> <source> <source> ..."
OUTPUT = "working_vpn_proxies.txt"


def read_pairs(path):
    """Read lines like "first rest of line" into {first: "rest of line"}."""
    pairs = {}
    with open(path) as f:
        for line in f:
            first, _, rest = line.strip().partition(" ")
            if first:
                pairs[first] = rest
    return pairs


def print_table(title, counts):
    print(f"\n{title:52} {'checked':>7} {'works':>6} {'rate':>5} {'only here':>9}")
    for name, c in sorted(counts.items(), key=lambda item: -item[1]["works"]):
        checked = c["works"] + c["fails"]
        print(f"{name[:52]:52} {checked:>7} {c['works']:>6} {100 * c['works'] / checked:>4.0f}% {c['only here'] or '':>9}")


def main():
    links = read_pairs(INPUT)  # {local proxy: link}
    sources = read_pairs(SOURCES_FILE)  # {link: "source source ..."}

    print(f"checking {len(links)} local proxies...")
    started = time.monotonic()
    working, outcomes = check_all(list(links))
    print(f"\n{len(working)} of {len(links)} work ({time.monotonic() - started:.0f} s)")
    for outcome, count in outcomes.most_common():
        print(f"{count:>7}  {outcome}")

    # "only here": working configs that no other list has, which is what a source really adds
    works = {proxy for _, proxy in working}
    by_protocol, by_source = defaultdict(Counter), defaultdict(Counter)
    for proxy, link in links.items():
        result = "works" if proxy in works else "fails"
        by_protocol[link.split("://")[0]][result] += 1
        listed_in = sources.get(link, "unknown").split()
        for source in listed_in:
            by_source[source][result] += 1
            if result == "works" and len(listed_in) == 1:
                by_source[source]["only here"] += 1
    print_table("protocol", by_protocol)
    print_table("source", by_source)

    with open(OUTPUT, "w") as f:
        f.write("".join(f"{proxy} {links[proxy]}\n" for _, proxy in working))  # fastest first
    print(f"\nsaved to {OUTPUT}")


# Needed for multiple processes: each worker process imports this file and must not run main() again.
if __name__ == "__main__":
    main()