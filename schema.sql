-- Tables for the monitored channels, their videos, the videos' latest views and likes, and their comments.
-- Safe to run again: it only adds what's missing. (run.sh runs it, and loads the channels from channels.txt.)
SET client_min_messages = warning;  -- don't list everything that already exists

CREATE TABLE IF NOT EXISTS youtube_channels (
    channel_id        text PRIMARY KEY,     -- "UC" and 22 more characters
    title             text,                 -- NULL until the channels collector has fetched the channel's details
    handle            text,
    description       text,
    avatar_url        text,
    subscriber_count  bigint                -- NULL when hidden
);

CREATE TABLE IF NOT EXISTS youtube_videos (
    video_id          text PRIMARY KEY,
    channel_id        text NOT NULL REFERENCES youtube_channels,
    title             text,                 -- NULL until the details collector has fetched the video's details
    description       text,
    duration_seconds  integer,              -- exact, from details; NULL while a stream is live or upcoming
    first_seen_at     timestamptz NOT NULL DEFAULT now(),
    status            text NOT NULL DEFAULT 'available',  -- 'unavailable' when YouTube shows no video
    upload_date       date,                 -- the day of published_at in UTC (kept by older versions without it)
    -- Every video's cover image is at this address; it's computed when read, not stored
    thumbnail_url     text GENERATED ALWAYS AS ('https://i.ytimg.com/vi/' || video_id || '/hqdefault.jpg') VIRTUAL,
    kind              text,                 -- 'video' or 'short', YouTube's own word (from details)
    published_at      timestamptz           -- when YouTube published it, to the second (from details); NULL for
                                            -- a stream or premiere that hasn't started yet
);
ALTER TABLE youtube_videos ADD COLUMN IF NOT EXISTS kind text;  -- for databases made before them
ALTER TABLE youtube_videos ADD COLUMN IF NOT EXISTS published_at timestamptz;
-- Each channel's videos, newest first, with their IDs in the index itself: the videos collector reads every channel's
-- newest ones from it without touching the table. It serves any lookup by channel, so it replaced a plain one.
CREATE INDEX IF NOT EXISTS youtube_videos_channel_newest ON youtube_videos (channel_id, upload_date DESC NULLS FIRST)
    INCLUDE (video_id);
DROP INDEX IF EXISTS youtube_videos_channel;

-- Each video's latest views, likes and comment count: one small row per video, overwritten on every refresh.
-- It's apart from youtube_videos, so a refresh rewrites a few bytes instead of the title and description, and
-- half of each page stays free, so an update fits next to the old row.
CREATE TABLE IF NOT EXISTS youtube_video_stats (
    video_id    text PRIMARY KEY REFERENCES youtube_videos,
    views       bigint,                     -- NULL while a stream is live or upcoming: YouTube shows viewers then
    likes       bigint,                     -- NULL when likes are off, e.g. on videos made for kids
    updated_at  timestamptz NOT NULL,       -- when the stats collector refreshed views and likes
    comments    bigint,                     -- the total YouTube shows, replies included
    comments_complete boolean NOT NULL DEFAULT false, -- the whole comment list has been read once
    comments_resume   text                  -- where a read of the comment list stopped partway: the next page
) WITH (fillfactor = 50);

-- Top-level comments only (no replies), collected by the comments collector. video_id isn't declared a reference to
-- youtube_videos: checking that would make each save also lock and write the video's row. For the first full
-- collection, the table can be made UNLOGGED (much faster saves, but a crash empties it) and switched back with
-- ALTER TABLE youtube_comments SET LOGGED once it's done.
CREATE TABLE IF NOT EXISTS youtube_comments (
    video_id          text NOT NULL,
    comment_id        text NOT NULL,
    author_channel_id text,
    author_name       text,
    text              text,
    published_text    text,                 -- as YouTube shows it: "2 hours ago"
    published_at      timestamptz,          -- estimated from published_text
    first_seen_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (video_id, comment_id)      -- a video's comments sit together, so they load quickly
);

-- Each video's newest comments as of its last finished read, newest first (YouTube's order): what the next read
-- recognizes to stop at, so a run loads these few IDs instead of every saved comment. Written by the comments
-- collector only when they change, and kept out of youtube_video_stats so its rows stay narrow.
CREATE TABLE IF NOT EXISTS youtube_comments_newest (
    video_id  text PRIMARY KEY,
    newest    text[] NOT NULL
);

-- Public Telegram channels to monitor, from a list of channels found through their public pages (2026-09), keyed by
-- Telegram's ID for the channel, which never changes. The username is what their public page, t.me/s/<username>,
-- takes; channels can change it. Title, description and subscriber count come from that page ("uv run telegram
-- channels").
CREATE TABLE IF NOT EXISTS telegram_channels (
    channel_id        bigint PRIMARY KEY,   -- Telegram's ID (lists often write it with a minus sign)
    username          text NOT NULL UNIQUE, -- without the @
    title             text,
    description       text,
    subscriber_count  bigint,               -- exact below 1,000; the page rounds bigger counts to three digits (1.14M)
    -- The last message seen (an album's last item) and when it was published: the collector asks for messages after
    -- it, and checks channels that haven't posted for a while less often. Set from the channel's page while it's
    -- NULL ("uv run telegram channels"); after that, saved with its messages, in one transaction
    last_message_id   integer,
    last_message_at   timestamptz
);

-- Messages of the Telegram channels that have text: the message's own text, or the caption of its photo, video or
-- album. Messages without text aren't kept. Telegram counts each item of an album as a message of its own; here an
-- album is one row, under its first item's message ID.
CREATE TABLE IF NOT EXISTS telegram_messages (
    channel_id        bigint NOT NULL REFERENCES telegram_channels,
    message_id        integer NOT NULL,     -- Telegram's number for the message in its channel
    published_at      timestamptz NOT NULL, -- to the second
    text              text NOT NULL,        -- as plain text, with links kept as addresses
    first_seen_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, message_id)    -- a channel's messages sit together, so they load quickly
);

-- Each saved message's latest views and reactions: one small row per message, overwritten on every refresh. It's
-- apart from telegram_messages, so a refresh rewrites a few bytes instead of the text, and half of each page stays
-- free, so an update fits next to the old row.
CREATE TABLE IF NOT EXISTS telegram_message_stats (
    channel_id        bigint NOT NULL,
    message_id        integer NOT NULL,
    views             bigint,               -- as the page shows them: 90.4K is 90,400; exact below 1,000
    reactions         bigint,               -- all reactions together: each emoji's count added up (0 when none)
    updated_at        timestamptz NOT NULL, -- when views and reactions were last read
    PRIMARY KEY (channel_id, message_id),
    FOREIGN KEY (channel_id, message_id) REFERENCES telegram_messages
) WITH (fillfactor = 50);
