"""Collect the comments of videos, newest first, top level only (no replies). The first time, a video's whole
comment list is read; after that, only the new comments, down to the first page that ends with one we already have.
A read that stops partway (a page fails, or the run stops) continues next time from where it stopped.

"uv run comments.py" covers the videos uploaded in the last DAYS days, "uv run comments.py 30" the last 30 days,
"uv run comments.py all" every video, and "uv run comments.py unread" every video whose whole list hasn't been read
yet. Each video's total comment count, as YouTube shows it, goes next to its views and likes, so run stats.py first.

It uses the free proxies (plain_proxies.py) and the VPN ones from sing-box, and follows both lists while it runs:
refresh them (the proxy refresher does, every 15 minutes) and new proxies join within a minute.
"""
import asyncio
import base64
import math
import os
import re
import sys
import time
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor, wait
from datetime import datetime, timedelta, timezone
from functools import partial
from multiprocessing import get_context
from urllib.parse import quote

import psycopg
from curl_cffi import AsyncSession

from pool import (API, ATTEMPTS, CONTEXT, LONG_REST, PLAIN_PROXY_FILE, PROXY_FILE, NoProxiesLeft, Pool, call,
                  load_proxies, load_share, raise_open_files_limit)

DATABASE_URL = os.environ.get("DATABASE_URL", "dbname=media_monitoring")
# Saves don't wait for the disk to confirm them: a crash loses at most the last second of saves, which the next
# run fetches again
NO_WAIT = "-c synchronous_commit=off"
PROCESSES = max(1, os.cpu_count() - 4)  # each runs its own event loop; a few cores stay free for sing-box
CONCURRENCY = 500  # videos in progress at a time, per process
DAYS = 90  # by default, the videos uploaded in the last DAYS days
EMPTY_PAGE_TRIES = 3  # an empty page in the middle of a list is usually an odd answer: ask this many times
SAVE_EVERY = 20  # during a long read, every this many pages note where to continue, in case the run stops
END, KNOWN, INVALID = object(), object(), object()  # how a read of pages ended (see read_video)
# Saving normally keeps up, so a process holds a few thousand unsaved comments. Only if it falls this far behind do
# its videos wait before their next page, so the server can't run out of memory (which would crash PostgreSQL)
MAX_UNSAVED = 250_000
ITEMS = ("continuationItems(commentsHeaderRenderer/countText/runs/text,"
         "continuationItemRenderer/continuationEndpoint/continuationCommand/token)")
FIELDS = (f"onResponseReceivedEndpoints(reloadContinuationItemsCommand/{ITEMS},appendContinuationItemsAction/{ITEMS}),"
          "frameworkUpdates/entityBatchUpdate/mutations/payload/commentEntityPayload("
          "properties(commentId,content/content,publishedTime,replyLevel),author(channelId,displayName))")
URL = API + "next?prettyPrint=false&fields=" + FIELDS
COUNT = re.compile(r"[\d,]+")  # "15,925 Comments"
AGO = re.compile(r"(\d+) (second|minute|hour|day|week|month|year)s? ago")  # "2 hours ago (edited)"
SECONDS = {"second": 1, "minute": 60, "hour": 3600, "day": 86400, "week": 7 * 86400, "month": 30 * 86400,
           "year": 365 * 86400}

# Comments go straight into the table with COPY, PostgreSQL's fastest way to add rows. Only if a batch has a comment
# that's already saved does it go the slower way, through new_comments, which skips those.
COPY_COMMENTS = """COPY youtube_comments (video_id, comment_id, author_channel_id, author_name, text, published_text,
                   published_at) FROM STDIN"""
NEW_COMMENTS = """CREATE TEMP TABLE new_comments (video_id text, comment_id text, author_channel_id text,
                  author_name text, text text, published_text text, published_at timestamptz) ON COMMIT DELETE ROWS"""
SAVE_COMMENTS = """INSERT INTO youtube_comments (video_id, comment_id, author_channel_id, author_name, text,
                                                published_text, published_at)
                   SELECT * FROM new_comments ON CONFLICT DO NOTHING"""
VIDEO_COUNTS = """CREATE TEMP TABLE video_counts (video_id text, comments bigint, complete boolean, resume text)
                  ON COMMIT DELETE ROWS"""
# A failed read keeps the count it had
SAVE_COUNTS = """UPDATE youtube_video_stats AS s
                 SET comments = coalesce(c.comments, s.comments), comments_complete = c.complete,
                     comments_resume = c.resume
                 FROM video_counts AS c WHERE s.video_id = c.video_id"""
VIDEO_PROGRESS = "CREATE TEMP TABLE video_progress (video_id text, resume text) ON COMMIT DELETE ROWS"
SAVE_PROGRESS = """UPDATE youtube_video_stats AS s SET comments_resume = p.resume
                   FROM video_progress AS p WHERE s.video_id = p.video_id"""
