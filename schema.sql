-- Tables for the collected videos, the history of their views and likes, and their comments.
-- (youtube_channels already exists: channels.py fills it.) Safe to run again: it only adds what's missing.
SET client_min_messages = warning;  -- don't list everything that already exists

CREATE TABLE IF NOT EXISTS youtube_videos (
    video_id          text PRIMARY KEY,
    channel_id        text NOT NULL REFERENCES youtube_channels,
    title             text,
    description       text,
    duration_seconds  integer,
    published_at      timestamptz,
    first_seen_at     timestamptz NOT NULL DEFAULT now(),
    status            text NOT NULL DEFAULT 'available',  -- or 'unavailable' (private or removed)
    views             bigint,
    likes             bigint,               -- NULL when hidden
    comments          bigint,
    stats_at          timestamptz           -- when views and likes were last refreshed
);
CREATE INDEX IF NOT EXISTS youtube_videos_channel ON youtube_videos (channel_id, published_at DESC);

-- Every refresh of a video's numbers, to see how it grows. Split into one table per month,
-- so old months can be dropped or archived cheaply.
CREATE TABLE IF NOT EXISTS youtube_video_stats (
    video_id  text NOT NULL REFERENCES youtube_videos,
    at        timestamptz NOT NULL,
    views     bigint,
    likes     bigint,
    comments  bigint,
    PRIMARY KEY (video_id, at)
) PARTITION BY RANGE (at);

-- Monthly parts for this month and the next two.
DO $$
DECLARE
    month date;
BEGIN
    FOR i IN 0..2 LOOP
        month := (date_trunc('month', now()) + make_interval(months => i))::date;
        EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF youtube_video_stats FOR VALUES FROM (%L) TO (%L)',
                       'youtube_video_stats_' || to_char(month, 'YYYY_MM'), month, month + interval '1 month');
    END LOOP;
END $$;

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
