"""The runs, for admins: every round of run.sh, every "uv run proxies" and every run of a step, as the runs table keeps
them (see runs.py). GET /api/runs gives a page of them, newest first, each round with its steps; GET /api/runs/latest
the newest round and what runs now, for the overview; GET /api/runs/{run_id} one run with all its numbers."""

from datetime import datetime, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Path, Query, Request
from psycopg import sql
from psycopg.rows import class_row
from pydantic import BaseModel

from media_monitoring.api.accounts import Admin
from media_monitoring.api.errors import Failure, failures
from media_monitoring.api.lists import LAST_PAGE

PAGE_SIZE = 20  # rounds or runs to a page: a round comes with its steps
# A run that says it's running but hasn't said anything for this long was killed outright (out of memory, the machine
# going down): steps say how far they are every few seconds, and loading their items takes less than a minute
LOST_AFTER = timedelta(minutes=5)
Step = Literal[
    "round",
    "proxies",
    "youtube channels",
    "youtube videos",
    "youtube details",
    "youtube stats",
    "youtube comments",
    "telegram channels",
    "telegram messages",
]

router = APIRouter()


class Run(BaseModel):
    id: int
    round_id: int | None  # the round it ran in; None for a round, or a step run by hand
    step: str
    argument: str | None  # its command line's argument: "90", "all", ...
    started_at: datetime
    updated_at: datetime  # when it last said anything
    finished_at: datetime | None
    outcome: Literal["running", "finished", "stopped", "failed", "lost"]  # lost: running, but silent for LOST_AFTER
    summary: str | None  # its last line, as it printed it, or why it failed
    numbers: dict[str, Any]  # what it counted (see runs.py); in lists, without each proxy list's own numbers


class RunWithSteps(Run):
    steps: list[Run] = []  # a round's steps, in the order they ran; none for anything else


class Runs(BaseModel):
    runs: list[RunWithSteps]
    total: int  # how many there are, on all the pages
    page_size: int


class LatestRuns(BaseModel):
    round: RunWithSteps | None  # the newest round, with its steps; None before the first
    running: list[Run]  # every step going now, in a round or started by hand, the longest going first


# A round is lost once neither it nor any of its steps has said anything for LOST_AFTER: it says nothing itself
# between its start and its end
COLUMNS = sql.SQL("""
    r.id, r.round_id, r.step, r.argument, r.started_at, r.updated_at, r.finished_at, r.summary,
    CASE WHEN r.outcome = 'running' AND greatest(r.updated_at, (SELECT max(s.updated_at) FROM runs s
                                                               WHERE s.round_id = r.id)) < now() - %(lost_after)s
        THEN 'lost' ELSE r.outcome END AS outcome
""")
WHOLE = sql.SQL("r.numbers")
LISTED = sql.SQL("r.numbers #- '{vpn,per_list}' #- '{plain,per_list}' AS numbers")  # without each list's numbers
PAGE = sql.SQL("""
    SELECT {columns}, {numbers} FROM runs AS r WHERE {where}
    ORDER BY r.started_at DESC, r.id DESC LIMIT %(limit)s OFFSET %(offset)s
""")
COUNT = sql.SQL("SELECT count(*) FROM runs AS r WHERE {where}")
STEPS = sql.SQL(
    "SELECT {columns}, {numbers} FROM runs AS r WHERE r.round_id = ANY(%(rounds)s) ORDER BY r.started_at, r.id"
)
ONE = sql.SQL("SELECT {columns}, {numbers} FROM runs AS r WHERE r.id = %(id)s")
LAST_ROUND = sql.SQL(
    "SELECT {columns}, {numbers} FROM runs AS r WHERE r.step = 'round' ORDER BY r.started_at DESC, r.id DESC LIMIT 1"
)
# The steps whose rows say they're running, but not the lost ones
RUNNING = sql.SQL("""
    SELECT * FROM (SELECT {columns}, {numbers} FROM runs AS r WHERE r.outcome = 'running' AND r.step <> 'round') AS going
    WHERE going.outcome = 'running' ORDER BY going.started_at, going.id
""")
TOP = sql.SQL("r.round_id IS NULL")  # rounds, and the runs started by hand
OF_STEP = sql.SQL("r.step = %(step)s")