LOAD_KNOWN = "SELECT video_id, comment_id FROM youtube_comments WHERE video_id = ANY(%s)"
LOAD_STATE = """SELECT video_id, comments_complete, comments_resume FROM youtube_video_stats
                WHERE (comments_complete OR comments_resume IS NOT NULL) AND video_id = ANY(%s)"""

done = None  # in each worker process: [videos finished, new comments], counted by all processes together


def first_token(video_id):
    """The token for the first page of a video's comments, newest first, built from its ID: what the video's page
    asks for when you sort its comments by newest."""
    raw = (b"\x12\x0d\x12\x0b" + video_id.encode() + b"\x18\x06\x32\x25\x22\x11\x22\x0b" + video_id.encode()
           + b"\x30\x01\x78\x02\x42\x10comments-section")
    return quote(base64.urlsafe_b64encode(raw).decode())


def text(value):
    """Text as PostgreSQL can store it: without NUL characters."""
    return value.replace("\x00", "") if value else value


def published(shown, now):
    """When a comment was posted, estimated from what YouTube shows ("2 hours ago"); None if it doesn't say."""
    match = AGO.search(shown or "")
    return now - timedelta(seconds=int(match.group(1)) * SECONDS[match.group(2)]) if match else None


def parse_page(data):
    """(count, comments, next page's token) from one page of comments. count is the total YouTube shows, replies
    included (only the first page has it); comments are (comment_id, author_channel_id, author_name, text,
    published_text), top level only, in the page's order."""
    count = token = None
    for endpoint in data.get("onResponseReceivedEndpoints") or []:
        for action in endpoint.values():
            for item in action.get("continuationItems") or []:
                if "commentsHeaderRenderer" in item:
                    shown = "".join(run["text"] for run in item["commentsHeaderRenderer"]["countText"]["runs"])
                    match = COUNT.search(shown)
                    count = int(match.group().replace(",", "")) if match else None
                elif "continuationItemRenderer" in item:
                    token = item["continuationItemRenderer"]["continuationEndpoint"]["continuationCommand"]["token"]
    comments = []
    for mutation in data.get("frameworkUpdates", {}).get("entityBatchUpdate", {}).get("mutations") or []:
        entity = mutation.get("payload", {}).get("commentEntityPayload")
        if entity and not entity["properties"].get("replyLevel"):
            properties, author = entity["properties"], entity.get("author") or {}
            comments.append((properties["commentId"], author.get("channelId"), text(author.get("displayName")),
                             text((properties.get("content") or {}).get("content")), properties.get("publishedTime")))
    return count, comments, token


async def fetch_page(session, token, proxy):
    """One page of a video's comments through one proxy. Returns (outcome, (count, comments, next_token))."""
    problem, response = await call(session, proxy, "POST", URL, json={"context": CONTEXT, "continuation": token})
    if problem:
        return problem, None
    try:
        data = response.json()
    except Exception:
        return "broken", None  # not YouTube's answer: the proxy mangled it
    try:
        return "ok", parse_page(data)
    except (KeyError, TypeError, ValueError, AttributeError):
        return "youtube error", None  # an answer in an unexpected shape; the next try gets it


async def read_video(pool, session, video_id, known, complete, resume, pending, counts, progress):
    """Read one video's comments, newest first, adding the new ones to pending. First from the top: down to the first
    page that ends with a comment we already have if its whole list was read before (complete) or an earlier read
    left a place to continue from (resume), else the whole list. Then, with resume, from that place on: to the end,
    or for a complete video (where the place marks a gap) down to comments we already have. Adds (video_id, count,
    complete, resume) to counts once done: if a page failed, resume is where to continue next time.
    Returns "ok" or "failed"."""
    now, seen, count = datetime.now(timezone.utc), set(), None

    async def read(token, stop_at_known, top):
        """Pages from token on. Returns END or KNOWN when done, INVALID if a saved token no longer works, or the
        token of the page that failed, to continue from later."""
        nonlocal count
        pages = empty_tries = 0
        while token:
            while len(pending) > MAX_UNSAVED:
                await asyncio.sleep(0.5)
            result, page = await pool.run(partial(fetch_page, session, token))
            if result != "ok":
                return token
            page_count, comments, next_token = page
            if not comments and not next_token and (pages or not top):
                # An empty page where the list should go on is usually an odd answer: ask again. A saved token that
                # keeps getting one no longer works (YouTube answers {} to those too).
                if empty_tries < EMPTY_PAGE_TRIES:
                    empty_tries += 1
                    continue
                if not pages:
                    return INVALID
            if top and not pages:
                count = page_count
            for comment in comments:
                if comment[0] not in known and comment[0] not in seen:  # a comment can show up again on the next page
                    seen.add(comment[0])
                    pending.append((video_id, *comment, published(comment[4], now)))
            if stop_at_known and comments and comments[-1][0] in known:
                return KNOWN  # reached the comments we already have (a pinned one comes first: it can't end a page)
            token, pages = next_token, pages + 1
            if token and pages % SAVE_EVERY == 0:
                progress.append((video_id, token))  # where to continue if this run stops before the video is done
        return END

    left = await read(first_token(video_id), stop_at_known=complete or resume is not None, top=True)
    if left is KNOWN and resume:
        left = await read(resume, stop_at_known=complete, top=False)
        if left is INVALID:  # the saved place no longer works: read the whole list again
            left = await read(first_token(video_id), stop_at_known=False, top=True)
    finished = left is END or left is KNOWN
    counts.append((video_id, count, True, None) if finished else (video_id, count, complete, left))
    return "ok" if finished else "failed"


