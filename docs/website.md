# How the website works

The website shows what the system has collected, in Russian, Uzbek and English, at https://198.163.196.164, behind a
shared password. It's two services behind Caddy: the web API, which reads the database, and the site, which renders
the pages. The [README](../README.md) has the commands; this explains how the parts fit, and why.

```
browser ── HTTPS ──> Caddy ── /api/... ──> API (FastAPI, 127.0.0.1:8000) ──> PostgreSQL, read only
                       └──── the rest ───> site (Next.js, 127.0.0.1:3000) ──> API
```

Only Caddy can be reached from outside. It checks the password, gives each request an ID and passes it on. The site
renders each page on the server, asking the API directly, so the page arrives with its data; the browser then asks
`/api/...` through Caddy to keep it fresh.

## The API

- `/api/health` answers while it runs, `/api/health/ready` once the database answers too, `/api/status` with how much
  the database holds, and `/api/docs` lists them all. `openapi.json` in the repo describes them (`uv run api openapi`).
- The counts are PostgreSQL's own running count of each table's rows: reading it takes a millisecond, while counting
  the rows takes 0.15 s for Telegram messages and minutes for the 194 million comments.
- Every failure is the same JSON, `{"error": code, "message", "request_id"}`, with codes like `database_unavailable`
  (503), `database_timeout` (504) and `internal` (500); a crash's details only go to the log.
- A request waits at most 5 s for a database connection, and a query runs at most 5 s.
- It connects as `media_monitoring_api`, which can read the collected data and change none of it. The website's own
  tables, in the schema `app` (`app.sql`: accounts, their sessions and failed sign-ins), it may also change.
- Its log is JSON lines, one per request among them: method, path, status, milliseconds, the visitor's address, and
  the request's ID.

### Accounts

An account is an admin or a customer, each a person; there's no signing up (`uv run api add-admin` adds an admin on
the server). Signing in (`/api/auth/sign-in`) starts a session:
- Its token is in a cookie that page scripts can't read, sent only over HTTPS and not with requests that start on other
  sites; the database keeps only the token's hash, so the table alone can't be used to sign in.
- A session lasts up to 30 days and ends after 7 days unused; signing out, a password change (for the other sessions)
  and disabling the account end it at once.
- Passwords are Argon2id hashes (64 MiB, 3 passes: about 0.2 s to check). A wrong password and an email without an
  account get the same answer, after the same time, so it doesn't show which emails have accounts.
- After 10 failures for an email, or 50 from an address, within 15 minutes, sign-ins wait (429).
- A request that changes something, from another site's page (its Origin header), is refused.
- Sign-ins, failures, sign-outs and password changes go into the log, with the address, never a password.

## The site

- Next.js 16 and React 19 in TypeScript, with shadcn/ui's components on Base UI.
- A visitor sees Russian until choosing Uzbek (Latin script) or English in the header; the choice is kept in a cookie
  for a year. Addresses are the same in every language, since no search engine indexes a site behind a password.
- The texts are in `web/messages/` (`ru.json`, `uz.json`, `en.json`): a key missing from one, or asked for by a page
  but not there, fails the typecheck.
- The font is Inter: Geist, Next's and shadcn's own, has no `ʻ`, which Uzbek writes oʻ and gʻ with.
- `web/src/api/` is the API's client, generated from `openapi.json` (`pnpm api`), so an endpoint or a field the API
  doesn't have fails the typecheck. Requests are built on one placeholder address, `http://api`, on the server and in
  the browser alike, and sent on from it: TanStack Query's keys include that address, and they must match for the
  browser to reuse what the server loaded.
- While rendering, the server waits at most 3 s for the API and doesn't ask again. In the browser, a failed request is
  asked again twice (unless it was wrong), a request waits at most 15 s, and the home page's counts refresh every 30 s.
- A failed request shows a message in the visitor's language, its ID (the one in the API's and Caddy's logs) and a
  button to ask again. A missing page gets a 404 page, a page that fails while rendering gets an error page with its
  code, and if the frame itself fails, a last page says so in all three languages.

## Deploying

`./deploy.sh` installs the clone's current commit in a new release folder, `/opt/media-monitoring/releases`, and
builds the site there; if that fails, what runs isn't touched. Then it points `/opt/media-monitoring/current` at the
release, restarts both services, and checks that they answer within 30 s, or goes back to the release before. It
keeps 3 releases, about 92 MB each (packages are hard-linked from uv's and pnpm's stores), and takes about 27 s.
Building in place would change files the running site serves; a new folder also leaves the one before to go back to.

Python is in `/opt/media-monitoring/python` because the services' users can't read `/root`, where uv puts it. The
services start with the machine and come back 2 s after they stop. The site runs as `media_monitoring_web`, which has
no access to the database. systemd locks both down: the system is read-only to them, they can't see `/root` or
`/home` or gain privileges, and they can reach nothing but this machine (`systemd-analyze security`: 1.1 of 10).

## Caddy

- The certificate is Let's Encrypt's, for the IP address itself; those last about 6 days, and Caddy renews them. With a
  domain, the domain takes the address's place in `deploy/Caddyfile`.
- The user is `monitoring`; the password is in `/etc/caddy/site-password`, which only root can read, and Caddy has only
  its hash. To change it, delete that file and `/etc/caddy/site.env`, then deploy.
- `http://` goes on to `https://`. Answers are compressed and carry security headers: HTTPS only, no framing by other
  sites, no guessing of content types.
- On the server itself the same site answers on http://127.0.0.1:8080, for checks.
- Caddy comes from its own apt repository, not a pinned version: it faces the internet, so its security fixes come with
  `apt upgrade`.

## Versions

Each package is its newest stable release at least a day old (pnpm holds back newer ones, since a hijacked release is
usually pulled within hours), pinned exactly. TypeScript is 6, not 7, which the lint rules' TypeScript support doesn't
cover; ESLint is 10 although Next's lint plugins list only 9, which is no longer supported, and their rules work the
same on it.
