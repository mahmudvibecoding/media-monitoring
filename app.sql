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

-- Names in alphabetical order, as people read them: Unicode's order (the database's own, by character codes, would put
-- Zebra before apple), with spaces, punctuation, symbols and currency signs passed over, which many channels' names
-- start with ("    UZ News", "👤 Aziz", "£LUNORIA£"): those would otherwise come first
CREATE COLLATION IF NOT EXISTS app.names (provider = icu, locale = 'und-u-ka-shifted-kv-currency');

-- The YouTube channels page. Its search looks in each channel's name and handle, kept searchable in a column of their
-- own, which PostgreSQL brings up to date whenever a collector changes them: worked out during each search instead,
-- that took 0.5 s for a search the index can't narrow down, like a single letter. Its orders are the biggest first,
-- and by name. Their indexes hold the search column too, so that a search the index can't narrow reads them alone, not
-- the table.
ALTER TABLE youtube_channels ADD COLUMN IF NOT EXISTS search_text text
    GENERATED ALWAYS AS (app.searchable(coalesce(title, '') || ' ' || coalesce(handle, ''))) STORED;
CREATE INDEX IF NOT EXISTS youtube_channels_search ON youtube_channels USING gin (search_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS youtube_channels_subscribers
    ON youtube_channels (subscriber_count DESC NULLS LAST, channel_id) INCLUDE (search_text);
CREATE INDEX IF NOT EXISTS youtube_channels_name
    ON youtube_channels (title COLLATE app.names, channel_id) INCLUDE (search_text);

-- The Telegram channels page, in the same way: its search looks in each channel's name and username (with its @), and
-- its orders are the biggest first, by name, and the latest to post first. By name, the names without a letter or a
-- digit come after the rest: 3,466 channels are called ".", "-", "..." or an emoji, which would fill the first 70 pages.
ALTER TABLE telegram_channels ADD COLUMN IF NOT EXISTS search_text text
    GENERATED ALWAYS AS (app.searchable(coalesce(title, '') || ' @' || username)) STORED;
CREATE INDEX IF NOT EXISTS telegram_channels_search ON telegram_channels USING gin (search_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS telegram_channels_subscribers
    ON telegram_channels (subscriber_count DESC NULLS LAST, channel_id) INCLUDE (search_text);
CREATE INDEX IF NOT EXISTS telegram_channels_name
    ON telegram_channels ((title !~ '[[:alnum:]]'), title COLLATE app.names, channel_id) INCLUDE (search_text);
CREATE INDEX IF NOT EXISTS telegram_channels_latest
    ON telegram_channels (last_message_at DESC NULLS LAST, channel_id) INCLUDE (search_text);

-- The API's user (run.sh setup makes it) may read and change every table here, and create none
GRANT USAGE ON SCHEMA app TO media_monitoring_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO media_monitoring_api;
