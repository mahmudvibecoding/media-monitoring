-- Tables for the collected videos, the history of their views and likes, and their comments.
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
    views             bigint,
    likes             bigint,               -- NULL when hidden
    comments          bigint,
    stats_at          timestamptz,          -- when views and likes were last refreshed
    upload_date       date,                 -- the day only: the video page doesn't show the time
    -- Every video's cover image is at this address; it's computed when read, not stored
    thumbnail_url     text GENERATED ALWAYS AS ('https://i.ytimg.com/vi/' || video_id || '/hqdefault.jpg') VIRTUAL
);
CREATE INDEX IF NOT EXISTS youtube_videos_channel ON youtube_videos (channel_id);

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
