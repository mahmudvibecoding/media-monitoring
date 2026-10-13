"""The database: where it is, and how the collectors connect to it to save what they collect."""
import os

import psycopg

DATABASE_URL = os.environ.get("DATABASE_URL", "dbname=media_monitoring")
# Saves don't wait for the disk to confirm them: a crash loses at most the last second of saves, which the next run
# fetches again
NO_WAIT = "-c synchronous_commit=off"


async def connect():
    """A connection for saving collected data: use it as "async with await db.connect() as conn"."""
    return await psycopg.AsyncConnection.connect(DATABASE_URL, autocommit=True, options=NO_WAIT)
