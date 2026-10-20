"""Read back the history of the Telegram channels: for each channel in telegram_channels, ask for the messages before
the oldest one read (the request a channel's page makes as you scroll up), page by page. By default the channels with
the fewest letters go first, each read until its saved messages hold at least LETTERS letters (links left out, see
letters) and at least MESSAGES messages, its first message is reached, or the messages HISTORY before its last one
are; "uv run telegram history 1000" reads up to 1,000 letters instead. "uv run telegram history all" reads every
channel back to its first message, the ones with the most left first. A channel with more to read keeps several
pages asked for at once (see read_back). The messages with text are kept as the messages step keeps them (see
messages.py), those already saved skipped; the channel's last message doesn't move. A read hands over what it brings
as it goes, saved every few seconds with how far back each channel is read now (history_from), in one transaction,
so a run that stops or crashes loses nothing, and the next one goes on from there.

A page Telegram hides from a proxy's address goes out again through another one, up to ATTEMPTS times in all; one that
fails every time ends the channel's read, and once every channel has had its turn, the failed ones are asked again
from where they stopped (see finish). A page whose messages carry another channel's ID means the username now belongs
to that channel: nothing from that page on counts. Run it after "uv run proxies": the pool tests the proxies by
itself (see pool.py).
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

LETTERS = 10_000  # by default, read a channel back until its saved messages hold LETTERS letters
MESSAGES = 100  # and MESSAGES messages
# A channel is read back at most HISTORY message IDs before its last message: one posting photos without captions for
# years would bring few letters for many pages
HISTORY = 10_000
# With "all", each process keeps about IN_FLIGHT pages asked for at once (see Budget): enough to keep it busy, few
# enough that answers don't wait so long for it that they time out. One channel takes MAX_WINDOW of them at most
IN_FLIGHT = 1_000
MAX_WINDOW = 300
# A page that brings nothing older only marks a channel's first message when it starts PAGE IDs or fewer above 0 (see
# read_back). Higher up, Telegram sometimes answers a page with nothing while it's busy: in the first full run
# (2026-10-20), about one channel in 450, though the page came back empty again 5 and 10 seconds later through other
# proxies, and had its messages hours later. A channel's older messages can also be gone. Either way, the read ends
# "empty" with the history read as far as that page, and the page is asked for again at the end of the run (see
# finish) and by the next one.
TEST_BEFORE = 1  # proxies are tested by asking for the messages before the first one: "" comes back
LINK = re.compile(r"https?://\S+")
NEW_HISTORY = """CREATE TEMP TABLE new_history (channel_id bigint, history_from integer) ON COMMIT DELETE ROWS"""
# How far back a channel is read only moves back: a run that overlaps another can't move it forward again
SAVE_HISTORY = """UPDATE telegram_channels AS c SET history_from = n.history_from
                  FROM new_history AS n
                  WHERE c.channel_id = n.channel_id AND (c.history_from IS NULL OR n.history_from < c.history_from)"""
# The channels with fewer letters or messages than the targets, the fewest letters first, whose history isn't read to
# its first message or as far back as HISTORY: each with where its read starts (before the oldest message read; the
# first time, before the oldest saved, or after its last message if none is), the ID at or below which no page is
# asked for, and how many letters and messages it lacks
LOAD = """SELECT channel_id, username, start, last_message_id - %(history)s AS floor,
                 greatest(%(letters)s - letters, 0) AS need, greatest(%(messages)s - saved, 0) AS want
          FROM (SELECT c.channel_id, c.username, c.letters, c.last_message_id, coalesce(s.saved, 0) AS saved,
                       coalesce(c.history_from, s.oldest, c.last_message_id + 1) AS start
                FROM telegram_channels AS c
                LEFT JOIN (SELECT channel_id, count(*) AS saved, min(message_id) AS oldest
                           FROM telegram_messages GROUP BY channel_id) AS s USING (channel_id)
                WHERE c.last_message_id IS NOT NULL AND c.history_from IS DISTINCT FROM 0) AS c
          WHERE (letters < %(letters)s OR saved < %(messages)s) AND start > last_message_id - %(history)s
          ORDER BY letters, channel_id"""
# With "all": every channel whose history isn't read to its first message, the most left first, with no floor and no
# target. Its read starts as in LOAD; the oldest saved message is only looked up for a channel never read back
LOAD_ALL = """SELECT channel_id, username, start, 0 AS floor, NULL AS need, NULL AS want
              FROM (SELECT channel_id, username,
                           coalesce(history_from,
                                    (SELECT min(message_id) FROM telegram_messages AS m
                                     WHERE m.channel_id = c.channel_id),
                                    last_message_id + 1) AS start
                    FROM telegram_channels AS c
                    WHERE last_message_id IS NOT NULL AND history_from IS DISTINCT FROM 0) AS c
              ORDER BY start DESC, channel_id"""


def letters(text):
    """The letters in a text, its links left out, as the database counts them (letters() in schema.sql)."""
    return sum(map(str.isalpha, LINK.sub("", text)))


async def fetch_before(session, username, before, proxy):
    """Ask for the messages before one, through one proxy. Returns (outcome, messages): see telegram.light()."""
    return await light(session, proxy, BEFORE.format(username, before))


class Budget:
    """With "all": the IN_FLIGHT pages a process keeps asked for at once, shared among the channels it reads as what
    each has left to ask for is of what they all have left, from one to MAX_WINDOW each (see read_back). While the
    process is busy, each channel goes as fast as what it has left, so they end about together: the biggest don't keep
    the run going on their own at the end. Whatever the process has left fills the budget: it stays busy to the end."""

    def __init__(self):
        self.left = 0  # the pages left to ask for in the reads under way

    def window(self, mine):
        """How many pages a read with mine pages left to ask for keeps asked for at once."""
        return max(1, min(MAX_WINDOW, math.ceil(IN_FLIGHT * mine / max(self.left, 1))))


async def read_back(pool, session, channel, keep, tally, budget=None):
    """Read one channel's history back. channel is (its ID, username, start, floor, need, want): from before start
    (everything from start on is read), until the messages with text read hold need letters and number want (with
    need None, there's no such target), its first message is reached, or floor: no page is asked for before an ID at
    or below it, nor below 1. What it reads goes to keep(texts, read_to) as it comes, so that a long read holds little:
    texts are messages with text, oldest first, and read_to how far back the history is read without a gap (0 once
    nothing older is left); by then, every message with text from read_to on has gone to keep. tally counts the pages
    that brought messages, the messages with text and, with a target, their letters, as they come. Returns (outcome,
    read_to, found, counted): outcome is "enough", "first message", "empty" (a page above the first PAGE IDs brought
    nothing older: see the top of this file), "limit" (floor reached), "other channel" (the username belongs to
    another channel now: nothing from that page on counts) or "failed" (a page failed every try); after "empty" or
    "failed", the next read goes on from the last page read without a gap. read_to is as above (start if nothing was
    read); found the letters in the messages with text read (with a target), counted how many there were.

    Each page needs the oldest message of the one before it, so a long read would go one page at a time. But a
    channel's message IDs are consecutive: after two pages one after another, a channel with more to read keeps
    several pages asked for at once (see window), the messages before base, base - PAGE, base - 2 * PAGE and so on,
    the next one going out as soon as one comes back. Each answer covers at least the PAGE IDs before where it starts
    (more where messages were deleted; duplicates are dropped): one that starts PAGE IDs or fewer above 0 holds all
    that's left, and an empty one starting there marks the channel's first message. The history only counts as read
    as far back as the pages read without a gap."""
    channel_id, username, start, floor, need, want = channel
    texts, found, counted, pages = {}, 0, 0, 0
    read_to = start
    lowest = max(floor, 0)  # Telegram answers a request for the messages before 0 with the newest ones
    mine = 0  # the pages this read counts in budget.left

    def left_before(before):
        """The pages left to ask for are those before before: say so to budget."""
        nonlocal mine
        if budget:
            left = max(0, math.ceil((before - lowest) / PAGE))
            budget.left += left - mine
            mine = left

    def take(answer, before):
        """Keep one answer's messages older than before. Returns the oldest one's ID, or None if it brought none."""
        nonlocal found, counted, pages
        older = [message for message in answer if message.id < before]
        if not older:
            return None
        if any(message.channel_id not in (None, channel_id) for message in older):
            raise Moved
        pages += 1
        tally["pages"] += 1
        for message in older:  # those from read_to on have gone to keep already
            if message.text and message.id < read_to and message.id not in texts:
                texts[message.id] = message
                counted += 1
                tally["messages with text"] += 1
                if need is not None:  # letters only count towards a target: with none, the database counts them
                    found += (count := letters(message.text))
                    tally["letters"] += count
        return min(message.id for message in older)

    def hand_over(to, everything=False):
        """The history is read back to `to` without a gap: its messages from there on go to keep (with everything,
        all those read, past a gap too)."""
        nonlocal read_to
        done = sorted(message for message in texts.values() if everything or message.id >= to)
        if done or to < read_to:
            for message in done:
                del texts[message.id]
            read_to = min(read_to, to)
            keep(done, read_to)

    def result(outcome, to):
        if outcome != "other channel":
            hand_over(to, everything=True)
        return outcome, read_to, found, counted

    def enough():
        return need is not None and found >= need and counted >= want

    def nothing_before(page_start):
        """The page starting before page_start brought nothing older: the channel's first message, or not (see the
        top of this file)."""
        return result("first message", 0) if page_start <= PAGE + 1 else result("empty", read_to)

    before = start
    left_before(before)
    try:
        for _ in range(2):  # many channels lack a page or two at most: one after another
            if enough():
                return result("enough", before)
            if before <= floor:
                return result("limit", before)
            outcome, answer = await pool.run(partial(fetch_before, session, username, before))
            if outcome != "ok":
                return result("failed", before)
            oldest = take(answer, before)
            if oldest is None:
                return nothing_before(before)
            before = oldest
            hand_over(before)
            left_before(before)
        # Then several pages at a time: page n starts before base - n * PAGE, and as soon as one comes back, the next
        # one goes out, until one comes back empty (the first message) or fails, there are enough letters and
        # messages, or the next page would start at or below floor
        base, asked, answered, stop = before, {}, {}, None
        following = gapless = 0  # the next page to ask for; pages 0 to gapless - 1 came back with messages

        def pages_for(lacking, brought):
            """The pages still needed for what's lacking, at the rate brought so far in pages: WINDOW without one."""
            return 0 if lacking <= 0 else math.ceil(lacking / (brought / pages)) if brought else WINDOW

        def window():
            """How many pages are asked for at once: with budget, the channel's share of it; else no more than the
            letters and messages still lacking need, at the rate the pages read so far brought them, and WINDOW at
            most (a channel a page or two short isn't asked for ten)."""
            if budget:
                return budget.window(mine)
            return min(WINDOW, max(pages_for(need - found, found), pages_for(want - counted, counted)))

        def ask_more():
            nonlocal following
            while stop is None and not enough() and len(asked) < window() and base - following * PAGE > lowest:
                page = pool.run(partial(fetch_before, session, username, base - following * PAGE))
                asked[asyncio.ensure_future(page)] = following
                following += 1
                left_before(base - following * PAGE)

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
                to = read_to
                while isinstance(answered.get(gapless), int):
                    to = min(to, answered[gapless])
                    gapless += 1
                if to < read_to:
                    hand_over(to)
                ask_more()
        finally:
            for task in asked:  # left over only when a page belonged to another channel
                task.cancel()
        if gapless in answered and answered[gapless] is None:
            return nothing_before(base - gapless * PAGE)
        if gapless == following and base - following * PAGE <= lowest and floor <= 0:
            return result("first message", 0)  # every page came back, the last one with all that was left
        if enough():
            return result("enough", read_to)
        return result("failed" if answered.get(gapless) is FAILED else "limit", read_to)
    except Moved:
        return result("other channel", read_to)
    finally:
        left_before(lowest)  # nothing left to ask for


