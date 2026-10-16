"""Read the new messages of the Telegram channels: for each channel in telegram_channels that has a last message, ask
for the messages after it (the request a channel's page makes as you scroll down), page by page until an empty
answer, as fast as the proxies answer. The ones with text are kept (see telegram.messages); each page moves the
channel's last message on, text or not. The channels that posted most recently go first: they're the likeliest to need
several pages.

A page Telegram hides from a proxy's address goes out again through another one, up to ATTEMPTS times in all; one that
fails every time ends the channel's read for this run, and the next run continues after the last page read. A page
whose messages carry another channel's ID means the username now belongs to that channel: nothing it brought counts.
A channel's new messages and its new last message are saved in one transaction, so a run that stops or crashes loses
nothing and saves nothing twice: what wasn't saved is read again. Run it after "uv run proxies": the pool tests the
proxies by itself (see pool.py).
"""
import json
from functools import partial

from media_monitoring.parallel import Collector
from media_monitoring.telegram import AFTER, TEST_CHANNEL, call, messages

ATTEMPTS = 10  # requests per page at most: Telegram hides many pages from busy proxies
TEST_AFTER = 10 ** 9  # proxies are tested by asking for the messages after one that doesn't exist yet: "" comes back
NEW_MESSAGES = """CREATE TEMP TABLE new_messages (channel_id bigint, message_id integer, published_at timestamptz,
                  text text) ON COMMIT DELETE ROWS"""
NEW_LAST = """CREATE TEMP TABLE new_last (channel_id bigint, last_message_id integer, last_message_at timestamptz)
              ON COMMIT DELETE ROWS"""
# Messages already saved, or of a channel no longer in the table, are skipped instead of failing the save
SAVE_MESSAGES = """INSERT INTO telegram_messages (channel_id, message_id, published_at, text)
                   SELECT n.channel_id, n.message_id, n.published_at, n.text
                   FROM new_messages AS n JOIN telegram_channels USING (channel_id)
                   ON CONFLICT DO NOTHING"""
# A channel's last message only moves forward: a run that overlaps another can't move it back
SAVE_LAST = """UPDATE telegram_channels AS c
               SET last_message_id = n.last_message_id, last_message_at = n.last_message_at
               FROM new_last AS n
               WHERE c.channel_id = n.channel_id
                 AND (c.last_message_id IS NULL OR n.last_message_id > c.last_message_id)"""


async def fetch_page(session, username, after, proxy):
    """Ask for the messages after one, through one proxy. Returns (outcome, messages): "ok" with the messages in the
    answer, oldest first (none when there are none), else a problem from telegram.call()."""
    problem, response = await call(session, proxy, AFTER.format(username, after), light=True)
    if problem:
        return problem, None
    try:
        return "ok", messages(json.loads(response.text))
    except (ValueError, TypeError, AttributeError):
        return "broken", None  # not a JSON string: the proxy mangled the answer


async def read_channel(pool, session, channel_id, username, last):
    """Read one channel's new messages, page by page, from after its last message (last) until an empty answer.
    Returns (outcome, pages): outcome is "new messages", "nothing new", "other channel" (the username belongs to
    another channel now: nothing it brought counts) or "failed" (a page failed every try: the pages before it count,
    and the next run continues after them). pages are (its messages with text, the new last message's ID, its time),
    one per page read. An album that began before last but ends after it moves last on, without being kept again."""
    pages = []
    while True:
        outcome, found = await pool.run(partial(fetch_page, session, username, last))
        if outcome != "ok":
            return "failed", pages
        newer = [message for message in found if message.last > last]
        if not newer:  # an empty answer, or nothing newer: no page ever loops
            return ("new messages" if pages else "nothing new"), pages
        if any(message.channel_id not in (None, channel_id) for message in newer):
            return "other channel", []
        newest = max(newer, key=lambda message: message.last)
        pages.append(([message for message in newer if message.id > last and message.text], newest.last,
                      newest.published_at))
        last = newest.last


class Messages(Collector):
    attempts = ATTEMPTS
    item_name = "channels"
    saved_name = "new messages"

    def load(self, conn, argument):
        return conn.execute("""SELECT channel_id, username, last_message_id FROM telegram_channels
                               WHERE last_message_id IS NOT NULL ORDER BY last_message_at DESC""").fetchall()

    def describe(self, argument):
        return "Telegram channels to read the new messages of"

    async def prepare(self, conn, channels):
        self.pending = []  # (channel_id, a page's messages with text, the new last message's ID, its time)
        for table in (NEW_MESSAGES, NEW_LAST):
            await conn.execute(table)

    async def test(self, session, proxy):
        return await fetch_page(session, TEST_CHANNEL, TEST_AFTER, proxy)

    async def handle(self, pool, session, channel):
        channel_id, username, last = channel
        outcome, pages = await read_channel(pool, session, channel_id, username, last)
        self.pending.extend((channel_id, *page) for page in pages)
        self.results["pages"] += len(pages)
        self.results["messages with text"] += sum(len(page[0]) for page in pages)
        return outcome

    async def save(self, conn):
        """Write the messages read since the last save, and move their channels' last messages on, in one
        transaction. Returns how many messages were added: those already saved don't count."""
        pages = self.pending[:]
        self.pending.clear()
        if not pages:
            return 0
        newest = {}  # each channel's last message after these pages: (its ID, its time)
        for channel_id, _, last, published_at in pages:
            if channel_id not in newest or last > newest[channel_id][0]:
                newest[channel_id] = last, published_at
        async with conn.transaction(), conn.cursor() as cur:
            async with cur.copy("COPY new_messages FROM STDIN") as copy:
                for channel_id, texts, _, _ in pages:
                    for message in texts:
                        await copy.write_row((channel_id, message.id, message.published_at, message.text))
            async with cur.copy("COPY new_last FROM STDIN") as copy:
                for channel_id, (last, published_at) in newest.items():
                    await copy.write_row((channel_id, last, published_at))
            await cur.execute(SAVE_MESSAGES)
            added = cur.rowcount
            await cur.execute(SAVE_LAST)
        return added

    def summary(self, results, saved):
        return (f"{results['new messages']} channels with new messages ({results['messages with text']} with text, "
                f"in {results['pages']} pages, {saved} saved), {results['nothing new']} with nothing new, "
                f"{results['other channel']} whose username now belongs to another channel (left as they were), "
                f"{results['failed']} failed (they continue next run)")
