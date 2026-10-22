"""Refresh every channel's details in telegram_channels (title, description, subscriber_count, photo_url) from its
public page, as fast as the proxies answer: one page per channel. Only channels whose details changed are written.
Telegram rounds subscriber counts of 1,000 and more on these pages, to three digits (1.14M).

The photo itself goes into telegram_channel_photos, which the website shows it from: Telegram's links to it last less
than two days, so a link the saved photo didn't come from (a new channel's, a new photo's, or a new one to the same
photo) is downloaded at once, while it works. The same photo again keeps the bytes saved; only its link is new.

The page also shows the channel's newest messages, which aren't saved here (the messages step saves them): a channel
without a last message yet gets its newest one (last_message_id, last_message_at), so reading its messages can start
there; one that has it keeps it, and while the page's newest message is still that one, takes its time from the page
again, which puts right a time read wrong. A page whose messages belong to another channel means the username now
belongs to that channel: nothing is written for it.

Run it after "uv run proxies": the pool tests the proxies by itself (see pool.py). A page Telegram hides from a
proxy's address goes out again through another one, up to ATTEMPTS times in all; the proxy keeps working.
"""
import hashlib
import html
import re
from functools import partial

from media_monitoring.parallel import Collector, run
from media_monitoring.telegram import (PAGE, TEST_CHANNEL, TIMEOUT, call, channel_id, count, newest_message,
                                       page_messages, text)

TITLE = re.compile(r'<div class="tgme_channel_info_header_title"[^>]*>(.*?)</div>', re.S)
DESCRIPTION = re.compile(r'<div class="tgme_channel_info_description"[^>]*>(.*?)</div>', re.S)
ATTEMPTS = 10  # requests per channel at most: Telegram hides many pages from busy proxies
SUBSCRIBERS = re.compile(r'<span class="counter_value">([^<]+)</span>\s*<span class="counter_type">subscribers?<')
# The channel's photo, 160 × 160, on Telegram's image server (cdn1.telesco.pe, ...). A channel without one has only its
# initials there, and no image.
PHOTO = re.compile(r'<i class="tgme_page_photo_image[^"]*"[^>]*><img src="(https://[^"]+)"')
CHANNELS = """CREATE TEMP TABLE channels (channel_id bigint, title text, description text, subscriber_count bigint,
              photo_url text, last_message_id integer, last_message_at timestamptz) ON COMMIT DELETE ROWS"""
# Only rows whose details changed are written. A page without a subscriber count keeps the one we have. The last
# message is only set where there's none, as reading the channel's messages moves it on from there; but while the page's
# newest message is the one we have, its time is the page's: the first version read the first time in a message, which
# in a notice like "Live stream scheduled for Oct 18 at 16:00" is the stream's, not the notice's
SAVE = """UPDATE telegram_channels AS c
          SET title = n.title, description = n.description,
              subscriber_count = coalesce(n.subscriber_count, c.subscriber_count), photo_url = n.photo_url,
              last_message_id = coalesce(c.last_message_id, n.last_message_id),
              last_message_at = CASE WHEN c.last_message_id IS NULL OR c.last_message_id = n.last_message_id
                                     THEN n.last_message_at ELSE c.last_message_at END
          FROM channels AS n
          WHERE c.channel_id = n.channel_id
            AND ((c.title, c.description, c.subscriber_count, c.photo_url)
                 IS DISTINCT FROM (n.title, n.description, coalesce(n.subscriber_count, c.subscriber_count),
                                   n.photo_url)
                 OR c.last_message_id IS NULL AND n.last_message_id IS NOT NULL
                 OR c.last_message_id = n.last_message_id AND c.last_message_at IS DISTINCT FROM n.last_message_at)"""
PHOTOS = "CREATE TEMP TABLE photos (channel_id bigint, url text, photo bytea) ON COMMIT DELETE ROWS"
# A photo, with the link it came from; when a new link brings back the same photo, the bytes saved stay
SAVE_PHOTOS = """INSERT INTO telegram_channel_photos AS p (channel_id, photo, hash, url)
                 SELECT channel_id, photo, md5(photo), url FROM photos
                 ON CONFLICT (channel_id) DO UPDATE
                 SET photo = CASE WHEN p.hash = excluded.hash THEN p.photo ELSE excluded.photo END,
                     hash = excluded.hash, url = excluded.url, saved_at = now()"""
JPEG = b"\xff\xd8\xff"  # how a JPEG starts: the photos are, and anything else is a proxy's answer in Telegram's place