async def with_steps(conn, found: list[RunWithSteps]) -> list[RunWithSteps]:
    """The rounds among the runs given, each with its steps"""
    rounds = {run.id: run for run in found if run.step == "round"}
    if rounds:
        cursor = conn.cursor(row_factory=class_row(Run))
        query = STEPS.format(columns=COLUMNS, numbers=LISTED)
        for step in await (await cursor.execute(query, {"rounds": list(rounds), "lost_after": LOST_AFTER})).fetchall():
            rounds[step.round_id].steps.append(step)
    return found


@router.get(
    "/api/runs",
    responses=failures(
        {
            401: "not_signed_in: no session, or it ended",
            403: "forbidden: only admins see this; must_change_password: the temporary password isn't changed yet",
            422: "invalid_request: a parameter is out of its range",
        }
    ),
)
async def runs(
    request: Request,
    _: Admin,
    step: Annotated[Step | None, Query(description="Only this step's runs, in rounds or by hand")] = None,
    page: Annotated[int, Query(ge=1, le=LAST_PAGE, description=f"{PAGE_SIZE} to a page")] = 1,
) -> Runs:
    """The rounds and the runs started by hand, newest first, each round with its steps; or, given a step, its runs
    alone (rounds with their steps)"""
    where = OF_STEP if step else TOP
    values = {"step": step, "lost_after": LOST_AFTER, "limit": PAGE_SIZE, "offset": (page - 1) * PAGE_SIZE}
    async with request.state.pool.connection() as conn:
        cursor = conn.cursor(row_factory=class_row(RunWithSteps))
        found = await (
            await cursor.execute(PAGE.format(columns=COLUMNS, numbers=LISTED, where=where), values)
        ).fetchall()
        found = await with_steps(conn, found)
        (total,) = await (await conn.execute(COUNT.format(where=where), values)).fetchone()
    return Runs(runs=found, total=total, page_size=PAGE_SIZE)


# Before /api/runs/{run_id}, which would take "latest" for a run's ID
@router.get(
    "/api/runs/latest",
    responses=failures(
        {
            401: "not_signed_in: no session, or it ended",
            403: "forbidden: only admins see this; must_change_password: the temporary password isn't changed yet",
        }
    ),
)
async def latest_runs(request: Request, _: Admin) -> LatestRuns:
    """The newest round with its steps, and every step going now, in a round or started by hand"""
    values = {"lost_after": LOST_AFTER}
    async with request.state.pool.connection() as conn:
        cursor = conn.cursor(row_factory=class_row(RunWithSteps))
        last = await (await cursor.execute(LAST_ROUND.format(columns=COLUMNS, numbers=LISTED), values)).fetchone()
        if last is not None:
            (last,) = await with_steps(conn, [last])
        cursor = conn.cursor(row_factory=class_row(Run))
        running = await (await cursor.execute(RUNNING.format(columns=COLUMNS, numbers=LISTED), values)).fetchall()
    return LatestRuns(round=last, running=running)


@router.get(
    "/api/runs/{run_id}",
    responses=failures(
        {
            401: "not_signed_in: no session, or it ended",
            403: "forbidden: only admins see this; must_change_password: the temporary password isn't changed yet",
            404: "not_found: there's no run with that ID",
            422: "invalid_request: that isn't a run's ID",
        }
    ),
)
async def run_details(request: Request, _: Admin, run_id: Annotated[int, Path(ge=1)]) -> RunWithSteps:
    """One run with all its numbers (for "uv run proxies", each list's too); a round with its steps"""
    async with request.state.pool.connection() as conn:
        cursor = conn.cursor(row_factory=class_row(RunWithSteps))
        values = {"id": run_id, "lost_after": LOST_AFTER}
        found = await (await cursor.execute(ONE.format(columns=COLUMNS, numbers=WHOLE), values)).fetchone()
        if found is None:
            raise Failure(404, "not_found", "There's no run with that ID")
        (found,) = await with_steps(conn, [found])
    return found
