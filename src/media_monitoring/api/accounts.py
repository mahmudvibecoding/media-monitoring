"""Accounts: signing in and out, who's signed in, and changing one's own password (/api/auth/...), and the checks other
endpoints use to require someone signed in, or an admin. An account is an admin, who sees and manages everything, or a
customer, a person in an organization, who sees what's its own (organizations.py manages them); app.sql has their
tables. A disabled account, or a customer of a disabled organization, can't sign in, and its sessions end.

Signing in starts a session: a random token in a cookie that the page's scripts can't read, that's sent only over
HTTPS and not with requests that start on another site, and of which the database keeps only a hash. A session lasts
up to SESSION_DAYS, and ends after IDLE_DAYS without use. Passwords are kept as Argon2id hashes, and failed sign-ins
are limited by email and by address."""

import asyncio
import hashlib
import logging
import secrets
from datetime import timedelta
from typing import Annotated, Literal
from urllib.parse import urlsplit

import psycopg
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from fastapi import APIRouter, Depends, Request, Response
from psycopg.rows import dict_row
from pydantic import BaseModel, Field

from media_monitoring.api.errors import Failure, failures

COOKIE = "session"
SESSION_DAYS = 30  # at most, from signing in
IDLE = timedelta(days=7)  # a session unused this long ends
TOUCH_EVERY = timedelta(minutes=5)  # how often a session's last use is written down
WINDOW = timedelta(minutes=15)  # failed sign-ins count for this long
EMAIL_LIMIT = 10  # failures with one email within WINDOW, after which it can't sign in until they're older
ADDRESS_LIMIT = 50  # the same, from one address
PASSWORD_MIN = 10
PASSWORD_MAX = 128

hasher = PasswordHasher()  # Argon2id, with argon2-cffi's settings, which RFC 9106 recommends: 64 MiB, 3 passes
DUMMY_HASH = hasher.hash(secrets.token_urlsafe())  # checked for an email without an account, to take as long
log = logging.getLogger("media_monitoring.api")
router = APIRouter()


class Me(BaseModel):
    id: int
    email: str
    name: str
    role: Literal["admin", "customer"]
    locale: Literal["ru", "uz", "en"]
    must_change_password: bool  # a password an admin set: to be changed before anything else
    organization: str | None = None  # a customer's organization's name; an admin has none


