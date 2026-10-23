-- The website's own tables, in a schema of their own, apart from the collected data: customers' organizations,
-- accounts, their sessions and failed sign-ins, and the projects customers are monitored for. The API's database user
-- may read and change these, and nothing else (the collected data stays read-only to it). Then the indexes the site's
-- pages need on the collected data, and the texts' word indexes projects find keywords with. Safe to run again: it
-- only adds what's missing. deploy.sh runs it before starting a new release.
SET client_min_messages = warning;  -- don't list everything that already exists

CREATE SCHEMA IF NOT EXISTS app;

-- Customers: a company or an office, whose people sign in as customers and see only what's its own. Disabling one
-- stops all its people signing in.
CREATE TABLE IF NOT EXISTS app.organizations (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name         text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    disabled_at  timestamptz                             -- NULL while its people may sign in
);
-- One organization per name, whatever the case of its letters
CREATE UNIQUE INDEX IF NOT EXISTS organizations_name ON app.organizations (lower(name));

-- Accounts: admins, who see and manage everything, and customers, each a person in an organization, who see what's
-- its own
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
    last_sign_in_at       timestamptz,
    organization_id       bigint REFERENCES app.organizations  -- a customer's; an admin has none
);
ALTER TABLE app.users ADD COLUMN IF NOT EXISTS organization_id bigint REFERENCES app.organizations;
ALTER TABLE app.users DROP CONSTRAINT IF EXISTS users_customer_organization;
ALTER TABLE app.users ADD CONSTRAINT users_customer_organization
    CHECK ((role = 'customer') = (organization_id IS NOT NULL));
-- One account per email, whatever the case of its letters
CREATE UNIQUE INDEX IF NOT EXISTS users_email ON app.users (lower(email));
-- An organization's people
CREATE INDEX IF NOT EXISTS users_organization ON app.users (organization_id) WHERE organization_id IS NOT NULL;

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

-- Customers' projects: what an organization is monitored for. A text is a project's when it has one of its keywords
-- and none of its exclusions (each a search, app.any_keyword below). Admins set them up; a project once added stays,
-- disabled.
CREATE TABLE IF NOT EXISTS app.projects (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id  bigint NOT NULL REFERENCES app.organizations,
    name             text NOT NULL,
    keywords         text[] NOT NULL DEFAULT '{}',
    exclusions       text[] NOT NULL DEFAULT '{}',
    created_at       timestamptz NOT NULL DEFAULT now(),
    disabled_at      timestamptz                             -- NULL while it's monitored
);
-- One project per name in an organization, whatever the case of its letters
CREATE UNIQUE INDEX IF NOT EXISTS projects_name ON app.projects (organization_id, lower(name));

-- Names labelled in Telegram messages, a row a message and labeller: the posts name finders are scored on, labelled by
-- hand ('hand': Claude's labels as admins correct them on the website; 'claude': Claude's as first made, to see what
-- was corrected), and the names models found in them ('gemma', 'glot500', 'xlmv', 'minilm'). names is a list of
-- {"name" (as written), "kind" (person, organization, location or event), "start", "end"}: where it is in the text, in
-- characters (end not included), or null for a model's name not written so in it; an empty list for a message with
-- none. A labeller's names are compared with the hand's as they're read (api/telegram.py). checked_at, on a 'hand' row,
-- is when an admin marked its names checked, so that what's left to check shows. Before admins could correct them, the
-- table was public.telegram_message_labels, which schema.sql made.
ALTER TABLE IF EXISTS public.telegram_message_labels SET SCHEMA app;
CREATE TABLE IF NOT EXISTS app.telegram_message_labels (
    channel_id  bigint NOT NULL,
    message_id  integer NOT NULL,
    source      text NOT NULL,
    names       jsonb NOT NULL,
    PRIMARY KEY (channel_id, message_id, source),
    FOREIGN KEY (channel_id, message_id) REFERENCES telegram_messages ON DELETE CASCADE
);
ALTER TABLE app.telegram_message_labels ADD COLUMN IF NOT EXISTS checked_at timestamptz;

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

