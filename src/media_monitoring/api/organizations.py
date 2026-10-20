"""Customers' organizations and their people, which admins add and manage (/api/organizations/..., /api/people/...). A
person added gets a temporary password, shown once, for the admin to pass on: it's to be changed at the first sign-in,
as is a new one an admin sets. Disabling a person, or their organization, ends their sessions at once, and they can't
sign in until it's enabled again. Nothing is deleted: an organization or a person once added stays, disabled."""

import asyncio
import logging
from datetime import datetime
from typing import Annotated, Literal

import psycopg
from fastapi import APIRouter, Path, Request
from psycopg.rows import dict_row
from pydantic import BaseModel, Field

from media_monitoring.api.accounts import Admin, hasher, temporary_password
from media_monitoring.api.errors import Failure, failures

NAME_MAX = 200
EMAIL_MAX = 254
log = logging.getLogger("media_monitoring.api")
router = APIRouter()
Id = Annotated[int, Path(ge=1)]


class Organization(BaseModel):
    id: int
    name: str
    people: int  # how many people it has, disabled or not
    created_at: datetime
    disabled: bool


class Person(BaseModel):
    id: int
    email: str
    name: str
    locale: Literal["ru", "uz", "en"]
    must_change_password: bool  # still has a temporary password
    created_at: datetime
    last_sign_in_at: datetime | None
    disabled: bool


class OrganizationDetails(BaseModel):
    organization: Organization
    people: list[Person]  # in the order they were added


class NewOrganization(BaseModel):
    name: str = Field(max_length=NAME_MAX)


class OrganizationChange(BaseModel):
    name: str | None = Field(None, max_length=NAME_MAX)
    disabled: bool | None = None


class NewPerson(BaseModel):
    email: str = Field(max_length=EMAIL_MAX)
    name: str = Field(max_length=NAME_MAX)
    locale: Literal["ru", "uz", "en"] = "ru"


class PersonChange(BaseModel):
    name: str | None = Field(None, max_length=NAME_MAX)
    disabled: bool | None = None


class TemporaryPassword(BaseModel):
    password: str  # shown this once: the person changes it at their first sign-in


class AddedPerson(BaseModel):
    person: Person
    password: str  # their temporary password, shown this once


def clean_name(name: str) -> str:
    """A name without spaces around it, or invalid_name (422) if nothing's left"""
    if not (name := " ".join(name.split())):
        raise Failure(422, "invalid_name", "A name is needed")
    return name


def clean_email(email: str) -> str:
    if "@" not in (email := email.strip()) or any(character.isspace() for character in email):
        raise Failure(422, "invalid_email", "That isn't an email address")
    return email


ORGANIZATIONS = """
    SELECT o.id, o.name, count(u.id) AS people, o.created_at, o.disabled_at IS NOT NULL AS disabled
    FROM app.organizations o LEFT JOIN app.users u ON u.organization_id = o.id
    {where} GROUP BY o.id ORDER BY lower(o.name)
"""
PEOPLE = """
    SELECT id, email, name, locale, must_change_password, created_at, last_sign_in_at, disabled_at IS NOT NULL AS disabled
    FROM app.users WHERE organization_id = %s ORDER BY id
"""
PERSON = """
    SELECT id, email, name, locale, must_change_password, created_at, last_sign_in_at, disabled_at IS NOT NULL AS disabled
    FROM app.users WHERE id = %s AND role = 'customer'
"""


async def organization(conn, organization_id: int) -> Organization:
    """One organization, or not_found (404)"""
    cursor = conn.cursor(row_factory=dict_row)
    row = await (await cursor.execute(ORGANIZATIONS.format(where="WHERE o.id = %s"), [organization_id])).fetchone()
    if row is None:
        raise Failure(404, "not_found", "No organization has that ID")
    return Organization(**row)


async def person(conn, person_id: int) -> Person:
    """One customer, or not_found (404): admins aren't managed here"""
    row = await (await conn.cursor(row_factory=dict_row).execute(PERSON, [person_id])).fetchone()
    if row is None:
        raise Failure(404, "not_found", "No customer has that ID")
    return Person(**row)


ADMINS_ONLY = {
    401: "not_signed_in: no session, or it ended",
    403: "forbidden: only admins may do this; must_change_password: the temporary password isn't changed yet",
}


def described(more: dict[int, str]) -> dict:
    return failures(ADMINS_ONLY | more)


@router.get("/api/organizations", responses=described({}))
async def organizations(request: Request, _: Admin) -> list[Organization]:
    """Every customer organization, by name, with how many people each has."""
    async with request.state.pool.connection() as conn:
        cursor = conn.cursor(row_factory=dict_row)
        rows = await (await cursor.execute(ORGANIZATIONS.format(where=""))).fetchall()
    return [Organization(**row) for row in rows]


@router.post(
    "/api/organizations",
    status_code=201,
    responses=described({409: "name_taken: an organization has that name", 422: "invalid_name: the name is empty"}),
)
async def add_organization(body: NewOrganization, request: Request, user: Admin) -> Organization:
    """Adds a customer organization, without people yet."""
    name = clean_name(body.name)
    async with request.state.pool.connection() as conn:
        try:
            added = await conn.execute("INSERT INTO app.organizations (name) VALUES (%s) RETURNING id", [name])
        except psycopg.errors.UniqueViolation:
            raise Failure(409, "name_taken", "An organization has that name already") from None
        organization_id = (await added.fetchone())[0]
        log.info("organization added", extra={"fields": {"organization": organization_id, "user": user.id}})
        return await organization(conn, organization_id)


