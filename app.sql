-- The website's own tables, in a schema of their own, apart from the collected data: accounts, their sessions and
-- failed sign-ins. The API's database user may read and change these, and nothing else (the collected data stays
-- read-only to it). Then the indexes the site's pages need on the collected data. Safe to run again: it only adds
-- what's missing. deploy.sh runs it before starting a new release.
SET client_min_messages = warning;  -- don't list everything that already exists

CREATE SCHEMA IF NOT EXISTS app;

-- Accounts: admins, who see and manage everything, and customers, each a person, who see what's theirs
CREATE TABLE IF NOT EXISTS app.users (
    id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email                 text NOT NULL,
    name                  text NOT NULL,
    role                  text NOT NULL CHECK (role IN ('admin', 'customer')),
    password_hash         text NOT NULL,                  -- Argon2id
    must_change_password  boolean NOT NULL DEFAULT true,  -- set by an admin: changed at the next sign-in
    locale                text NOT NULL DEFAULT 'ru' CHECK (locale IN ('ru', 'uz', 'en')),
    disabled_at           timestamptz,                    -- NULL while the account may sign in
    created_at            timestamptz NOT NULL DEFAULT now(),
    last_sign_in_at       timestamptz
);
-- One account per email, whatever the case of its letters
CREATE UNIQUE INDEX IF NOT EXISTS users_email ON app.users (lower(email));

-- Each signed-in browser. Only the hash of its token is kept: the token itself is only in the browser's cookie, so
-- this table alone can't be used to sign in.
CREATE TABLE IF NOT EXISTS app.sessions (
    token_hash    bytea PRIMARY KEY,                      -- SHA-256 of the token
    user_id       bigint NOT NULL REFERENCES app.users ON DELETE CASCADE,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_used_at  timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,
    ip            inet,                                   -- where it signed in from
    user_agent    text                                    -- and with what browser
);
CREATE INDEX IF NOT EXISTS sessions_user ON app.sessions (user_id);

-- Failed sign-ins, to limit them by email and by address
CREATE TABLE IF NOT EXISTS app.sign_in_failures (
    at     timestamptz NOT NULL DEFAULT now(),
    email  text NOT NULL,
    ip     inet
);
CREATE INDEX IF NOT EXISTS sign_in_failures_email ON app.sign_in_failures (lower(email), at);
CREATE INDEX IF NOT EXISTS sign_in_failures_ip ON app.sign_in_failures (ip, at);

-- What the site's pages look the collected data up by, which the collectors don't: columns and indexes on schema.sql's
-- tables
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;  -- indexes that find text by any part of it

