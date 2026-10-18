"""Read back the history of the Telegram channels, the channels with the fewest letters first: for each channel in
telegram_channels, ask for the messages before the oldest one read (the request a channel's page makes as you scroll
up), page by page, until its saved messages hold LETTERS letters (links left out, see letters), its first message is
reached, or the messages HISTORY before its last one are; "uv run telegram history 1000" reads up to 1,000 letters
instead. A channel with more to read keeps WINDOW pages asked for at once (see read_back). The messages with text are
kept as the messages step keeps them (see messages.py), those already saved skipped; the channel's last message doesn't
move. How far back each channel is read (history_from) is saved with its messages, in one transaction, so a run that
stops or crashes loses nothing, and the next one goes on from there.

A page Telegram hides from a proxy's address goes out again through another one, up to ATTEMPTS times in all; one that
fails every time ends the channel's read, and once every channel has had its turn, the failed ones are asked again
from where they stopped (see finish). A page whose messages carry another channel's ID means the username now belongs
to that channel: nothing it brought counts. Run it after "uv run proxies": the pool tests the proxies by itself (see
pool.py).
"""
import asyncio
import math
import re
import time
from functools import partial

from media_monitoring.parallel import Collector, run
from media_monitoring.pool import NoProxiesLeft
from media_monitoring.telegram import BEFORE, TEST_CHANNEL, light
from media_monitoring.telegram.messages import (ATTEMPTS, FAILED, NEW_MESSAGES, PAGE, RETRY_AFTER, SAVE_MESSAGES,
                                                WINDOW, Moved)

LETTERS = 100_000  # by default, read a channel back until its saved messages hold LETTERS letters
# A channel is read back at most HISTORY message IDs before its last message: one posting photos without captions for
# years would bring few letters for many pages
HISTORY = 10_000
TEST_BEFORE = 1  # proxies are tested by asking for the messages before the first one: "" comes back
LINK = re.compile(r"https?://\S+")
NEW_HISTORY = """CREATE TEMP TABLE new_history (channel_id bigint, history_from integer) ON COMMIT DELETE ROWS"""
# How far back a channel is read only moves back: a run that overlaps another can't move it forward again
SAVE_HISTORY = """UPDATE telegram_channels AS c SET history_from = n.history_from
                  FROM new_history AS n
                  WHERE c.channel_id = n.channel_id AND (c.history_from IS NULL OR n.history_from < c.history_from)"""
# The channels with fewer letters than the target, the fewest first, whose history isn't read to its first message
# or as far back as HISTORY: each with where its read starts (before the oldest message read; the first time, before
# the oldest saved, or after its last message if none is), the ID at or below which no page is asked for, and how
# many letters it lacks
LOAD = """SELECT channel_id, username, start, last_message_id - %(history)s AS floor, %(target)s - letters AS need
          FROM (SELECT c.channel_id, c.username, c.letters, c.last_message_id,
                       coalesce(c.history_from,
                                (SELECT min(m.message_id) FROM telegram_messages AS m
                                 WHERE m.channel_id = c.channel_id),
                                c.last_message_id + 1) AS start
                FROM telegram_channels AS c
                WHERE c.last_message_id IS NOT NULL AND c.letters < %(target)s
                  AND c.history_from IS DISTINCT FROM 0) AS c
          WHERE start > last_message_id - %(history)s
          ORDER BY letters, channel_id"""


def letters(text):
    """The letters in a text, its links left out, as the database counts them (letters() in schema.sql)."""
    return sum(character.isalpha() for character in LINK.sub("", text))


async def fetch_before(session, username, before, proxy):
    """Ask for the messages before one, through one proxy. Returns (outcome, messages): see telegram.light()."""
    return await light(session, proxy, BEFORE.format(username, before))


