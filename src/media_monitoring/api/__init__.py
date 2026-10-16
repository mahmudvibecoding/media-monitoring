"""The web API: "uv run api" serves it on 127.0.0.1:8000, which only the server itself can reach. Every path starts
with /api, and /api/docs lists them."""

from typing import Literal

import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel

HOST = "127.0.0.1"  # not reachable from outside the server
PORT = 8000

app = FastAPI(title="Media monitoring", docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)


class Health(BaseModel):
    status: Literal["ok"]


@app.get("/api/health")
async def health() -> Health:
    """Answers whenever the API runs: for checks that it's up."""
    return Health(status="ok")


def main():
    uvicorn.run(app, host=HOST, port=PORT, loop="uvloop", http="httptools")
