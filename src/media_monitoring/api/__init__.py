"""The web API: "uv run api" serves it on 127.0.0.1:8000, which only the server itself can reach (see settings.py).
Every path starts with /api, and /api/docs lists them."""

import asyncio
from contextlib import asynccontextmanager
from typing import Literal

import psycopg
import uvicorn
from fastapi import FastAPI, Request, Response
from psycopg_pool import AsyncConnectionPool
from pydantic import BaseModel

from media_monitoring.api.settings import load

CONNECTIONS = 2  # database connections kept open
MAX_CONNECTIONS = 10  # at once; the collectors use about 50 of PostgreSQL's 100
READY_WITHIN = 2  # seconds the readiness check waits for the database

settings = load()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Keeps a pool of database connections while the API runs. The API starts even while the database is down:
    /api/health still answers, and /api/health/ready says the database doesn't."""
    pool = AsyncConnectionPool(
        settings.database_url,
        min_size=CONNECTIONS,
        max_size=MAX_CONNECTIONS,
        kwargs={"autocommit": True, "application_name": "media_monitoring_api"},
        check=AsyncConnectionPool.check_connection,  # a connection that broke while idle is replaced, not handed out
        open=False,
    )
    async with pool:
        yield {"pool": pool}


app = FastAPI(
    title="Media monitoring",
    lifespan=lifespan,
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
    redoc_url=None,
)


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


def main():
    uvicorn.run(app, host=settings.host, port=settings.port, loop="uvloop", http="httptools")
