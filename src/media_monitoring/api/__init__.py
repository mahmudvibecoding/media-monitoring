"""The web API: "uv run api" serves it on 127.0.0.1:8000, which only the server itself can reach (see settings.py).
Every path starts with /api, and /api/docs lists them, for admins. Failures are answered as errors.py says, and the logs
are JSON (see logs.py). Accounts and signing in are in accounts.py. "uv run api openapi" writes the API's description
to openapi.json instead, and "uv run api add-admin <email> <name>" adds an admin."""

import asyncio
import json
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

import psycopg
import uvicorn
from fastapi import Depends, FastAPI, Request, Response
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.responses import HTMLResponse, JSONResponse
from psycopg_pool import AsyncConnectionPool
from pydantic import BaseModel

from media_monitoring.api import accounts, errors, logs, status
from media_monitoring.api.settings import load

CONNECTIONS = 2  # database connections kept open
MAX_CONNECTIONS = 10  # at once; the collectors use about 50 of PostgreSQL's 100
CONNECTION_WAIT = 5  # seconds a request waits for a free connection, then gets database_unavailable (503)
QUERY_LIMIT = 5  # seconds a query may run before PostgreSQL cancels it: database_timeout (504)
READY_WITHIN = 2  # seconds the readiness check waits for the database
OPENAPI_FILE = Path(__file__).resolve().parents[3] / "openapi.json"  # at the top of the repo, next to schema.sql

settings = load()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Keeps a pool of database connections while the API runs. The API starts even while the database is down:
    /api/health still answers, and /api/health/ready says the database doesn't."""
    pool = AsyncConnectionPool(
        settings.database_url,
        min_size=CONNECTIONS,
        max_size=MAX_CONNECTIONS,
        timeout=CONNECTION_WAIT,
        kwargs={
            "autocommit": True,
            "application_name": "media_monitoring_api",
            "options": f"-c statement_timeout={QUERY_LIMIT}s",
        },
        check=AsyncConnectionPool.check_connection,  # a connection that broke while idle is replaced, not handed out
        open=False,
    )
    async with pool:
        yield {"pool": pool}


app = FastAPI(
    title="Media monitoring",
    lifespan=lifespan,
    docs_url=None,  # /api/docs and /api/openapi.json are below, for admins only
    openapi_url=None,
    redoc_url=None,
    generate_unique_id_function=lambda route: route.name,  # "status", not FastAPI's "status_api_status_get"
    exception_handlers=errors.HANDLERS,
    responses={500: {"model": errors.Error, "description": "Something went wrong on the server"}},
    dependencies=[Depends(accounts.same_origin)],  # changes only from the site's own pages
)
app.add_middleware(logs.RequestLog, crashed=errors.internal_error)
app.include_router(accounts.router)
app.include_router(status.router)


class Health(BaseModel):
    status: Literal["ok"]


class Readiness(BaseModel):
    status: Literal["ok", "unavailable"]


@app.get("/api/health")
async def health() -> Health:
    """Answers whenever the API runs: for checks that it's up."""
    return Health(status="ok")


@app.get("/api/health/ready", responses={503: {"model": Readiness, "description": "The database doesn't answer"}})
async def ready(request: Request, response: Response) -> Readiness:
    """Answers once the database does too: for checks that the API can serve data."""
    try:
        async with asyncio.timeout(READY_WITHIN), request.state.pool.connection() as conn:
            await conn.execute("SELECT 1")
    except TimeoutError, psycopg.Error:
        response.status_code = 503
        return Readiness(status="unavailable")
    return Readiness(status="ok")


@app.get("/api/openapi.json", include_in_schema=False)
async def openapi(_: accounts.Admin) -> JSONResponse:
    """The API's description, as "uv run api openapi" writes it to openapi.json"""
    return JSONResponse(app.openapi())


@app.get("/api/docs", include_in_schema=False)
async def docs(_: accounts.Admin) -> HTMLResponse:
    """Every endpoint, described and ready to try, from /api/openapi.json"""
    return get_swagger_ui_html(openapi_url="/api/openapi.json", title=f"{app.title} - API")


def main():
    command = sys.argv[1:]
    if command == ["openapi"]:
        # What /api/openapi.json serves, made from the code without starting the server; the same every time until the
        # API changes, so a change shows in the file's diff
        description = app.openapi()
        OPENAPI_FILE.write_text(json.dumps(description, indent=2, ensure_ascii=False) + "\n")
        print(f"wrote {OPENAPI_FILE.name}: {len(description['paths'])} endpoints")
        return
    if command[:1] == ["add-admin"] and len(command) == 3:
        email, name = command[1].strip(), command[2].strip()
        if "@" not in email or " " in email or not name:
            sys.exit("add-admin: give an email and a name")
        try:
            password = accounts.add_admin(settings.database_url, email, name)
        except psycopg.errors.UniqueViolation:
            sys.exit(f"add-admin: there's an account for {email} already")
        print(f"{email} is an admin now. Their temporary password, to change at the first sign-in:\n{password}")
        return
    if command:
        sys.exit(
            "usage: uv run api                          serve the API\n"
            "       uv run api openapi                  write its description to openapi.json\n"
            '       uv run api add-admin <email> <name>  add an admin (the name in quotes: "Ali Valiyev")'
        )
    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        loop="uvloop",
        http="httptools",
        log_config=logs.LOGGING,
        access_log=False,  # RequestLog logs each request instead
    )
