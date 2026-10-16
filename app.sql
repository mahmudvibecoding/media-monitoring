-- The website's own tables, in a schema of their own, apart from the collected data: accounts, their sessions and
-- failed sign-ins. The API's database user may read and change these, and nothing else (the collected data stays
-- read-only to it). Safe to run again: it only adds what's missing. deploy.sh runs it before starting a new release.
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

-- The API's user (run.sh setup makes it) may read and change every table here, and create none
GRANT USAGE ON SCHEMA app TO media_monitoring_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO media_monitoring_api;