async def read_back(pool, session, channel_id, username, start, floor, need):
    """Read one channel's history back from before start (everything from start on is read), until the messages with
    text read hold need letters, its first message is reached, or floor: no page is asked for before an ID at or below
    it. Returns (outcome, texts, read_to, found, pages): outcome is "enough letters", "first message", "limit" (floor
    reached), "other channel" (the username belongs to another channel now: nothing it brought counts) or "failed" (a
    page failed every try: the next run goes on from the last page read without a gap); texts are the messages with
    text read, oldest first; read_to how far back the history is read without a gap (0 once nothing older is left,
    start if nothing was read); found the letters in texts; pages how many answers brought messages.

    Each page needs the oldest message of the one before it, so a long read would go one page at a time. But a
    channel's message IDs are consecutive: after two pages one after another, a channel with more to read keeps WINDOW
    pages asked for at once, the messages before base, base - PAGE, base - 2 * PAGE and so on, the next one going out
    as soon as one comes back. Each answer covers at least the PAGE IDs before where it starts (more where messages
    were deleted; duplicates are dropped), and an empty one marks the channel's first message. The history only counts
    as read as far back as the pages read without a gap."""
    texts, found, pages = {}, 0, 0

    def take(answer, before):
        """Keep one answer's messages older than before. Returns the oldest one's ID, or None if it brought none."""
        nonlocal found, pages
        older = [message for message in answer if message.id < before]
        if not older:
            return None
        if any(message.channel_id not in (None, channel_id) for message in older):
            raise Moved
        pages += 1
        for message in older:
            if message.text and message.id not in texts:
                texts[message.id] = message
                found += letters(message.text)
        return min(message.id for message in older)

    def result(outcome, read_to):
        if outcome == "other channel":
            return outcome, [], start, 0, pages
        return outcome, sorted(texts.values()), read_to, found, pages

    before = start
    try:
        for _ in range(2):  # many channels lack a page or two at most: one after another
            if found >= need:
                return result("enough letters", before)
            if before <= floor:
                return result("limit", before)
            outcome, answer = await pool.run(partial(fetch_before, session, username, before))
            if outcome != "ok":
                return result("failed", before)
            oldest = take(answer, before)
            if oldest is None:
                return result("first message", 0)
            before = oldest
        # Then up to WINDOW pages at a time: page n starts before base - n * PAGE, and as soon as one comes back, the
        # next one goes out, until one comes back empty (the first message) or fails, the letters are found, or the
        # next page would start at or below floor. No more pages are out at once than the letters still lacking need,
        # at the rate the pages read so far brought them: a channel a page or two short isn't asked for ten
        base, asked, answered, stop = before, {}, {}, None

        def room():
            if stop is not None or found >= need:
                return 0
            pages_needed = math.ceil((need - found) / (found / pages)) if found else WINDOW
            return min(WINDOW, pages_needed) - len(asked)

        def ask(n):
            asked[asyncio.ensure_future(pool.run(partial(fetch_before, session, username, base - n * PAGE)))] = n

        following = 0  # the next page to ask for

        def ask_more():
            nonlocal following
            while room() > 0 and base - following * PAGE > floor:
                ask(following)
                following += 1

        ask_more()
        try:
            while asked:
                done, _ = await asyncio.wait(asked, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    n = asked.pop(task)
                    outcome, answer = task.result()
                    answered[n] = take(answer, base - n * PAGE) if outcome == "ok" else FAILED
                    if answered[n] is None or answered[n] is FAILED:
                        stop = n if stop is None else min(stop, n)
                ask_more()
        finally:
            for task in asked:  # left over only when a page belonged to another channel
                task.cancel()
        n = 0  # the history counts as read back through the pages answered without a gap
        while isinstance(answered.get(n), int):
            before = min(before, answered[n])
            n += 1
        if n in answered and answered[n] is None:
            return result("first message", 0)
        if found >= need:
            return result("enough letters", before)
        return result("failed" if answered.get(n) is FAILED else "limit", before)
    except Moved:
        return result("other channel", start)


class History(Collector):
    attempts = ATTEMPTS
    give_up = False  # it can run for hours: when every proxy rests, wait for one to come back or for refreshed lists
    follow_lists = True
    item_name = "channels"
    saved_name = "messages saved"
    argument = f"a number of letters ({LETTERS:,} by default)"
    number = True

    def load(self, conn, argument):
        return conn.execute(LOAD, {"target": int(argument or LETTERS), "history": HISTORY}).fetchall()

    def describe(self, argument):
        return f"Telegram channels to read back, the fewest letters first, up to {int(argument or LETTERS):,} letters"

    async def prepare(self, conn, channels):
        self.pending = []  # (channel_id, its messages with text, how far back it's read now)
        self.failed = []  # (the channel as it stands after its failed read, when it failed), to ask again (see finish)
        for table in (NEW_MESSAGES, NEW_HISTORY):
            await conn.execute(table)

    async def test(self, session, proxy):
        return await fetch_before(session, TEST_CHANNEL, TEST_BEFORE, proxy)

    async def handle(self, pool, session, channel):
        outcome, after = await self.read(pool, session, channel)
        if outcome == "failed":
            self.failed.append((after, time.monotonic()))
        return outcome

    async def read(self, pool, session, channel):
        """Read one channel back, and keep what it brought for the next save. Returns its outcome (see read_back), and
        the channel as it stands after it: where its next read starts, and the letters it still lacks."""
        channel_id, username, start, floor, need = channel
        outcome, texts, read_to, found, pages = await read_back(pool, session, channel_id, username, start, floor, need)
        if texts or read_to != start:
            self.pending.append((channel_id, texts, read_to))
        self.results["pages"] += pages
        self.results["messages with text"] += len(texts)
        self.results["letters"] += found
        return outcome, (channel_id, username, read_to, floor, need - found)

    async def finish(self, pool, session):
        """Ask the channels whose read failed once more, from where it stopped (see RETRY_AFTER). Those it reads no
        longer count as failed."""
        gate = asyncio.Semaphore(self.concurrency)

        async def again(channel, failed_at):
            async with gate:
                await asyncio.sleep(max(0, failed_at + RETRY_AFTER - time.monotonic()))
                try:
                    outcome, _ = await self.read(pool, session, channel)
                except NoProxiesLeft:
                    return
            if outcome != "failed":
                self.results["failed"] -= 1
                self.results[outcome] += 1
                self.results["read when asked again"] += 1

        await asyncio.gather(*(again(channel, failed_at) for channel, failed_at in self.failed))

    async def save(self, conn):
        """Write the messages read since the last save, and how far back their channels are read now, in one
        transaction. Returns how many messages were added: those already saved don't count."""
        reads = self.pending[:]
        self.pending.clear()
        if not reads:
            return 0
        furthest = {}  # how far back each channel is read now: a channel asked again has two reads
        for channel_id, _, read_to in reads:
            furthest[channel_id] = min(read_to, furthest.get(channel_id, read_to))
        async with conn.transaction(), conn.cursor() as cur:
            async with cur.copy("COPY new_messages FROM STDIN") as copy:
                for channel_id, texts, _ in reads:
                    for message in texts:
                        await copy.write_row((channel_id, message.id, message.published_at, message.text))
            async with cur.copy("COPY new_history FROM STDIN") as copy:
                for row in furthest.items():
                    await copy.write_row(row)
            await cur.execute(SAVE_MESSAGES)
            added = cur.rowcount
            await cur.execute(SAVE_HISTORY)
        return added

    def summary(self, results, saved):
        return (f"{results['enough letters']} channels with enough letters now, {results['first message']} read back "
                f"to their first message, {results['limit']} to {HISTORY:,} messages before their last one, "
                f"{results['other channel']} whose username now belongs to another channel (left as they were), "
                f"{results['failed']} failed even when asked again at the end (they go on from there next run; "
                f"{results['read when asked again']} more were read then): {results['pages']} pages, "
                f"{results['messages with text']} messages with text ({results['letters']:,} letters), {saved} saved")


def main():
    run(History)
