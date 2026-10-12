-- Tables for the collected videos, their latest views and likes, and their comments.
-- (youtube_channels already exists: channels.py fills it.) Safe to run again: it only adds what's missing.
SET client_min_messages = warning;  -- don't list everything that already exists

CREATE TABLE IF NOT EXISTS youtube_videos (
    video_id          text PRIMARY KEY,
    channel_id        text NOT NULL REFERENCES youtube_channels,
    title             text,                 -- NULL until details.py has fetched the video's details
    description       text,
    duration_seconds  integer,              -- from the uploads list (videos.py)
    first_seen_at     timestamptz NOT NULL DEFAULT now(),
    status            text NOT NULL DEFAULT 'available',  -- 'unavailable' when its page shows no video
    upload_date       date,                 -- the day only: the video page doesn't show the time
    -- Every video's cover image is at this address; it's computed when read, not stored
    thumbnail_url     text GENERATED ALWAYS AS ('https://i.ytimg.com/vi/' || video_id || '/hqdefault.jpg') VIRTUAL
);
CREATE INDEX IF NOT EXISTS youtube_videos_channel ON youtube_videos (channel_id);

-- Each video's latest views and likes: one small row per video, which stats.py overwrites on every refresh.
-- It's apart from youtube_videos, so a refresh rewrites a few bytes instead of the title and description, and
-- half of each page stays free, so an update fits next to the old row.
CREATE TABLE IF NOT EXISTS youtube_video_stats (
    video_id    text PRIMARY KEY REFERENCES youtube_videos,
    views       bigint,                     -- NULL while a stream is live or upcoming: YouTube shows viewers then
    likes       bigint,                     -- NULL when likes are off, e.g. on videos made for kids
    updated_at  timestamptz NOT NULL
) WITH (fillfactor = 50);

CREATE TABLE IF NOT EXISTS youtube_comments (
    comment_id        text PRIMARY KEY,
    video_id          text NOT NULL REFERENCES youtube_videos,
    parent_id         text,                 -- the comment this one replies to; NULL for top-level comments
    author_channel_id text,
    author_name       text,
    text              text,
    likes             integer,
    reply_count       integer,
    published_text    text,                 -- as YouTube shows it: "2 hours ago"
    published_at      timestamptz,          -- estimated from published_text
    first_seen_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS youtube_comments_video ON youtube_comments (video_id, first_seen_at);
