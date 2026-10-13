"""Refresh every channel's details in youtube_channels (title, handle, description, avatar_url, subscriber_count)
from InnerTube, as fast as the proxies answer. Only channels whose details changed are written.

Run it after "uv run proxies": the pool tests the proxies by itself (see pool.py).
"""
from functools import partial

from media_monitoring.parallel import Collector, run
from media_monitoring.youtube import API, CONTEXT, call

URL = API + "browse?prettyPrint=false"
PROFILE = "microformat.microformatDataRenderer.channelProfileMicroformatDetails.profilePage.mainEntity"
FIELD_MASK = ",".join([
    "metadata.channelMetadataRenderer.title",
    "metadata.channelMetadataRenderer.description",
    "metadata.channelMetadataRenderer.avatar",
    f"{PROFILE}.alternateName",
    f"{PROFILE}.interactionStatistic",
    "alerts",  # YouTube's message when a channel doesn't exist
])
CHANNELS = """CREATE TEMP TABLE channels (title text, handle text, description text, avatar_url text,
              subscriber_count bigint, channel_id text) ON COMMIT DELETE ROWS"""
# Only rows whose details changed are written: the others would just be rewritten with the same values
SAVE = """UPDATE youtube_channels AS c
          SET title = n.title, handle = n.handle, description = n.description, avatar_url = n.avatar_url,
              subscriber_count = n.subscriber_count
          FROM channels AS n
          WHERE c.channel_id = n.channel_id
            AND (c.title, c.handle, c.description, c.avatar_url, c.subscriber_count)
                IS DISTINCT FROM (n.title, n.handle, n.description, n.avatar_url, n.subscriber_count)"""

def text(value):
    """Text as PostgreSQL can store it: without NUL characters."""
    return value.replace("\x00", "") if value else value


def parse(data):
    """(title, handle, description, avatar_url, subscriber_count) from InnerTube's answer."""
    meta = data["metadata"]["channelMetadataRenderer"]
    try:
        profile = data["microformat"]["microformatDataRenderer"]["channelProfileMicroformatDetails"][
            "profilePage"]["mainEntity"]
    except (KeyError, TypeError):
        profile = {}
    stats = profile.get("interactionStatistic") or []
    subscribers = int(stats[0]["userInteractionCount"]) if stats else None  # hidden counts are missing
    avatars = (meta.get("avatar") or {}).get("thumbnails") or [{}]
    return (text(meta.get("title")), text(profile.get("alternateName")), text(meta.get("description")),
            avatars[0].get("url"), subscribers)


async def fetch(session, channel_id, proxy):
    """Ask InnerTube for one channel through one proxy. Returns (outcome, row); row is set for "ok"."""
    problem, response = await call(session, proxy, "POST", URL, json={"context": CONTEXT, "browseId": channel_id},
                                   headers={"X-Goog-FieldMask": FIELD_MASK})
    if problem:
        return problem, None
    try:
        data = response.json()
    except Exception:
        return "broken", None  # not YouTube's answer: the proxy mangled it
    try:
        if "metadata" in data:
            return "ok", parse(data) + (channel_id,)
        if data.get("alerts"):  # e.g. "This channel does not exist."
            return "gone", None
    except Exception:
        pass
    return "youtube error", None  # now and then YouTube answers without the page; the next try gets it


class Channels(Collector):
    report_every = 2
    item_name = "channels"
    saved_name = "changed"

    def load(self, conn, argument):
        return [row[0] for row in conn.execute("SELECT channel_id FROM youtube_channels")]

    def describe(self, argument):
        return "channels to refresh"

    async def prepare(self, conn, channel_ids):
        self.pending = []
        await conn.execute(CHANNELS)

    async def handle(self, pool, session, channel_id):
        outcome, row = await pool.run(partial(fetch, session, channel_id))
        if row:
            self.pending.append(row)
        return outcome

    async def save(self, conn):
        """Returns how many channels changed."""
        rows = self.pending[:]
        self.pending.clear()
        if not rows:
            return 0
        async with conn.transaction(), conn.cursor() as cur:
            async with cur.copy("COPY channels FROM STDIN") as copy:
                for row in rows:
                    await copy.write_row(row)
            await cur.execute(SAVE)
            return cur.rowcount

    def summary(self, results, saved):
        return (f"{results['ok']} channels refreshed ({saved} changed), {results['gone']} gone (YouTube says they "
                f"don't exist), {results['failed']} failed")


def main():
    run(Channels)