@router.get("/api/organizations/{organization_id}", responses=described({404: "not_found: no such organization"}))
async def organization_details(organization_id: Id, request: Request, _: Admin) -> OrganizationDetails:
    """An organization and its people."""
    async with request.state.pool.connection() as conn:
        found = await organization(conn, organization_id)
        rows = await (await conn.cursor(row_factory=dict_row).execute(PEOPLE, [organization_id])).fetchall()
    return OrganizationDetails(organization=found, people=[Person(**row) for row in rows])


@router.patch(
    "/api/organizations/{organization_id}",
    responses=described(
        {
            404: "not_found: no such organization",
            409: "name_taken: another organization has that name",
            422: "invalid_name: the name is empty",
        }
    ),
)
async def change_organization(
    organization_id: Id, body: OrganizationChange, request: Request, user: Admin
) -> Organization:
    """Renames an organization, or disables or enables it: disabled, its people's sessions end at once, and they can't
    sign in until it's enabled again."""
    name = clean_name(body.name) if body.name is not None else None
    async with request.state.pool.connection() as conn, conn.transaction():
        await organization(conn, organization_id)
        try:
            await conn.execute(
                """UPDATE app.organizations SET name = coalesce(%(name)s::text, name),
                       disabled_at = CASE WHEN %(disabled)s::boolean IS NULL THEN disabled_at
                                          WHEN %(disabled)s::boolean THEN coalesce(disabled_at, now()) END
                   WHERE id = %(id)s""",
                {"name": name, "disabled": body.disabled, "id": organization_id},
            )
        except psycopg.errors.UniqueViolation:
            raise Failure(409, "name_taken", "Another organization has that name") from None
        if body.disabled:
            await conn.execute(
                "DELETE FROM app.sessions WHERE user_id IN (SELECT id FROM app.users WHERE organization_id = %s)",
                [organization_id],
            )
        changed = await organization(conn, organization_id)
    log.info(
        "organization changed",
        extra={"fields": {"organization": organization_id, "user": user.id, "disabled": changed.disabled}},
    )
    return changed


@router.post(
    "/api/organizations/{organization_id}/people",
    status_code=201,
    responses=described(
        {
            404: "not_found: no such organization",
            409: "email_taken: an account has that email",
            422: "invalid_name: the name is empty; invalid_email: that isn't an email address",
        }
    ),
)
async def add_person(organization_id: Id, body: NewPerson, request: Request, user: Admin) -> AddedPerson:
    """Adds a person to an organization, as a customer, with a temporary password: it's in the answer, this once, for
    the admin to pass on, and it's to be changed at the first sign-in."""
    name, email = clean_name(body.name), clean_email(body.email)
    password = temporary_password()
    password_hash = await asyncio.to_thread(hasher.hash, password)
    async with request.state.pool.connection() as conn:
        await organization(conn, organization_id)
        try:
            added = await conn.execute(
                """INSERT INTO app.users (email, name, role, password_hash, locale, organization_id)
                   VALUES (%s, %s, 'customer', %s, %s, %s) RETURNING id""",
                [email, name, password_hash, body.locale, organization_id],
            )
        except psycopg.errors.UniqueViolation:
            raise Failure(409, "email_taken", "An account has that email already") from None
        person_id = (await added.fetchone())[0]
        found = await person(conn, person_id)
    log.info("person added", extra={"fields": {"person": person_id, "organization": organization_id, "user": user.id}})
    return AddedPerson(person=found, password=password)


@router.patch(
    "/api/people/{person_id}",
    responses=described({404: "not_found: no such customer", 422: "invalid_name: the name is empty"}),
)
async def change_person(person_id: Id, body: PersonChange, request: Request, user: Admin) -> Person:
    """Renames a customer, or disables or enables them: disabled, their sessions end at once, and they can't sign in
    until enabled again."""
    name = clean_name(body.name) if body.name is not None else None
    async with request.state.pool.connection() as conn, conn.transaction():
        await person(conn, person_id)
        await conn.execute(
            """UPDATE app.users SET name = coalesce(%(name)s::text, name),
                   disabled_at = CASE WHEN %(disabled)s::boolean IS NULL THEN disabled_at
                                      WHEN %(disabled)s::boolean THEN coalesce(disabled_at, now()) END
               WHERE id = %(id)s""",
            {"name": name, "disabled": body.disabled, "id": person_id},
        )
        if body.disabled:
            await conn.execute("DELETE FROM app.sessions WHERE user_id = %s", [person_id])
        changed = await person(conn, person_id)
    log.info("person changed", extra={"fields": {"person": person_id, "user": user.id, "disabled": changed.disabled}})
    return changed


@router.post("/api/people/{person_id}/password", responses=described({404: "not_found: no such customer"}))
async def reset_password(person_id: Id, request: Request, user: Admin) -> TemporaryPassword:
    """Gives a customer a new temporary password, in the answer this once, for the admin to pass on: their sessions
    end, and they change it at their next sign-in."""
    password = temporary_password()
    password_hash = await asyncio.to_thread(hasher.hash, password)
    async with request.state.pool.connection() as conn, conn.transaction():
        await person(conn, person_id)
        await conn.execute(
            "UPDATE app.users SET password_hash = %s, must_change_password = true WHERE id = %s",
            [password_hash, person_id],
        )
        await conn.execute("DELETE FROM app.sessions WHERE user_id = %s", [person_id])
    log.info("password reset", extra={"fields": {"person": person_id, "user": user.id}})
    return TemporaryPassword(password=password)