def parse(page):
    """(channel ID, title, description, subscriber_count, photo_url, last message ID, when it was published) from a
    channel's page, or None if it isn't one. The channel ID and the last message are None when the page shows no
    messages."""
    title = TITLE.search(page)
    if not title:
        return None
    description, subscribers, photo = DESCRIPTION.search(page), SUBSCRIBERS.search(page), PHOTO.search(page)
    newest = newest_message(page_messages(page)) or (None, None)
    return (channel_id(page), text(title.group(1)), (text(description.group(1)) or None) if description else None,
            count(subscribers.group(1)) if subscribers else None, html.unescape(photo.group(1)) if photo else None,
            *newest)


async def fetch(session, username, proxy):
    """Ask for one channel's page through one proxy. Returns (outcome, details): "ok" with what parse() found, else a
    problem from telegram.call()."""
    problem, response = await call(session, proxy, PAGE.format(username))
    if problem:
        return problem, None
    details = parse(response.text)
    if details is None:
        return "telegram error", None  # Telegram's page, but not a channel's
    return "ok", details


async def download(session, url, proxy):
    """Download a channel's photo through one proxy. Returns (outcome, photo): "ok" with the JPEG's bytes, "gone" when
    its link no longer works (404), "telegram error" for any other answer, or "broken" when the proxy failed (no
    answer, or one that isn't a JPEG)."""
    try:
        response = await session.get(url, proxy=proxy, timeout=TIMEOUT, allow_redirects=False)
    except Exception:
        return "broken", None
    if response.status_code == 404:
        return "gone", None
    if response.status_code != 200:
        return "telegram error", None
    if not response.content.startswith(JPEG):
        return "broken", None
    return "ok", response.content


def digest(url):
    """A link's md5, as PostgreSQL's md5() gives it"""
    return hashlib.md5(url.encode()).hexdigest()


class Channels(Collector):
    attempts = ATTEMPTS
    report_every = 2
    item_name = "channels"
    saved_name = "changed"

    def load(self, conn, argument):
        # With the md5 of the link each one's saved photo came from (None without one), to tell a new link from it
        return conn.execute("""SELECT c.username, c.channel_id, md5(p.url) FROM telegram_channels AS c
                               LEFT JOIN telegram_channel_photos AS p USING (channel_id)""").fetchall()

    def describe(self, argument):
        return "Telegram channels to refresh"

    async def prepare(self, conn):
        self.pending, self.photos = [], []
        await conn.execute(CHANNELS)
        await conn.execute(PHOTOS)

    async def test(self, session, proxy):
        return await fetch(session, TEST_CHANNEL, proxy)

    async def handle(self, pool, session, channel):
        username, known, downloaded = channel
        outcome, details = await pool.run(partial(fetch, session, username))
        if outcome != "ok":
            return outcome  # "failed": hidden through every proxy tried (or no public page now), or no answer
        if details[0] is not None and details[0] != known:
            return "other channel"  # the username belongs to another channel now
        self.pending.append((known, *details[1:]))
        link = details[4]
        if link and digest(link) != downloaded:
            got, photo = await pool.run(partial(download, session, link))
            self.results[f"photo {got}"] += 1  # "photo ok", "photo gone" or "photo failed"
            if got == "ok":
                self.photos.append((known, link, photo))
        return "ok"

    async def save(self, conn):
        """Returns how many channels changed."""
        # A photo comes after its channel's details, which may have been saved already, at the save before
        rows, photos = self.pending[:], self.photos[:]
        self.pending.clear()
        self.photos.clear()
        changed = 0
        if not rows and not photos:
            return changed
        async with conn.transaction(), conn.cursor() as cur:
            if rows:
                async with cur.copy("COPY channels FROM STDIN") as copy:
                    for row in rows:
                        await copy.write_row(row)
                await cur.execute(SAVE)
                changed = cur.rowcount
            if photos:
                async with cur.copy("COPY photos FROM STDIN") as copy:
                    copy.set_types(["bigint", "text", "bytea"])
                    for row in photos:
                        await copy.write_row(row)
                await cur.execute(SAVE_PHOTOS)
        return changed

    def summary(self, results, saved):
        return (f"{results['ok']} channels read ({saved} changed), {results['other channel']} whose username now "
                f"belongs to another channel (left as they were), {results['failed']} failed (hidden through every "
                f"proxy tried, or no public page now); {results['photo ok']} photos downloaded, "
                f"{results['photo gone']} whose link no longer worked, {results['photo failed']} failed")


def main():
    run(Channels)
