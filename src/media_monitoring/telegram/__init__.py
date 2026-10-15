"""Telegram's steps, run by "uv run telegram <step>" (see commands.py), and the public pages of its channels,
t.me/s/<username>, which anyone can read without an account: where they are, one request for one through one proxy,
and what a page says. A page shows the channel's title, description and counters, and its 20 or so newest messages.

Telegram doesn't refuse an address that asks too fast: it hides pages from it instead, redirecting them to the
channel's plain page (t.me/<username>), as it does for a channel without a public page. Either way the page counts as
hidden: it goes out again through another proxy, and the proxy keeps working, since Telegram hides some channels from
an address, not all of them (see Pool).
"""
import base64
import html
import json
import re
from collections import Counter
from datetime import datetime

PAGE = "https://t.me/s/{}"
TIMEOUT = 10  # seconds; a proxy that hasn't brought the page by then has failed
TEST_CHANNEL = "telegram"  # what proxies are tested with (see Pool): Telegram's own channel, up for years
MESSAGE = 'data-post="'  # where each message on a page starts: data-post="<username>/<message ID>"
MESSAGE_ID = re.compile(r'[^/"]+/(\d+)"')
PUBLISHED = re.compile(r'<time datetime="([^"]+)"')
ALBUM_ITEM = re.compile(r'href="https://t\.me/[^/"]+/(\d+)\?single"')  # each item of an album links to itself
VIEW = re.compile(r'data-view="([^"]+)"')  # base64 JSON that counts a message's view: {"c": -<channel ID>, ...}


async def call(session, proxy, url):
    """One request for a page through one proxy. Returns (problem, response): problem is None when Telegram answered
    with a page, "hidden" when it redirected it to the channel's plain page (see the top of this file), "broken" when
    the proxy failed (no answer, or one that isn't Telegram's), or "telegram error" for any other answer."""
    try:
        response = await session.get(url, proxy=proxy, timeout=TIMEOUT, allow_redirects=False)
    except Exception:
        return "broken", None
    if response.status_code in (301, 302, 303, 307, 308):
        location = response.headers.get("location") or ""
        return ("hidden" if location.startswith("https://t.me/") else "broken"), None
    if "tgme_" not in response.text:
        return "broken", None  # not Telegram's page: the proxy answered in its place
    if response.status_code != 200:
        return "telegram error", None
    return None, response


def text(fragment):
    """A piece of a page as plain text: line breaks kept, links as the text they show (the address itself, or the
    @username), emoji as characters, and no NUL characters (PostgreSQL can't store them)."""
    fragment = re.sub(r"<br\s*/?>", "\n", fragment)
    return html.unescape(re.sub(r"<[^>]+>", "", fragment)).replace("\x00", "").strip()


def count(shown):
    """A count as the pages show it: exact below 1,000, rounded to three digits above (12.3K is 12,300, 1.14M is
    1,140,000). None if it isn't one."""
    shown = shown.replace(" ", "").replace(",", "")
    scale = {"K": 1_000, "M": 1_000_000, "B": 1_000_000_000}.get(shown[-1:], 1)
    try:
        return round(float(shown[:-1] if scale > 1 else shown) * scale)
    except ValueError:
        return None


def channel_id(page):
    """The channel's ID, from the view counters of the messages on its page (forwarded ones carry it too, not the
    original channel's): the one most of them carry. None if the page shows no messages."""
    ids = Counter()
    for token in VIEW.findall(page):
        try:
            ids[abs(int(json.loads(base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)))["c"]))] += 1
        except (ValueError, KeyError, TypeError):
            continue
    return ids.most_common(1)[0][0] if ids else None


def newest_message(page):
    """The newest message on a page: (its ID, when it was published), or None if the page shows none. An album is one
    message on the page, under its first item's ID, but Telegram numbers every item: an album's ID here is its last
    item's, so asking for the messages after it doesn't bring the album back."""
    newest = None
    for block in page.split(MESSAGE)[1:]:
        first, published = MESSAGE_ID.match(block), PUBLISHED.search(block)
        if not first or not published:
            continue
        last = max([int(first.group(1))] + [int(item) for item in ALBUM_ITEM.findall(block)])
        if newest is None or last > newest[0]:
            newest = last, datetime.fromisoformat(published.group(1))
    return newest
