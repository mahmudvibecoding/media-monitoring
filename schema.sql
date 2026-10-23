-- Tables for the monitored channels, their videos, the videos' latest views and likes, and their comments.
-- Safe to run again: it only adds what's missing. (run.sh runs it, and loads the channels from youtube_channels.txt
-- and telegram_channels.txt.)
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
    last_message_at   timestamptz,
    photo_url         text,                 -- its photo (160 × 160) on Telegram's image server; NULL without one
    -- How far back its history is read ("uv run telegram history"): the oldest message read, text or not (an album's
    -- first item), or 0 once nothing older is left; NULL until it's read back
    history_from      integer,
    letters           bigint NOT NULL DEFAULT 0, -- the letters in its saved messages (see letters() below)
    -- Its main language, as CLD2 finds it in its title, description and saved messages ("uv run telegram
    -- languages"): a code like uz, ru or en, uz-Arab for Uzbek in Arabic script; NULL when CLD2 can't tell
    language          text
);
ALTER TABLE telegram_channels ADD COLUMN IF NOT EXISTS photo_url text;  -- for databases made before it
ALTER TABLE telegram_channels ADD COLUMN IF NOT EXISTS history_from integer;
ALTER TABLE telegram_channels ADD COLUMN IF NOT EXISTS language text;

-- Each channel's photo itself, which the website shows: Telegram's links to it (photo_url) last less than two days, so
-- "uv run telegram channels" downloads it as soon as the channel's page shows a link it hasn't downloaded from yet
CREATE TABLE IF NOT EXISTS telegram_channel_photos (
    channel_id  bigint PRIMARY KEY REFERENCES telegram_channels ON DELETE CASCADE,
    photo       bytea NOT NULL,                     -- JPEG, 160 × 160, about 10 KB
    hash        text NOT NULL,                      -- md5(photo), the version in the website's address for it
    url         text NOT NULL,                      -- the link it was last downloaded from
    saved_at    timestamptz NOT NULL DEFAULT now()  -- when it was last downloaded
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

-- Names labelled in messages, a row a message and labeller: by hand ('hand'), in the 220 posts that name finders are
-- scored on, and the names two of them found in those posts: 'gemma' (Gemma 4 26B, told to copy names as written) and
-- 'minilm' (Multilingual-MiniLM-L12-H384, trained on Gemma's names). names is a list of {"name", "kind" (person,
-- organization or location), "start", "end"}: where it is in the text, in characters (end not included), or null for
-- a name not written so in it; an empty list for a message labelled as having none. A model's names also say how each
-- compares with the hand's, as the scoring matches them ("verdict": right, kind (another kind: "labelled_as" is the
-- hand's), part (a part of a hand's name, or holding one: neither right nor wrong) or extra), and the hand's names
-- that it missed are among them, where the hand placed them ("verdict": missed). The website lists the channels with
-- messages labelled by hand, and marks the names in them.
CREATE TABLE IF NOT EXISTS telegram_message_labels (
    channel_id  bigint NOT NULL,
    message_id  integer NOT NULL,
    source      text NOT NULL,
    names       jsonb NOT NULL,
    PRIMARY KEY (channel_id, message_id, source),
    FOREIGN KEY (channel_id, message_id) REFERENCES telegram_messages ON DELETE CASCADE
);

-- The letters in a text, its links left out: how much a channel has written, which "uv run telegram history" reads
-- its history back up to
CREATE OR REPLACE FUNCTION letters(value text) RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE
    RETURN length(regexp_replace(regexp_replace(value, 'https?://\S+', '', 'g'), '[^[:alpha:]]', '', 'g'));
-- Each channel's letters: in a database made before the column, counted from its saved messages while no channel has
-- any yet (the website reads the table meanwhile), then added to as messages are saved, whichever step saves them
ALTER TABLE telegram_channels ADD COLUMN IF NOT EXISTS letters bigint NOT NULL DEFAULT 0;
UPDATE telegram_channels AS c SET letters = m.letters
FROM (SELECT channel_id, sum(letters(text)) AS letters FROM telegram_messages GROUP BY channel_id) AS m
WHERE c.channel_id = m.channel_id AND m.letters > 0 AND NOT EXISTS (SELECT FROM telegram_channels WHERE letters > 0);
CREATE OR REPLACE FUNCTION count_letters() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE telegram_channels AS c SET letters = c.letters + s.letters
    FROM (SELECT channel_id, sum(letters(text)) AS letters FROM saved GROUP BY channel_id) AS s
    WHERE c.channel_id = s.channel_id AND s.letters > 0;
    RETURN NULL;
END
$$;
CREATE OR REPLACE TRIGGER count_letters AFTER INSERT ON telegram_messages
    REFERENCING NEW TABLE AS saved FOR EACH STATEMENT EXECUTE FUNCTION count_letters();

-- Every run: each round of run.sh, each "uv run proxies", and each run of a step ("uv run youtube comments 90", ...).
-- A run writes its row as it starts, its numbers every few seconds while it goes (updated_at says it's still going),
-- and how it ended; a run killed outright (out of memory, the machine going down) stays "running", and stops
-- updating. The steps a round runs point to it.
CREATE TABLE IF NOT EXISTS runs (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    round_id     bigint REFERENCES runs,        -- the round it ran in; NULL for a round, or a step run by hand
    step         text NOT NULL,                 -- 'round', 'proxies', 'youtube comments', 'telegram messages', ...
    argument     text,                          -- its command line's argument: '90', 'all', ...
    started_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    finished_at  timestamptz,
    outcome      text NOT NULL DEFAULT 'running' CHECK (outcome IN ('running', 'finished', 'stopped', 'failed')),
    numbers      jsonb NOT NULL DEFAULT '{}',   -- what it counted: items to do, done, saved, outcomes, requests, ...
    summary      text                           -- its last line, as it printed it, or why it failed
);
-- For the website's activity pages (see api/activity.py): the rounds and the runs started by hand, newest first; one
-- step's runs; a round's steps
CREATE INDEX IF NOT EXISTS runs_top ON runs (started_at DESC, id DESC) WHERE round_id IS NULL;
CREATE INDEX IF NOT EXISTS runs_step ON runs (step, started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS runs_round ON runs (round_id) WHERE round_id IS NOT NULL;
DROP INDEX IF EXISTS runs_running;  -- what ran now, which no page asks for any more
