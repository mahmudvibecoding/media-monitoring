"""What the VPN and plain proxy lists share: where most of them are (GitHub), when each one last changed, and the
report of a download, the same for both kinds: one line per list, then the totals."""
import asyncio
import re
from datetime import datetime
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit

from curl_cffi import AsyncSession

GITHUB = "https://raw.githubusercontent.com/"
NEWEST = re.compile(r"<entry>.*?<updated>([^<]+)</updated>", re.S)  # a commit feed's newest commit
COLUMNS = f"{'updated':>12}  {'found':>9}  {'new':>9}  {'skipped':>9}  list"


def name(url):
    """A list's name in the reports: its path on GitHub, or the site it comes from."""
    return url.removeprefix(GITHUB) if url.startswith(GITHUB) else urlsplit(url).netloc


async def changed(session, url):
    """When a list last changed, or None if that can't be told. GitHub serves its files without a date, but each file
    has a commit feed, newest first; another site may say it in its Last-Modified header."""
    try:
        if url.startswith(GITHUB):
            owner, repo, branch, path = url.removeprefix(GITHUB).split("/", 3)
            feed = await session.get(f"https://github.com/{owner}/{repo}/commits/{branch}/{path}.atom", timeout=30)
            newest = NEWEST.search(feed.text)
            return datetime.fromisoformat(newest.group(1)) if newest else None
        response = await session.head(url, timeout=30)
        return parsedate_to_datetime(response.headers["last-modified"])
    except Exception:
        return None


async def all_changed(urls):
    """When each list last changed (see changed), all asked at once."""
    async with AsyncSession() as session:
        return await asyncio.gather(*(changed(session, url) for url in urls))


def ago(when, now):
    """How long ago a list changed: 12 min ago, 3 h ago, 5 days ago, or ? if it can't be told."""
    if when is None:
        return "?"
    minutes = max(0, (now - when).total_seconds() / 60)
    if minutes < 60:
        return f"{minutes:.0f} min ago"
    if minutes < 48 * 60:
        return f"{minutes / 60:.0f} h ago"
    return f"{minutes / 1440:.0f} days ago"


def report(title, rows, now):
    """Print the title, then one line per list: when it last changed, what it had (found), how much of that no list
    above it had (new), and what couldn't be used (skipped). rows are (name, changed, found, new, skipped), or
    (name, error) for a list that failed to download."""
    print(f"{title}\n{COLUMNS}")
    for row in rows:
        if len(row) == 2:
            print(f"{'FAILED':>12}  {row[0]}: {row[1]}")
        else:
            list_name, when, found, new, skipped = row
            print(f"{ago(when, now):>12}  {found:>9,}  {new:>9,}  {skipped:>9,}  {list_name}")


def as_numbers(rows):
    """The report's rows (see report) as the run's numbers (see runs.py): one dict per list"""
    return [
        {"list": row[0], "error": str(row[1])}
        if len(row) == 2
        else {"list": row[0], "updated": row[1].isoformat() if row[1] else None, "found": row[2], "new": row[3],
              "skipped": row[4]}
        for row in rows
    ]


def total(count, what):
    """The report's total, under the found column."""
    print(f"{'total':>12}  {count:>9,}  {'':>9}  {'':>9}  {what}")


def note(text):
    """A line of the report under the list column."""
    print(f"{'':>12}  {'':>9}  {'':>9}  {'':>9}  {text}")