async def save_rows(conn, pending, counts, progress):
    """Write the new comments, the places to continue long reads from, and the finished videos' counts to the
    database, and empty the lists. A video's count is saved with or after all of its comments."""
    rows, finished, places = pending[:], counts[:], dict(progress)  # the latest place for each video
    pending.clear()
    counts.clear()
    progress.clear()
    if rows or finished or places:
        async with conn.transaction(), conn.cursor() as cur:
            if rows:
                try:
                    async with conn.transaction():  # a savepoint: a duplicate only undoes this part
                        async with cur.copy(COPY_COMMENTS) as copy:
                            for row in rows:
                                await copy.write_row(row)
                except psycopg.errors.UniqueViolation:
                    async with cur.copy("COPY new_comments FROM STDIN") as copy:
                        for row in rows:
                            await copy.write_row(row)
                    await cur.execute(SAVE_COMMENTS)
            if places:
                async with cur.copy("COPY video_progress FROM STDIN") as copy:
                    for row in places.items():
                        await copy.write_row(row)
                await cur.execute(SAVE_PROGRESS)
            if finished:  # after the places: a finished read's state wins
                async with cur.copy("COPY video_counts FROM STDIN") as copy:
                    for row in finished:
                        await copy.write_row(row)
                await cur.execute(SAVE_COUNTS)
    return len(rows), len(finished)


def list_changed(path, seen):
    """Whether a proxy list was replaced since it was last seen (seen: {path: modification time})."""
    try:
        modified = os.path.getmtime(path)
    except FileNotFoundError:
        return False
    changed, seen[path] = seen.get(path) != modified, modified
    return changed


async def collect_share(video_ids, share, shares):
    """One process: read its share of the videos through its share of the proxies, saving every 2 seconds."""
    raise_open_files_limit()
    lists = {}
    for path in (PLAIN_PROXY_FILE, PROXY_FILE):
        list_changed(path, lists)
    # Free proxies first: the VPN ones are often blocked from next, and untested proxies are tried in order. Every
    # failed proxy rests 15 minutes (YouTube blocks busy addresses from next for a while), and when all of them rest,
    # requests wait for one to come back or for new ones from the refreshed lists.
    pool = Pool(load_share(PLAIN_PROXY_FILE, share, shares) + load_share(PROXY_FILE, share, shares), rest=LONG_REST,
                give_up=False)
    results, pending, counts, progress = Counter(), [], [], []
    async with await psycopg.AsyncConnection.connect(DATABASE_URL, autocommit=True, options=NO_WAIT) as conn:
        known = defaultdict(set)  # the comments already saved for this process's videos, loaded once
        async with conn.cursor() as cur:
            await cur.execute(LOAD_KNOWN, (video_ids,))
            async for video_id, comment_id in cur:
                known[video_id].add(comment_id)
            await cur.execute(LOAD_STATE, (video_ids,))
            state = await cur.fetchall()
        complete = {video_id for video_id, whole, _ in state if whole}  # their whole list was read once
        resume = {video_id: token for video_id, _, token in state if token}  # where a read stopped partway
        await conn.execute(NEW_COMMENTS)
        await conn.execute(VIDEO_COUNTS)
        await conn.execute(VIDEO_PROGRESS)
        # verify=False: no certificate checks through proxies (all the data is public)
        async with AsyncSession(impersonate="chrome", verify=False, max_clients=CONCURRENCY * ATTEMPTS) as session:
            remaining = iter(video_ids)

            async def worker():
                for video_id in remaining:  # all workers share one iterator
                    try:
                        result = await read_video(pool, session, video_id, known.get(video_id, ()),
                                                  video_id in complete, resume.get(video_id), pending, counts,
                                                  progress)
                    except NoProxiesLeft:
                        return  # this process's proxies all broke; its other videos wait for the next run
                    results[result] += 1
                pool.draining = True  # no new videos left: idle capacity goes to the slowest requests

            stop = asyncio.Event()

            async def saver():
                """Saves every 2 seconds until stopped, then once more. Only this touches the database, so a save
                is never interrupted halfway."""
                while True:
                    try:
                        await asyncio.wait_for(stop.wait(), timeout=2)
                    except TimeoutError:
                        pass
                    stopped = stop.is_set()  # checked before saving: rows added during this save get the next one
                    comments, videos = await save_rows(conn, pending, counts, progress)
                    results["new comments"] += comments
                    with done.get_lock():
                        done[0] += videos
                        done[1] += comments
                    if stopped:
                        return

            async def follow_lists():
                """Every minute: proxies new to the free list join the pool, and when sing-box has restarted with new
                configs, its local proxies are tested again."""
                while not stop.is_set():
                    try:
                        await asyncio.wait_for(stop.wait(), timeout=60)
                    except TimeoutError:
                        pass
                    if list_changed(PLAIN_PROXY_FILE, lists):
                        pool.add(load_share(PLAIN_PROXY_FILE, share, shares))
                    if list_changed(PROXY_FILE, lists):
                        pool.renew(load_share(PROXY_FILE, share, shares))

            saving = asyncio.create_task(saver())
            following = asyncio.create_task(follow_lists())
            try:
                await asyncio.gather(*(worker() for _ in range(min(CONCURRENCY, len(video_ids)))))
            finally:
                await pool.close()
                stop.set()  # also on Ctrl+C or an error: save what we have
                await saving
                await following
    return results, pool.outcomes, len(pool.proven)