-- Finding keywords in the collected texts (Telegram messages, YouTube videos' titles and descriptions, and their
-- comments) for the customers' projects. A keyword is found at the start of words (Toshkent finds Toshkentda), in
-- whichever script and spelling a text uses: texts and keywords are compared in their matching form, in Uzbek Latin.
-- The form is lowercase, without apostrophes (Uzbek writes oʻ and gʻ with seven different ones), with е written ye at
-- the start of a word or after a vowel, as Uzbek Latin writes it (Европа, Yevropa), and anything that isn't a letter
-- or a digit a space, so that g.Toshkent and kun.uz are words apart. Its words then go through app.matching, which
-- turns Cyrillic into Latin letters by deploy/uzbek_latin.rules (deploy.sh installs them where PostgreSQL reads its
-- dictionaries): Тошкент and Toshkent, Ўзбекистон and Oʻzbekiston, Қўқон and Qoʻqon are the same words, and Russian
-- comes out in the same letters (Ташкент, Tashkent). The texts' word indexes below hold the words these gave when
-- they were built: after a change to the form, the configuration or the rules, they're to be built again (REINDEX).
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_ts_dict WHERE dictname = 'uzbek_latin' AND dictnamespace = 'app'::regnamespace) THEN
        CREATE TEXT SEARCH DICTIONARY app.uzbek_latin (TEMPLATE = public.unaccent, RULES = 'uzbek_latin');
    END IF;
    IF NOT EXISTS (SELECT FROM pg_ts_config WHERE cfgname = 'matching' AND cfgnamespace = 'app'::regnamespace) THEN
        CREATE TEXT SEARCH CONFIGURATION app.matching (COPY = pg_catalog.simple);
    END IF;
END
$$;
ALTER TEXT SEARCH CONFIGURATION app.matching ALTER MAPPING FOR word, numword WITH app.uzbek_latin, simple;

CREATE OR REPLACE FUNCTION app.matching_form(value text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    RETURN regexp_replace(
        regexp_replace(regexp_replace(lower(value), '[''ʻʼ‘’`´]', '', 'g'), '(\mе|(?<=[аеёиоуэюяўaeiou])е)', 'ye', 'g'),
        '[^[:alnum:]]+', ' ', 'g');

-- A keyword as a search: its words in a row, each found at the start of a word, or as whole words when it's in double
-- quotes ("IT" doesn't find "item"); NULL when it has no words
CREATE OR REPLACE FUNCTION app.keyword_query(keyword text) RETURNS tsquery
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    RETURN (SELECT CASE WHEN numnode(q) = 0 THEN NULL
                        WHEN keyword ~ '^\s*".*"\s*$' THEN q
                        ELSE regexp_replace(q::text, '''([^'']+)''', '''\1'':*', 'g')::tsquery END
            FROM phraseto_tsquery('app.matching', app.matching_form(keyword)) AS q);

-- Keywords as one search that finds any of them; NULL when none has words
CREATE OR REPLACE FUNCTION app.any_keyword(keywords text[]) RETURNS tsquery
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    RETURN (SELECT string_agg('(' || q::text || ')', ' | ')::tsquery
            FROM unnest(keywords) AS k, app.keyword_query(k) AS q WHERE q IS NOT NULL);
DROP FUNCTION IF EXISTS app.project_query(text[], text[]);  -- keywords and exclusions in one, which no search reads now

-- The texts' words, in an index per table, with the day each text was published (in Tashkent): a search over recent
-- days reads only their texts' entries. Not quite for a word found at the start of words, though: the entries of every
-- word it starts are gathered first, whatever their day (4.7 s for Tashkent in a day of Telegram's messages, over
-- their eleven years). So Telegram's index holds only the messages from September 2026 on, and its queries say so, for
-- PostgreSQL to read it (api/projects.py): 85 ms for that day. Building them reads every text, and while one is built
-- its table takes no new rows, so on a big database they're built by hand, with collection stopped and many parallel
-- workers (docs/website.md), rather than by a deploy. On October 22, 2026, with 44 workers: YouTube videos' (8
-- million, titles and descriptions) in 2 minutes, 1.2 GB; their comments' (194 million) in 14.5 minutes, 8.1 GB;
-- Telegram's (10 million of its 469 million messages) in 4 minutes, 1.7 GB, where all of them took 1 hour 47 minutes
-- and 44 GB.
CREATE EXTENSION IF NOT EXISTS btree_gin WITH SCHEMA public;  -- for the days' part of these indexes
CREATE OR REPLACE FUNCTION app.day_of(value timestamptz) RETURNS date
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    RETURN (value AT TIME ZONE 'Asia/Tashkent')::date;
CREATE INDEX IF NOT EXISTS youtube_videos_words ON youtube_videos USING gin (
    app.day_of(published_at),
    to_tsvector('app.matching', app.matching_form(coalesce(title, '') || ' ' || coalesce(description, ''))));
CREATE INDEX IF NOT EXISTS youtube_comments_words ON youtube_comments
    USING gin (app.day_of(published_at), to_tsvector('app.matching', app.matching_form(text)));
CREATE INDEX IF NOT EXISTS telegram_messages_words ON telegram_messages
    USING gin (app.day_of(published_at), to_tsvector('app.matching', app.matching_form(text)))
    WHERE published_at >= '2026-09-01 00:00:00+05';

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
