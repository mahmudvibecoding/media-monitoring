"""Read the new messages of the Telegram channels: for each channel in telegram_channels that has a last message, ask
for the messages after it (the request a channel's page makes as you scroll down), page by page until an empty
answer, as fast as the proxies answer; a busy channel WAVE pages at a time (see read_channel). The ones with text
are kept (see telegram.messages), and the channel's last message moves to the newest one read, text or not. The
channels that posted most recently go first: they're the likeliest to need several pages.

A page Telegram hides from a proxy's address goes out again through another one, up to ATTEMPTS times in all; one that
fails every time ends the channel's read for this run, and the next run continues after the last page read. A page
whose messages carry another channel's ID means the username now belongs to that channel: nothing it brought counts.
A channel's new messages and its new last message are saved in one transaction, so a run that stops or crashes loses
nothing and saves nothing twice: what wasn't saved is read again. Run it after "uv run proxies": the pool tests the
proxies by itself (see pool.py).
"""
import asyncio
import json
from functools import partial

from media_monitoring.parallel import Collector, run
from media_monitoring.telegram import AFTER, TEST_CHANNEL, call, messages

ATTEMPTS = 10  # requests per page at most: Telegram hides many pages from busy proxies
WAVE = 10  # pages a busy channel's read asks for at once (see read_channel)
PAGE = 20  # the most messages an answer brings: Telegram counts each item of an album as one
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


class Moved(Exception):
    """A page brought another channel's messages: the username belongs to that channel now."""


async def read_channel(pool, session, channel_id, username, last):
    """Read one channel's new messages, from after its last message (last) until an empty answer. Returns (outcome,
    texts, last, published_at, pages): outcome is "new messages", "nothing new", "other channel" (the username belongs
    to another channel now: nothing it brought counts) or "failed" (a page failed every try: the next run continues
    from before it); texts are the new messages with text, oldest first; last and published_at the channel's new last
    message (last unchanged when it doesn't move); pages how many answers brought messages.

    Each page needs the newest message of the one before it, so a long read would go one page at a time. But a
    channel's message IDs are consecutive: after two pages one after another, a channel that has more is read WAVE
    pages at a time, asking for the messages after last, last + PAGE, last + 2 * PAGE and so on at once. Each answer
    covers at least the PAGE IDs after where it starts (more where messages were deleted; duplicates are dropped), and
    an empty one marks the end. The last message only moves as far as the pages read without a gap. An album that
    began before the last message but ends after it moves it on, without being kept again."""
    start, texts, times, pages = last, {}, {}, 0

    def take(found, after):
        """Keep one answer's messages newer than after. Returns the newest one's ID, or None if it brought none."""
        nonlocal pages
        newer = [message for message in found if message.last > after]
        if not newer:
            return None
        if any(message.channel_id not in (None, channel_id) for message in newer):
            raise Moved
        pages += 1
        for message in newer:
            times[message.last] = message.published_at
            if message.id > start and message.text:
                texts[message.id] = message
        return max(message.last for message in newer)

    def result(outcome):
        if outcome == "other channel":
            return outcome, [], start, None, pages
        return outcome, sorted(texts.values()), last, times.get(last), pages

    try:
        for _ in range(2):  # most channels have one page of news at most: one after another
            outcome, found = await pool.run(partial(fetch_page, session, username, last))
            if outcome != "ok":
                return result("failed")
            newest = take(found, last)
            if newest is None:
                return result("new messages" if pages else "nothing new")
            last = newest
        while True:  # then WAVE pages at a time
            starts = [last + n * PAGE for n in range(WAVE)]
            answers = await asyncio.gather(*(pool.run(partial(fetch_page, session, username, after))
                                             for after in starts))
            gap = ended = False
            for after, (outcome, found) in zip(starts, answers):
                if outcome != "ok":
                    gap = True  # the pages after it are kept, but the last message stays before it
                    continue
                newest = take(found, after)
                if newest is None:
                    ended = True  # nothing after this page's start: the channel's end
                elif not gap and after <= last:  # it starts within what's read without a gap
                    last = max(last, newest)
            if gap:
                return result("failed")
            if ended:
                return result("new messages")
    except Moved:
        return result("other channel")


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
        self.pending = []  # (channel_id, its new messages with text, its new last message's ID or None, its time)
        for table in (NEW_MESSAGES, NEW_LAST):
            await conn.execute(table)

    async def test(self, session, proxy):
        return await fetch_page(session, TEST_CHANNEL, TEST_AFTER, proxy)

    async def handle(self, pool, session, channel):
        channel_id, username, last = channel
        outcome, texts, new_last, published_at, pages = await read_channel(pool, session, channel_id, username, last)
        if texts or new_last > last:
            self.pending.append((channel_id, texts, new_last if new_last > last else None, published_at))
        self.results["pages"] += pages
        self.results["messages with text"] += len(texts)
        return outcome

    async def save(self, conn):
        """Write the messages read since the last save, and move their channels' last messages on, in one
        transaction. Returns how many messages were added: those already saved don't count."""
        reads = self.pending[:]
        self.pending.clear()
        if not reads:
            return 0
        newest = {}  # each channel's new last message: (its ID, its time)
        for channel_id, _, last, published_at in reads:
            if last is not None and (channel_id not in newest or last > newest[channel_id][0]):
                newest[channel_id] = last, published_at
        async with conn.transaction(), conn.cursor() as cur:
            async with cur.copy("COPY new_messages FROM STDIN") as copy:
                for channel_id, texts, _, _ in reads:
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


def main():
    run(Messages)
