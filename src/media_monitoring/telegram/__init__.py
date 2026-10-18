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
from typing import NamedTuple

PAGE = "https://t.me/s/{}"
AFTER = "https://t.me/s/{}?after={}"  # the messages after one: what a channel's page asks for as you scroll down
BEFORE = "https://t.me/s/{}?before={}"  # the messages before one: what it asks for as you scroll up
TIMEOUT = 10  # seconds; a proxy that hasn't brought the page by then has failed
TEST_CHANNEL = "telegram"  # what proxies are tested with (see Pool): Telegram's own channel, up for years
MESSAGE = '<div class="tgme_widget_message_wrap'  # where each message on a page starts
MESSAGE_ID = re.compile(r'data-post="[^/"]+/(\d+)"')
PUBLISHED = re.compile(r'class="tgme_widget_message_date"[^>]*>\s*<time datetime="([^"]+)"')
ALBUM_ITEM = re.compile(r'href="https://t\.me/[^/"]+/(\d+)\?single"')  # each item of an album links to itself
VIEW = re.compile(r'data-view="([^"]+)"')  # base64 JSON that counts a message's view: {"c": -<channel ID>, ...}
# A message's own text (or caption). A reply also shows the start of the message it answers, in an element of the same
# kind marked js-message_reply_text, which isn't part of the text. A notice ("... pinned a photo") is a message of
# its own, marked service_message, whose wording isn't a text either.
TEXT = '<div class="tgme_widget_message_text js-message_text"'
NOTICE = re.compile(r'class="tgme_widget_message [^"]*\bservice_message\b')
DIV = re.compile(r"<(/?)div\b")
LINK = re.compile(r"<a\b([^>]*)>(.*?)</a>", re.S)
HREF = re.compile(r'href="([^"]*)"')


class Message(NamedTuple):
    """One message on a page. An album is one message, under its first item's ID (id), though Telegram numbers every
    item: last is its last item's ID, after which the next messages come (for a single message, the same as id). text is
    the message's own text or caption, None for one without (a sticker, a voice message, a photo without a caption, a
    notice like "photo updated"). channel_id is the channel the message belongs to, None if the page doesn't say."""
    id: int
    last: int
    published_at: datetime
    text: str | None
    channel_id: int | None


async def call(session, proxy, url, light=False):
    """One request through one proxy: for a page, or with light for the messages after one (see AFTER), which
    Telegram answers with a JSON string: the messages' HTML, or "" when there are none. Returns (problem, response):
    problem is None when Telegram answered, "hidden" when it redirected the request to the channel's plain page (see
    the top of this file), "broken" when the proxy failed (no answer, or one that isn't Telegram's), or "telegram
    error" for any other answer."""
    try:
        if light:  # an empty body, whose length must still be given (411 otherwise)
            response = await session.post(url, proxy=proxy, timeout=TIMEOUT, allow_redirects=False, data=b"",
                                          headers={"X-Requested-With": "XMLHttpRequest"})
        else:
            response = await session.get(url, proxy=proxy, timeout=TIMEOUT, allow_redirects=False)
    except Exception:
        return "broken", None
    if response.status_code in (301, 302, 303, 307, 308):
        location = response.headers.get("location") or ""
        return ("hidden" if location.startswith("https://t.me/") else "broken"), None
    if not (response.text.startswith('"') if light else "tgme_" in response.text):
        return "broken", None  # not Telegram's answer: the proxy answered in its place
    if response.status_code != 200:
        return "telegram error", None
    return None, response


async def light(session, proxy, url):
    """The messages after or before one (see AFTER and BEFORE), through one proxy. Returns (outcome, messages): "ok"
    with the messages in the answer, oldest first (none when there are none), else a problem from call()."""
    problem, response = await call(session, proxy, url, light=True)
    if problem:
        return problem, None
    try:
        return "ok", page_messages(json.loads(response.text))
    except (ValueError, TypeError, AttributeError):
        return "broken", None  # not a JSON string: the proxy mangled the answer


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


def view_channel(token):
    """The channel ID in a message's view counter (see VIEW), or None if it isn't one."""
    try:
        return abs(int(json.loads(base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)))["c"]))
    except (ValueError, KeyError, TypeError):
        return None


def channel_id(page):
    """The channel's ID, from the view counters of the messages on its page (forwarded ones carry it too, not the
    original channel's): the one most of them carry. None if the page shows no messages."""
    ids = Counter(found for token in VIEW.findall(page) if (found := view_channel(token)))
    return ids.most_common(1)[0][0] if ids else None


def page_messages(page):
    """The messages on a channel's page, or in the answer to a request for the messages after or before one, oldest
    first (see Message). (Not called messages: importing the step messages.py puts that module under that name here.)"""
    found = []
    for block in page.split(MESSAGE)[1:]:
        first, published = MESSAGE_ID.search(block), PUBLISHED.search(block)
        if not first or not published:
            continue
        view = VIEW.search(block)
        items = [int(first.group(1))] + [int(item) for item in ALBUM_ITEM.findall(block)]
        found.append(Message(items[0], max(items), datetime.fromisoformat(published.group(1)), message_text(block),
                             view_channel(view.group(1)) if view else None))
    return found


def message_text(block):
    """A message's own text, as plain text (see text and link), or None if it has none."""
    start = block.find(TEXT)
    if start == -1 or NOTICE.search(block[:start]):
        return None
    start = block.index(">", start) + 1
    depth = 1
    for tag in DIV.finditer(block, start):  # where the text's element ends: the elements inside it end first
        depth += -1 if tag.group(1) else 1
        if not depth:
            return text(LINK.sub(link, block[start:tag.start()])) or None
    return None


def link(match):
    """A link in a message's text, still as HTML for text() to finish: the text it shows, and after it in brackets
    the address it leads to when the text isn't that address (a link hidden behind words), so it isn't lost."""
    address, shown = HREF.search(match.group(1)), match.group(2)
    if not address:
        return shown
    url, words = html.unescape(address.group(1)), text(shown)
    if not url.startswith(("http://", "https://")) or words.startswith(("@", "#", "$", "/")):
        return shown  # a hashtag's search, a phone number, an e-mail address, a @username, a command
    if bare(url) == bare(words):
        return shown
    if words.endswith("…") and bare(url).startswith(bare(words[:-1])):
        return address.group(1)  # the address, shortened: the whole one instead
    return f"{shown} ({address.group(1)})"


def bare(url):
    """An address without what doesn't tell addresses apart, to compare it with the text of a link."""
    url = url.lower().strip().removeprefix("https://").removeprefix("http://").removeprefix("www.")
    return url.rstrip("/")


def newest_message(found):
    """The newest of a page's messages (see page_messages): (its ID, when it was published), or None if there are
    none. For an album, the ID is its last item's (see Message), so asking for the messages after it doesn't bring the
    album back."""
    if not found:
        return None
    newest = max(found, key=lambda message: message.last)
    return newest.last, newest.published_at