class History(Collector):
    attempts = ATTEMPTS
    give_up = False  # it can run for hours: when every proxy rests, wait for one to come back or for refreshed lists
    follow_lists = True
    item_name = "channels"
    saved_name = "messages saved"
    argument = f"a number of letters ({LETTERS:,} by default), or all"
    words = ("all",)
    number = True
    everything = False  # whether the run reads every channel back to its first message (in the main process)

    def load(self, conn, argument):
        if argument == "all":
            self.everything = True
            # One channel to a batch: at first each process takes one of the biggest in turn, not a batch of them
            self.batch = 1
            return conn.execute(LOAD_ALL).fetchall()
        targets = {"letters": int(argument or LETTERS), "messages": MESSAGES, "history": HISTORY}
        return conn.execute(LOAD, targets).fetchall()

    def describe(self, argument):
        if argument == "all":
            return "Telegram channels to read back to their first message, the most left first"
        return (f"Telegram channels to read back, the fewest letters first, until they have "
                f"{int(argument or LETTERS):,} letters and {MESSAGES} messages")

    async def prepare(self, conn):
        self.budget = Budget()  # for the channels read with no target ("all")
        self.pending = []  # (channel_id, messages with text, how far back it's read now), as the reads hand them over
        # (the channel as it stands after a read that failed or came back empty, that outcome, when), to ask again
        self.failed = []
        for table in (NEW_MESSAGES, NEW_HISTORY):
            await conn.execute(table)

    async def test(self, session, proxy):
        return await fetch_before(session, TEST_CHANNEL, TEST_BEFORE, proxy)

    async def handle(self, pool, session, channel):
        outcome, after = await self.read(pool, session, channel)
        if outcome in ("failed", "empty"):
            self.failed.append((after, outcome, time.monotonic()))
        return outcome

    async def read(self, pool, session, channel):
        """Read one channel back, what it brings kept for the next save as it comes. Returns its outcome (see
        read_back), and the channel as it stands after it: where its next read starts, and the letters and messages
        it still lacks."""
        channel_id, username, start, floor, need, want = channel

        def keep(texts, read_to):
            self.pending.append((channel_id, texts, read_to))

        outcome, read_to, found, counted = await read_back(pool, session, channel, keep, self.results,
                                                           self.budget if need is None else None)
        if need is not None:
            need, want = need - found, want - counted
        return outcome, (channel_id, username, read_to, floor, need, want)

    async def finish(self, pool, session):
        """Ask the channels whose read failed or came back empty (see the top of this file) once more, from where it
        stopped (see RETRY_AFTER). They count with the outcome of this read."""
        gate = asyncio.Semaphore(self.concurrency)

        async def again(channel, first, ended_at):
            async with gate:
                await asyncio.sleep(max(0, ended_at + RETRY_AFTER - time.monotonic()))
                try:
                    outcome, after = await self.read(pool, session, channel)
                except NoProxiesLeft:
                    return
            self.results[first] -= 1
            self.results[outcome] += 1
            if after[2] < channel[2]:  # it got further back
                self.results["read further when asked again"] += 1

        await asyncio.gather(*(again(*failed) for failed in self.failed))

    async def save(self, conn):
        """Write the messages handed over since the last save, and how far back their channels are read now, in one
        transaction. Returns how many messages were added: those already saved don't count."""
        reads = self.pending[:]
        self.pending.clear()
        if not reads:
            return 0
        furthest = {}  # how far back each channel is read now: a channel hands over many times
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
        reached = f"{results['first message']} read back to their first message"
        if not self.everything:
            reached = (f"{results['enough']} channels with enough letters and messages now, {reached}, "
                       f"{results['limit']} to {HISTORY:,} messages before their last one")
        how_long = "" if self.everything else f" ({results['letters']:,} letters)"
        return (f"{reached}, {results['other channel']} whose username now belongs to another channel, "
                f"{results['empty']} whose page above their first messages came back empty and {results['failed']} "
                f"that failed, even when asked again at the end (they go on from there next run; "
                f"{results['read further when asked again']} more were read further then): {results['pages']} pages, "
                f"{results['messages with text']} messages with text{how_long}, {saved} saved")


def main():
    run(History)
