"""The API's settings, from environment variables: API_DATABASE_URL, API_HOST and API_PORT. They're checked when the API
starts, and a wrong one stops it with a message naming it."""

import sys

from pydantic import Field, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

PREFIX = "API_"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix=PREFIX)

    database_url: str = "dbname=media_monitoring"  # the database the collectors fill
    host: str = "127.0.0.1"  # not reachable from outside the server
    port: int = Field(8000, ge=1, le=65535)


def load():
    """The settings, or an exit with a message for each wrong one."""
    try:
        return Settings()
    except ValidationError as error:
        wrong = [
            f"{PREFIX}{'_'.join(map(str, problem['loc'])).upper()}={problem['input']!r}: {problem['msg']}"
            for problem in error.errors()
        ]
        sys.exit("wrong settings:\n  " + "\n  ".join(wrong))