-- Text as the site's searches compare it: in lowercase, and without apostrophes, which Uzbek writes oʻ and gʻ with in
-- seven ways (Zo'r, Zoʻr, Zo‘r, Zo’r...), so that zor, zo'r and zoʻr all find each other. Columns are made with it:
-- after a change here, they're to be worked out again, or they'd keep what it gave before.
CREATE OR REPLACE FUNCTION app.searchable(value text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    RETURN lower(regexp_replace(value, '[''ʻʼ‘’`´]', '', 'g'));

-- The channel lists show only the channels with something collected, and count only those: a YouTube channel with a
-- video, a Telegram channel with a saved message (55,600 of 55,859 on October 17, 2026, and 298,169 of 310,431 on
-- October 18). Each channel keeps whether it has, set by a trigger as its videos or messages are saved: looked up in
-- their tables instead, counting the listed channels took 0.9 s (YouTube) and 0.3 s (Telegram, with 30,272). Videos
-- and messages aren't deleted, so it doesn't go back.
ALTER TABLE youtube_channels ADD COLUMN IF NOT EXISTS has_videos boolean NOT NULL DEFAULT false;
ALTER TABLE telegram_channels ADD COLUMN IF NOT EXISTS has_messages boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION app.note_videos() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE youtube_channels SET has_videos = true WHERE NOT has_videos AND channel_id IN (SELECT channel_id FROM saved);
    RETURN NULL;
END
$$;
CREATE OR REPLACE TRIGGER app_note_videos AFTER INSERT ON youtube_videos
    REFERENCING NEW TABLE AS saved FOR EACH STATEMENT EXECUTE FUNCTION app.note_videos();

CREATE OR REPLACE FUNCTION app.note_messages() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE telegram_channels SET has_messages = true
    WHERE NOT has_messages AND channel_id IN (SELECT channel_id FROM saved);
    RETURN NULL;
END
$$;
CREATE OR REPLACE TRIGGER app_note_messages AFTER INSERT ON telegram_messages
    REFERENCING NEW TABLE AS saved FOR EACH STATEMENT EXECUTE FUNCTION app.note_messages();

-- The channels whose videos or messages were saved before the triggers: a few seconds the first time, under a second
-- after
UPDATE youtube_channels AS c SET has_videos = true
WHERE NOT has_videos AND EXISTS (SELECT 1 FROM youtube_videos AS v WHERE v.channel_id = c.channel_id);
UPDATE telegram_channels AS c SET has_messages = true
WHERE NOT has_messages AND EXISTS (SELECT 1 FROM telegram_messages AS m WHERE m.channel_id = c.channel_id);

-- The YouTube channels page. Its search looks in each channel's name and handle, kept searchable in a column of their
-- own, which PostgreSQL brings up to date whenever a collector changes them: worked out during each search instead,
-- that took 0.5 s for a search the index can't narrow down, like a single letter. Its order is the biggest first, by
-- an index that holds the search column too, so that a search the trigram index can't narrow reads it alone, not the
-- table. The indexes hold only the listed channels.
ALTER TABLE youtube_channels ADD COLUMN IF NOT EXISTS search_text text
    GENERATED ALWAYS AS (app.searchable(coalesce(title, '') || ' ' || coalesce(handle, ''))) STORED;
CREATE INDEX IF NOT EXISTS youtube_channels_listed_search
    ON youtube_channels USING gin (search_text gin_trgm_ops) WHERE has_videos;
CREATE INDEX IF NOT EXISTS youtube_channels_listed
    ON youtube_channels (subscriber_count DESC NULLS LAST, channel_id) INCLUDE (search_text) WHERE has_videos;

-- The Telegram channels page, in the same way: its search looks in each channel's name and username (with its @), and
-- its orders are the biggest first and the latest to post first.
ALTER TABLE telegram_channels ADD COLUMN IF NOT EXISTS search_text text
    GENERATED ALWAYS AS (app.searchable(coalesce(title, '') || ' @' || username)) STORED;
CREATE INDEX IF NOT EXISTS telegram_channels_listed_search
    ON telegram_channels USING gin (search_text gin_trgm_ops) WHERE has_messages;
CREATE INDEX IF NOT EXISTS telegram_channels_listed
    ON telegram_channels (subscriber_count DESC NULLS LAST, channel_id) INCLUDE (search_text) WHERE has_messages;
CREATE INDEX IF NOT EXISTS telegram_channels_listed_latest
    ON telegram_channels (last_message_at DESC NULLS LAST, channel_id) INCLUDE (search_text) WHERE has_messages;
-- Counting the listed channels, without a search, reads an index of its own: one entry per listed channel, all alike,
-- which PostgreSQL keeps together, a few bytes each. For 298,169 channels it's 2 MB, counted in 40 ms, against 180 ms
-- through an order's index, whose entries hold the search column too
CREATE INDEX IF NOT EXISTS telegram_channels_listed_count ON telegram_channels (has_messages) WHERE has_messages;

-- Indexes the lists no longer read: by name (no list is ordered so any more, nor sorted with app.names), and over
-- every channel, listed or not
DROP INDEX IF EXISTS youtube_channels_name;
DROP INDEX IF EXISTS telegram_channels_name;
DROP COLLATION IF EXISTS app.names;
DROP INDEX IF EXISTS youtube_channels_search;
DROP INDEX IF EXISTS youtube_channels_subscribers;
DROP INDEX IF EXISTS telegram_channels_search;
DROP INDEX IF EXISTS telegram_channels_subscribers;
DROP INDEX IF EXISTS telegram_channels_latest;

-- The API's user (run.sh setup makes it) may read and change every table here, and create none
GRANT USAGE ON SCHEMA app TO media_monitoring_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO media_monitoring_api;