def share_counter(counter):
    """Runs first in each worker process."""
    global done
    done = counter


def run_share(video_ids, share, shares):
    """Entry point of each worker process: it runs its own event loop."""
    try:  # if memory runs out, Linux ends a worker first, never PostgreSQL (a crash would empty unlogged tables)
        with open("/proc/self/oom_score_adj", "w") as f:
            f.write("1000")
    except OSError:
        pass  # not Linux
    return asyncio.run(collect_share(video_ids, share, shares))


def main():
    sys.stdout.reconfigure(line_buffering=True)  # print each line right away, also into a log file
    days = sys.argv[1] if len(sys.argv) > 1 else str(DAYS)
    # "unread" leaves out videos without views and likes (stats.py found them removed or private): their count row,
    # where a finished read is recorded, doesn't exist
    where = {"all": "", "unread": "WHERE NOT s.comments_complete OR s.comments_resume IS NOT NULL"}.get(
        days, "WHERE v.upload_date >= current_date - %s::int")
    with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
        # Most viewed first: their long comment lists start early instead of holding up the end of the run
        video_ids = [row[0] for row in conn.execute(
            f"""SELECT v.video_id FROM youtube_videos AS v LEFT JOIN youtube_video_stats AS s USING (video_id)
                {where} ORDER BY s.views DESC NULLS LAST""", () if days in ("all", "unread") else (int(days),))]
    plain, vpn = load_proxies(PLAIN_PROXY_FILE), load_proxies()
    window = {"all": "every video", "unread": "not read in full yet"}.get(days, f"uploaded in the last {days} days")
    print(f"{len(video_ids)} videos to read comments of ({window}), {len(plain)} free proxies and "
          f"{len(vpn)} VPN proxies")
    if not video_ids or not plain + vpn:
        return

    processes = max(1, min(PROCESSES, (len(plain) + len(vpn)) // 50, math.ceil(len(video_ids) / 1000)))
    print(f"reading with {processes} processes...")
    context = get_context("spawn")
    counter = context.Array("q", 2)  # [videos finished, new comments], counted by the worker processes
    started = time.monotonic()
    results, outcomes, working = Counter(), Counter(), 0
    with ProcessPoolExecutor(processes, mp_context=context, initializer=share_counter,
                             initargs=(counter,)) as executor:
        futures = [executor.submit(run_share, video_ids[i::processes], i, processes) for i in range(processes)]
        before, then = 0, started
        while not all(f.done() for f in futures):
            wait(futures, timeout=10)
            now, (videos, comments) = time.monotonic(), counter[:]
            print(f"{now - started:5.0f} s  {videos} of {len(video_ids)} videos done, {comments} new comments, "
                  f"{(videos - before) / (now - then):,.0f} videos/s")
            before, then = videos, now
        for future in futures:
            share_results, share_outcomes, share_working = future.result()
            results += share_results
            outcomes += share_outcomes
            working += share_working
    took = time.monotonic() - started
    print(f"\nfinished in {took:.0f} s: {results['ok']} videos read, {results['failed']} failed (read in full next "
          f"run), {results['new comments']} new comments")
    print(f"requests: {dict(outcomes)}")
    print(f"{working} proxies working at the end")


# Needed for multiple processes: each worker process imports this file and must not run main() again.
if __name__ == "__main__":
    main()
