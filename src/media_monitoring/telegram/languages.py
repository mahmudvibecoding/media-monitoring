"""Find each Telegram channel's main language, with CLD2 (Google's Compact Language Detector 2), from its title,
description and saved messages joined up, and save it in telegram_channels.language: the code of the language with
the largest share of that text (uz-Arab for Uzbek in Arabic script; NULL when CLD2 can't tell or there's no text).
CLD2 needs no network, so every channel is done in one go: PROCESSES processes take ranges of channel IDs in turn, and
read their messages in the messages table's key order, a channel's messages one after another. Only channels whose
language changed are written.

    uv run telegram languages
"""
import multiprocessing
import os
import re
import time

import psycopg
import pycld2
from psycopg import sql

from media_monitoring import db, runs

PROCESSES = max(1, os.cpu_count() - 4)
RANGES = 8 * PROCESSES  # more ranges than processes, so that one of busy channels can't hold up the end
REPORT_EVERY = 5  # seconds between progress lines
ARABIC = re.compile(r"[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]")
OTHER_LETTERS = re.compile(r"[A-Za-zÀ-ɏЀ-ӿ]")  # Latin and Cyrillic
MESSAGES = """COPY (SELECT channel_id, text FROM telegram_messages WHERE channel_id >= {} AND channel_id < {}
                    ORDER BY channel_id, message_id) TO STDOUT"""
FOUND = "CREATE TEMP TABLE found (channel_id bigint, language text) ON COMMIT DROP"
SAVE = """UPDATE telegram_channels AS c SET language = f.language
          FROM found AS f
          WHERE c.channel_id = f.channel_id AND c.language IS DISTINCT FROM f.language"""
progress = None  # in each process: channels done and changed, shared by all (see start)


def detect(text):
    """A channel's main language from its text: see the top of this file."""
    if not text.strip():
        return None
    try:
        _, _, details = pycld2.detect(text)
    except pycld2.error:  # a character CLD2 won't take: again without what can't be printed
        try:
            _, _, details = pycld2.detect("".join(c for c in text if c.isprintable() or c in "\n\t"))
        except pycld2.error:
            return None
    shares = {code: percent for _, code, percent, _ in details if code != "un" and percent > 0}
    if not shares:
        return None
    # CLD2 also calls Uzbek what's written in Arabic script, like the South Azerbaijani of Iran's channels
    if "uz" in shares and ARABIC.search(text) and len(ARABIC.findall(text)) > len(OTHER_LETTERS.findall(text)):
        shares["uz-Arab"] = shares.pop("uz")
    return max(shares, key=shares.get)


def start(shared):
    global progress
    progress = shared


def work(bounds):
    """The channels with lo <= channel_id < hi: their languages found and saved, in one transaction."""
    lo, hi = bounds
    found = []
    with psycopg.connect(db.DATABASE_URL, autocommit=True) as conn:
        names = {channel: (title, description) for channel, title, description in conn.execute(
            "SELECT channel_id, title, description FROM telegram_channels WHERE channel_id >= %s AND channel_id < %s",
            (lo, hi))}

        def done(channel, texts):
            title, description = names.pop(channel, (None, None))
            found.append((channel, detect("\n".join([t for t in (title, description) if t] + texts))))
            with progress.get_lock():
                progress[0] += 1

        current, texts = None, []
        with conn.cursor() as cur, cur.copy(sql.SQL(MESSAGES).format(sql.Literal(lo), sql.Literal(hi))) as copy:
            copy.set_types(["int8", "text"])
            for channel, text in copy.rows():
                if channel != current:
                    if current is not None:
                        done(current, texts)
                    current, texts = channel, []
                texts.append(text)
        if current is not None:
            done(current, texts)
        for channel in list(names):  # those without a saved message: their title and description alone
            done(channel, [])
        with conn.transaction(), conn.cursor() as cur:
            cur.execute(FOUND)
            with cur.copy("COPY found FROM STDIN") as copy:
                for row in found:
                    copy.write_row(row)
            cur.execute(SAVE)
            with progress.get_lock():
                progress[1] += cur.rowcount


def main():
    with runs.Run("telegram languages") as record, psycopg.connect(db.DATABASE_URL, autocommit=True) as conn:
        total = conn.execute("SELECT count(*) FROM telegram_channels").fetchone()[0]
        cuts = conn.execute("SELECT percentile_disc(%s::float8[]) WITHIN GROUP (ORDER BY channel_id) "
                            "FROM telegram_channels", ([i / RANGES for i in range(1, RANGES)],)).fetchone()[0]
        edges = [0, *sorted(set(cuts)), 2 ** 63 - 1]
        bounds = list(zip(edges, edges[1:]))
        print(f"{total:,} Telegram channels to find the language of, in {len(bounds)} ranges, {PROCESSES} at a time")
        record.update(items=total, item_name="channels", saved_name="changed", processes=PROCESSES,
                      description="Telegram channels to find the language of")
        context = multiprocessing.get_context("spawn")
        shared = context.Array("q", 2)
        started = time.time()
        with context.Pool(PROCESSES, initializer=start, initargs=(shared,)) as pool:
            jobs = pool.imap_unordered(work, bounds)
            remaining = len(bounds)
            last = time.time()
            while remaining:
                try:
                    jobs.next(timeout=1)
                    remaining -= 1
                except multiprocessing.TimeoutError:
                    pass
                if time.time() - last >= REPORT_EVERY or not remaining:
                    last = time.time()
                    took = time.time() - started
                    print(f"{took:6.0f} s  {shared[0]:,} of {total:,} channels done, {shared[1]:,} changed, "
                          f"{shared[0] / max(took, 0.001):,.0f} a second, {len(bounds) - remaining} of "
                          f"{len(bounds)} ranges saved", flush=True)
                    record.update(done=shared[0], saved=shared[1], seconds=round(took, 1))
        counts = conn.execute("SELECT coalesce(language, 'none'), count(*) FROM telegram_channels "
                              "GROUP BY 1 ORDER BY 2 DESC LIMIT 8").fetchall()
        summary = (f"{shared[0]:,} channels in {time.time() - started:.0f} s, {shared[1]:,} changed; languages: "
                   + ", ".join(f"{language} {n:,}" for language, n in counts))
        print(summary)
        record.end("finished", summary, done=shared[0], saved=shared[1], languages=dict(counts))
