"""The API's logs: one JSON object per line on standard error, for uvicorn's lines, the database pool's and the API's
own. Each request gets an ID, which comes back in the X-Request-ID header and is in every line logged while it's
answered, and the API logs one line per request."""

import json
import logging
import re
import secrets
import time
from contextvars import ContextVar
from datetime import UTC, datetime

request_id: ContextVar[str | None] = ContextVar("request_id", default=None)
GIVEN_ID = re.compile(r"[A-Za-z0-9._-]{1,64}")  # an ID a request comes with is kept if it looks like this

log = logging.getLogger("media_monitoring.api")
requests_log = logging.getLogger("media_monitoring.api.requests")


class JsonFormatter(logging.Formatter):
    """A log line as JSON: time, level, logger, message, the request's ID while one is answered, the fields given as
    extra={"fields": {...}}, and an exception's traceback."""

    def format(self, record):
        line = {
            "time": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(),
            "logger": record.name,
            "message": record.getMessage(),
        }
        if (current := request_id.get()) is not None:
            line["request_id"] = current
        line |= getattr(record, "fields", {})
        if record.exc_info:
            line["error"] = self.formatException(record.exc_info)
        return json.dumps(line, ensure_ascii=False, default=str)


# uvicorn.run's log_config: every logger's lines go to standard error as JSON. The database pool's own notes on each
# connection it hands out are left out, and so is uvicorn's line per request: RequestLog logs one with the request's ID
# and how long it took.
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {"json": {"()": JsonFormatter}},
    "handlers": {"stderr": {"class": "logging.StreamHandler", "formatter": "json"}},
    "root": {"handlers": ["stderr"], "level": "INFO"},
    "loggers": {"psycopg": {"level": "WARNING"}},
}


class RequestLog:
    """ASGI middleware around the whole API: gives each request its ID (the one it came with, if it looks like one, or
    a new one), sends it back in X-Request-ID, and logs a line for the request once it's answered. A crash is answered
    with crashed(), the internal error, and its traceback goes to the log."""

    def __init__(self, app, crashed):
        self.app = app
        self.crashed = crashed

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        given = dict(scope["headers"]).get(b"x-request-id", b"").decode("latin-1")
        token = request_id.set(given if GIVEN_ID.fullmatch(given) else secrets.token_hex(8))
        started, status = time.perf_counter(), None

        async def send_with_id(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                message["headers"] = [*message.get("headers", []), (b"x-request-id", request_id.get().encode())]
            await send(message)

        try:
            await self.app(scope, receive, send_with_id)
        except Exception:
            log.exception("crashed answering %s %s", scope["method"], scope["path"])
            if status is None:  # nothing was sent yet
                await self.crashed()(scope, receive, send_with_id)
        finally:
            fields = {"method": scope["method"], "path": scope["path"], "status": status}
            fields["ms"] = round((time.perf_counter() - started) * 1000, 1)
            requests_log.info("%s %s %s", scope["method"], scope["path"], status, extra={"fields": fields})
            request_id.reset(token)
