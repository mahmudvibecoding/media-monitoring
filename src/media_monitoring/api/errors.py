"""Every failure is answered with the same JSON, and the HTTP status that fits: {"error": a fixed code, which the
website turns into words, "message": what happened, in English, for developers, "request_id": the request's ID, as in
the logs}. A crash's details only go to the log."""

import logging
from http import HTTPStatus

import psycopg
from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.exceptions import HTTPException

from media_monitoring.api.logs import request_id

log = logging.getLogger("media_monitoring.api")

# The codes for HTTP's own errors; any other status gets "http_error"
CODES = {400: "bad_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 405: "method_not_allowed"}


class Problem(BaseModel):
    field: str  # where in the request, like "query.limit"
    message: str


class Error(BaseModel):
    # not_found, method_not_allowed, invalid_request, database_unavailable, database_timeout or internal
    error: str
    message: str
    request_id: str
    details: list[Problem] | None = None  # for invalid_request: what's wrong, and where


def error_response(status, error, message, details=None, headers=None):
    body = Error(error=error, message=message, request_id=request_id.get() or "", details=details)
    return JSONResponse(body.model_dump(exclude_none=True), status, headers=headers)


async def http_error(request: Request, exc: HTTPException):
    """An unknown path, a method the path doesn't take, and the like."""
    message = exc.detail if isinstance(exc.detail, str) else HTTPStatus(exc.status_code).phrase
    return error_response(exc.status_code, CODES.get(exc.status_code, "http_error"), message, headers=exc.headers)


async def invalid_request(request: Request, exc: RequestValidationError):
    details = [Problem(field=".".join(map(str, problem["loc"])), message=problem["msg"]) for problem in exc.errors()]
    return error_response(422, "invalid_request", "The request's parameters are wrong", details)


async def database_timeout(request: Request, exc: psycopg.errors.QueryCanceled):
    log.warning("a query ran past the time limit: %s", exc)
    return error_response(504, "database_timeout", "The database didn't answer in time")


async def database_unavailable(request: Request, exc: psycopg.OperationalError):
    """No free connection in time (the pool's PoolTimeout), or the connection failed."""
    log.warning("the database doesn't answer: %s", exc)
    return error_response(503, "database_unavailable", "The database doesn't answer")


def internal_error():
    return error_response(500, "internal", "Something went wrong on the server")


HANDLERS = {
    HTTPException: http_error,
    RequestValidationError: invalid_request,
    psycopg.errors.QueryCanceled: database_timeout,
    psycopg.OperationalError: database_unavailable,
}

# For the docs of endpoints that use the database: what they answer when it fails
DATABASE_ERRORS = {
    503: {"model": Error, "description": "The database doesn't answer"},
    504: {"model": Error, "description": "A query ran past the time limit"},
}
