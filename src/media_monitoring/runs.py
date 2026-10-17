"""What each run leaves behind: its row in the runs table (see schema.sql). A run writes its row as it starts, adds its
numbers as it goes, and says how it ended. Recording never stops a run: if the database can't take the row (the table
isn't there yet, say), the run says so once and goes on without it.

run.sh starts each round's row itself and gives its ID to the steps it runs (ROUND), whose rows then point to it. A
run gives its own row's ID to the processes it starts (CURRENT), which add their numbers to it (see add)."""

import os

import psycopg
from psycopg.types.json import Jsonb

from media_monitoring import db

ROUND = "RUN_ROUND"  # environment variable: the round a step runs in, from run.sh
CURRENT = "RUN_ID"  # environment variable: the run that started this process
STOPPED = (130, 143)  # exit codes after Ctrl+C or kill (128 + the signal), which stop a run early


class Run:
    """A run's row, used as a context manager: its row is written as it's entered, and as it's left the run ends as
    finished, stopped (Ctrl+C, kill) or failed (an error, or another exit code), unless end() said already"""

    def __init__(self, step, argument=None):
        self.step, self.argument = step, argument
        self.id, self.conn, self.ended = None, None, False

    def __enter__(self):
        try:
            self.conn = psycopg.connect(db.DATABASE_URL, autocommit=True)
            round_id = os.environ.get(ROUND)
            self.id = self.conn.execute(
                "INSERT INTO runs (round_id, step, argument) VALUES (%s, %s, %s) RETURNING id",
                (int(round_id) if round_id else None, self.step, self.argument),
            ).fetchone()[0]
            os.environ[CURRENT] = str(self.id)
        except psycopg.Error as error:
            self.give_up(error)
        return self

    def give_up(self, error):
        """Go on without recording, after saying why once"""
        print(f"(this run isn't recorded: {str(error).strip().splitlines()[0]})")
        if self.conn is not None:
            self.conn.close()
        self.conn = None

    def write(self, query, values):
        if self.conn is None:
            return
        try:
            self.conn.execute(query, values)
        except psycopg.Error as error:
            self.give_up(error)

    def update(self, **numbers):
        """Add numbers to the row, or replace the ones it has under the same names, and say the run is still going"""
        self.write(
            "UPDATE runs SET numbers = numbers || %s, updated_at = now() WHERE id = %s", (Jsonb(numbers), self.id)
        )

    def end(self, outcome, summary=None, **numbers):
        """How the run ended ("finished", "stopped" or "failed"), its last line, and its last numbers"""
        self.write(
            """UPDATE runs SET numbers = numbers || %s, outcome = %s, summary = %s, finished_at = now(),
                   updated_at = now()
               WHERE id = %s""",
            (Jsonb(numbers), outcome, summary, self.id),
        )
        self.ended = True

    def __exit__(self, kind, error, traceback):
        if not self.ended:
            if kind is None:
                self.end("finished")
            elif kind is SystemExit:
                code = error.code
                if code in (0, None):
                    self.end("finished")
                else:
                    self.end("stopped" if code in STOPPED else "failed", None if isinstance(code, int) else str(code))
            elif kind is KeyboardInterrupt:
                self.end("stopped")
            else:
                self.end("failed", f"{kind.__name__}: {error}")
        if self.conn is not None:
            self.conn.close()
        return False  # an error goes on as it would have


def add(**numbers):
    """Add numbers to the row of the run that started this process, if one did (see CURRENT)"""
    current = os.environ.get(CURRENT)
    if not current:
        return
    try:
        with psycopg.connect(db.DATABASE_URL, autocommit=True) as conn:
            conn.execute(
                "UPDATE runs SET numbers = numbers || %s, updated_at = now() WHERE id = %s", (Jsonb(numbers), current)
            )
    except psycopg.Error as error:
        print(f"(these numbers aren't recorded: {str(error).strip().splitlines()[0]})")