class SignIn(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(max_length=PASSWORD_MAX)


class PasswordChange(BaseModel):
    current: str = Field(max_length=PASSWORD_MAX)
    new: str = Field(max_length=PASSWORD_MAX)


class LocaleChange(BaseModel):
    locale: Literal["ru", "uz", "en"]


def token_hash(token: str) -> bytes:
    return hashlib.sha256(token.encode()).digest()


def client(request: Request) -> str | None:
    """The visitor's address (uvicorn takes it from the X-Forwarded-For header Caddy adds)"""
    return request.client.host if request.client else None


async def verify(password_hash: str, password: str) -> bool:
    """Whether the password is the one the hash was made from. Argon2 takes a while, so it runs off the event loop."""
    try:
        return await asyncio.to_thread(hasher.verify, password_hash, password)
    except VerificationError, InvalidHashError:
        return False


def weak(password: str, email: str, current: str | None = None) -> str | None:
    """What's wrong with a new password, if anything"""
    if len(password) < PASSWORD_MIN:
        return f"A password has at least {PASSWORD_MIN} characters"
    if password.strip().lower() == email.strip().lower():
        return "A password isn't the email"
    if password == current:
        return "The new password is the current one"
    return None


async def same_origin(request: Request) -> None:
    """Changes come only from the site's own pages: a request that changes something, made from another site's page
    (its Origin header names that site), is refused. Requests without an Origin header, like the site's server's, pass.
    """
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return
    origin = request.headers.get("origin")
    host = request.headers.get("x-forwarded-host") or request.headers.get("host")
    if origin is not None and urlsplit(origin).netloc != host:
        raise Failure(403, "cross_site", "Changes come only from the site's own pages")


SESSION_USER = """
    SELECT u.id, u.email, u.name, u.role, u.locale, u.must_change_password, o.name AS organization,
        s.last_used_at < now() - %(touch)s AS untouched
    FROM app.sessions s JOIN app.users u ON u.id = s.user_id LEFT JOIN app.organizations o ON o.id = u.organization_id
    WHERE s.token_hash = %(hash)s AND s.expires_at > now() AND s.last_used_at > now() - %(idle)s
        AND u.disabled_at IS NULL AND o.disabled_at IS NULL
"""


async def signed_in(request: Request) -> Me:
    """Whoever this request's session belongs to, or not_signed_in (401)"""
    token = request.cookies.get(COOKIE)
    if not token:
        raise Failure(401, "not_signed_in", "Not signed in")
    hashed = token_hash(token)
    async with request.state.pool.connection() as conn:
        cursor = conn.cursor(row_factory=dict_row)
        row = await (
            await cursor.execute(SESSION_USER, {"hash": hashed, "touch": TOUCH_EVERY, "idle": IDLE})
        ).fetchone()
        if row is None:
            raise Failure(401, "not_signed_in", "Not signed in")
        if row.pop("untouched"):
            await conn.execute("UPDATE app.sessions SET last_used_at = now() WHERE token_hash = %s", [hashed])
    return Me(**row)


async def active(user: Annotated[Me, Depends(signed_in)]) -> Me:
    """Someone signed in with a password of their own, or must_change_password (403): a temporary password opens
    nothing but its change (and who's signed in, the language, signing out)"""
    if user.must_change_password:
        raise Failure(403, "must_change_password", "The temporary password is to be changed first")
    return user


async def admin(user: Annotated[Me, Depends(active)]) -> Me:
    """An admin who's signed in, or forbidden (403)"""
    if user.role != "admin":
        raise Failure(403, "forbidden", "Only an admin may do this")
    return user


# For endpoints: "user: SignedIn" requires someone signed in, "user: Active" with a password of their own (what
# endpoints with data use), "user: Admin" an admin
SignedIn = Annotated[Me, Depends(signed_in)]
Active = Annotated[Me, Depends(active)]
Admin = Annotated[Me, Depends(admin)]

FAILURES = """
    SELECT count(*) FILTER (WHERE lower(email) = lower(%(email)s)), count(*) FILTER (WHERE ip = %(ip)s::inet)
    FROM app.sign_in_failures WHERE at > now() - %(window)s
"""


async def within_limits(conn, email: str, ip: str | None) -> None:
    """Refuses with too_many_attempts (429) once this email, or this address, failed too often lately"""
    by_email, by_address = await (await conn.execute(FAILURES, {"email": email, "ip": ip, "window": WINDOW})).fetchone()
    if by_email >= EMAIL_LIMIT or by_address >= ADDRESS_LIMIT:
        log.warning("too many failed sign-ins", extra={"fields": {"email": email, "client": ip}})
        wait = str(int(WINDOW.total_seconds()))
        raise Failure(429, "too_many_attempts", "Too many failed sign-ins: try again later", {"Retry-After": wait})


async def record_failure(conn, email: str, ip: str | None) -> None:
    await conn.execute("INSERT INTO app.sign_in_failures (email, ip) VALUES (%s, %s::inet)", [email, ip])
    await conn.execute("DELETE FROM app.sign_in_failures WHERE at < now() - interval '1 day'")


# An account, disabled if it is or if its organization is
USER_BY_EMAIL = """
    SELECT u.id, u.email, u.name, u.role, u.locale, u.must_change_password, u.password_hash, o.name AS organization,
        coalesce(u.disabled_at, o.disabled_at) AS disabled_at
    FROM app.users u LEFT JOIN app.organizations o ON o.id = u.organization_id WHERE lower(u.email) = lower(%s)
"""
START_SESSION = """
    INSERT INTO app.sessions (token_hash, user_id, expires_at, ip, user_agent)
    VALUES (%s, %s, now() + %s, %s::inet, %s)
"""


@router.post(
    "/api/auth/sign-in",
    responses=failures(
        {
            401: "wrong_credentials: the email or the password is wrong",
            403: "account_disabled: the account is disabled",
            429: "too_many_attempts: too many failed sign-ins lately, for this email or from this address",
        }
    ),
)
async def sign_in(body: SignIn, request: Request, response: Response) -> Me:
    """Signs in with an email and a password: the answer starts a session, in a cookie. A wrong password and an email
    without an account get the same answer, after the same time."""
    email, ip = body.email.strip(), client(request)
    async with request.state.pool.connection() as conn:
        await within_limits(conn, email, ip)
        cursor = conn.cursor(row_factory=dict_row)
        user = await (await cursor.execute(USER_BY_EMAIL, [email])).fetchone()
    if not await verify(user["password_hash"] if user else DUMMY_HASH, body.password):
        async with request.state.pool.connection() as conn:
            await record_failure(conn, email, ip)
        log.warning("sign-in failed", extra={"fields": {"email": email, "client": ip}})
        raise Failure(401, "wrong_credentials", "The email or the password is wrong")
    if user["disabled_at"] is not None:
        log.warning("sign-in refused: the account is disabled", extra={"fields": {"user": user["id"], "client": ip}})
        raise Failure(403, "account_disabled", "The account is disabled")
    token = secrets.token_urlsafe(32)
    rehashed = None
    if hasher.check_needs_rehash(user["password_hash"]):  # made with older Argon2 settings than today's
        rehashed = await asyncio.to_thread(hasher.hash, body.password)
    agent = (request.headers.get("user-agent") or "")[:500]
    async with request.state.pool.connection() as conn, conn.transaction():
        await conn.execute(START_SESSION, [token_hash(token), user["id"], timedelta(days=SESSION_DAYS), ip, agent])
        await conn.execute(
            "UPDATE app.users SET last_sign_in_at = now(), password_hash = coalesce(%s, password_hash) WHERE id = %s",
            [rehashed, user["id"]],
        )
        # Ended sessions, anyone's, go
        await conn.execute("DELETE FROM app.sessions WHERE expires_at < now() OR last_used_at < now() - %s", [IDLE])
    response.set_cookie(
        COOKIE, token, max_age=SESSION_DAYS * 24 * 3600, path="/", secure=True, httponly=True, samesite="lax"
    )
    log.info("signed in", extra={"fields": {"user": user["id"], "client": ip}})
    return Me(**{field: user[field] for field in Me.model_fields})


@router.post("/api/auth/sign-out", status_code=204, responses=failures({}))
async def sign_out(request: Request, response: Response) -> None:
    """Ends this browser's session, if it has one, and removes its cookie."""
    token = request.cookies.get(COOKIE)
    if token:
        async with request.state.pool.connection() as conn:
            ended = await conn.execute(
                "DELETE FROM app.sessions WHERE token_hash = %s RETURNING user_id", [token_hash(token)]
            )
            if row := await ended.fetchone():
                log.info("signed out", extra={"fields": {"user": row[0], "client": client(request)}})
    response.delete_cookie(COOKIE, path="/", secure=True, httponly=True, samesite="lax")


@router.get("/api/auth/me", responses=failures({401: "not_signed_in: no session, or it ended"}))
async def me(user: SignedIn) -> Me:
    """Who's signed in."""
    return user


@router.post(
    "/api/auth/password",
    status_code=204,
    responses=failures(
        {
            401: "not_signed_in: no session, or it ended",
            403: "wrong_password: the current password is wrong",
            422: "weak_password: the new password is too short, the email, or the current one",
            429: "too_many_attempts: too many wrong passwords lately",
        }
    ),
)
async def change_password(body: PasswordChange, user: SignedIn, request: Request) -> None:
    """Changes the signed-in user's own password. Their other sessions end; this one goes on."""
    ip = client(request)
    async with request.state.pool.connection() as conn:
        await within_limits(conn, user.email, ip)
        stored = (
            await (await conn.execute("SELECT password_hash FROM app.users WHERE id = %s", [user.id])).fetchone()
        )[0]
    if not await verify(stored, body.current):
        async with request.state.pool.connection() as conn:
            await record_failure(conn, user.email, ip)
        raise Failure(403, "wrong_password", "The current password is wrong")
    if problem := weak(body.new, user.email, body.current):
        raise Failure(422, "weak_password", problem)
    new_hash = await asyncio.to_thread(hasher.hash, body.new)
    this_session = token_hash(request.cookies[COOKIE])
    async with request.state.pool.connection() as conn, conn.transaction():
        await conn.execute(
            "UPDATE app.users SET password_hash = %s, must_change_password = false WHERE id = %s", [new_hash, user.id]
        )
        await conn.execute("DELETE FROM app.sessions WHERE user_id = %s AND token_hash <> %s", [user.id, this_session])
    log.info("password changed", extra={"fields": {"user": user.id, "client": ip}})


@router.post("/api/auth/locale", status_code=204, responses=failures({401: "not_signed_in: no session, or it ended"}))
async def change_locale(body: LocaleChange, user: SignedIn, request: Request) -> None:
    """Saves the signed-in user's language, which the site switches to when they sign in."""
    async with request.state.pool.connection() as conn:
        await conn.execute("UPDATE app.users SET locale = %s WHERE id = %s", [body.locale, user.id])


def temporary_password() -> str:
    """A password for an admin to pass on, to be changed at the first sign-in"""
    return secrets.token_urlsafe(12)


def add_admin(database_url: str, email: str, name: str) -> str:
    """Adds an admin with a temporary password, which they're to change at their first sign-in, and returns it"""
    password = temporary_password()
    with psycopg.connect(database_url, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO app.users (email, name, role, password_hash) VALUES (%s, %s, 'admin', %s)",
            [email, name, hasher.hash(password)],
        )
    return password
