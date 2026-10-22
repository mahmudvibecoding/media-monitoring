"""Customers' projects, which admins set up (/api/organizations/{id}/projects, /api/projects/...): what an
organization is monitored for, each a list of keywords, any of which a text is to have, and exclusions, none of which
it may have. A keyword is found at the start of words, whether a text writes it in Latin or Cyrillic, or as whole words
when it's in double quotes (app.sql's matching). Before a project is saved, a preview shows what its keywords find in
the last days' Telegram messages, YouTube videos and comments. Nothing is deleted: a project once added stays,
disabled."""

import asyncio
import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Annotated, Literal

import psycopg
from fastapi import APIRouter, Request
from psycopg.rows import dict_row
from pydantic import BaseModel, Field

from media_monitoring.api.accounts import Admin
from media_monitoring.api.errors import Failure, failures
from media_monitoring.api.organizations import ADMINS_ONLY, Id, clean_name, organization
from media_monitoring.api.telegram import PHOTO, SAVED_PHOTO

NAME_MAX = 200
KEYWORD_MAX = 200  # letters in a keyword
KEYWORDS_MAX = 200  # keywords, and exclusions, in a project
DAYS = 30  # a preview's days: today and the 29 before it
EXAMPLES = 10  # a preview's newest examples of each kind
COUNT_MAX = 1000  # a preview counts its matches up to here, then says "more"
PREVIEW_LIMIT = "15s"  # how long a preview's queries may take, longer than other requests'
EXCERPT = 300  # letters of a long text a preview shows, around its first match
log = logging.getLogger("media_monitoring.api")
router = APIRouter()
Keyword = Annotated[str, Field(max_length=KEYWORD_MAX)]


class Project(BaseModel):
    id: int
    organization_id: int
    name: str
    keywords: list[str]
    exclusions: list[str]
    created_at: datetime
    disabled: bool


class NewProject(BaseModel):
    name: str = Field(max_length=NAME_MAX)
    keywords: list[Keyword] = Field(max_length=KEYWORDS_MAX)
    exclusions: list[Keyword] = Field(default_factory=list, max_length=KEYWORDS_MAX)


class ProjectChange(BaseModel):
    name: str | None = Field(None, max_length=NAME_MAX)
    keywords: list[Keyword] | None = Field(None, max_length=KEYWORDS_MAX)
    exclusions: list[Keyword] | None = Field(None, max_length=KEYWORDS_MAX)
    disabled: bool | None = None


class PreviewRequest(BaseModel):
    keywords: list[Keyword] = Field(max_length=KEYWORDS_MAX)
    exclusions: list[Keyword] = Field(default_factory=list, max_length=KEYWORDS_MAX)


Source = Literal["telegram", "youtube_videos", "youtube_comments"]


class Mention(BaseModel):
    published_at: datetime | None
    text: str  # the text, or for a long one the part around its first match, with … where it's cut
    highlights: list[tuple[int, int]]  # where in text the keywords are: each match's start and end, in UTF-16 units
    title: str | None  # the channel's name; for a comment, its video's title
    author: str | None  # a comment's author
    image: str | None  # the channel's photo; for a video, its cover
    url: str  # where it is: t.me/<username>/<id> for a message, the site's page of a video and its comments


class SourcePreview(BaseModel):
    source: Source
    count: int  # its matches in the preview's days, up to more_than
    more_than: int | None  # set when there are more matches than this, which isn't counted further
    examples: list[Mention]  # the newest, at most 10


class Preview(BaseModel):
    days: int  # today and the days before it, in Tashkent
    sources: list[SourcePreview]  # Telegram's messages, YouTube's videos, YouTube's comments


# The matching form app.sql gives texts (app.matching_form, then app.matching's words), here only to find where a
# preview's examples have their keywords: the same rules, from the same letters file
RULES = Path(__file__).resolve().parents[3] / "deploy" / "uzbek_latin.rules"
LETTERS = {
    parts[0]: parts[1] if len(parts) > 1 else ""
    for parts in (line.split() for line in RULES.read_text(encoding="utf-8").splitlines())
    if parts
}
APOSTROPHES = re.compile("['ʻʼ‘’`´]")
YE = re.compile(r"(?<![^\W_])е|(?<=[аеёиоуэюяўaeiou])е")  # at the start of a word or after a vowel
WORD = re.compile(r"(?:[^\W_]|['ʻʼ‘’`´])+")  # letters and digits, apostrophes within them


def form(word: str) -> str:
    """A word in the matching form"""
    word = YE.sub("ye", APOSTROPHES.sub("", word.lower()))
    return "".join(LETTERS.get(letter, letter) for letter in word)


def phrases(keywords: list[str]) -> list[tuple[list[str], bool]]:
    """Each keyword's words in the matching form, and whether they're whole words (in double quotes)"""
    found = []
    for keyword in keywords:
        words = [form(match.group()) for match in WORD.finditer(keyword)]
        words = [word for word in words if word]
        if words:
            found.append((words, bool(re.fullmatch(r'\s*".*"\s*', keyword))))
    return found


def highlight(text: str, keywords: list[tuple[list[str], bool]]) -> tuple[str, list[tuple[int, int]]]:
    """A text with where its keywords are, cut around the first when it's long. Where is counted in UTF-16 units, as
    the browser counts a text's letters (an emoji is two of them)"""
    words = [(match.start(), match.end(), form(match.group())) for match in WORD.finditer(text)]
    longest_first = sorted(keywords, key=lambda keyword: -len(keyword[0]))
    spans, i = [], 0
    while i < len(words):
        for phrase, whole in longest_first:
            n = len(phrase)
            if i + n <= len(words) and all(
                words[i + j][2] == part if whole else words[i + j][2].startswith(part) for j, part in enumerate(phrase)
            ):
                spans.append((words[i][0], words[i + n - 1][1]))
                i += n  # a match's words aren't the start of another
                break
        else:
            i += 1
    begin, end = 0, len(text)
    if len(text) > EXCERPT:
        first = spans[0][0] if spans else 0
        begin = max(0, first - EXCERPT // 4)
        space = text.find(" ", begin, first)
        if begin and 0 <= space - begin < 20:  # from a word's start, when one is near
            begin = space + 1
        end = min(len(text), begin + EXCERPT)
    prefix, suffix = ("…" if begin else ""), ("…" if end < len(text) else "")
    excerpt = prefix + text[begin:end] + suffix

    def utf16(position: int) -> int:
        return len(excerpt[: position - begin + len(prefix)].encode("utf-16-le")) // 2

    return excerpt, [(utf16(start), utf16(stop)) for start, stop in spans if begin <= start and stop <= end]


def clean_keywords(keywords: list[str]) -> list[str]:
    """Keywords without spaces around them, empty ones dropped, each once, whatever the case of its letters"""
    seen, kept = set(), []
    for keyword in keywords:
        keyword = " ".join(keyword.split())
        if keyword and keyword.lower() not in seen:
            seen.add(keyword.lower())
            kept.append(keyword)
    return kept


async def check_keywords(conn, keywords: list[str], exclusions: list[str]) -> None:
    """invalid_keyword (422) for a keyword or exclusion with no words to find, like "!!!" """
    cursor = await conn.execute(
        "SELECT k FROM unnest(%s::text[]) AS k WHERE app.keyword_query(k) IS NULL LIMIT 1", [keywords + exclusions]
    )
    if (row := await cursor.fetchone()) is not None:
        raise Failure(422, "invalid_keyword", f"Has no words to find: {row[0]}")


PROJECT = """
    SELECT id, organization_id, name, keywords, exclusions, created_at, disabled_at IS NOT NULL AS disabled
    FROM app.projects {where} ORDER BY lower(name)
"""


async def project(conn, project_id: int) -> Project:
    """One project, or not_found (404)"""
    cursor = conn.cursor(row_factory=dict_row)
    row = await (await cursor.execute(PROJECT.format(where="WHERE id = %s"), [project_id])).fetchone()
    if row is None:
        raise Failure(404, "not_found", "No project has that ID")
    return Project(**row)


def described(more: dict[int, str]) -> dict:
    return failures(ADMINS_ONLY | more)


KEYWORD_FAILURES = "invalid_keyword: a keyword or exclusion has no words to find; no_keywords: there's no keyword"


@router.get(
    "/api/organizations/{organization_id}/projects", responses=described({404: "not_found: no such organization"})
)
async def projects(organization_id: Id, request: Request, _: Admin) -> list[Project]:
    """An organization's projects, by name."""
    async with request.state.pool.connection() as conn:
        await organization(conn, organization_id)
        cursor = conn.cursor(row_factory=dict_row)
        rows = await (
            await cursor.execute(PROJECT.format(where="WHERE organization_id = %s"), [organization_id])
        ).fetchall()
    return [Project(**row) for row in rows]


@router.get("/api/projects/{project_id}", responses=described({404: "not_found: no such project"}))
async def project_details(project_id: Id, request: Request, _: Admin) -> Project:
    """A project, with its keywords and exclusions."""
    async with request.state.pool.connection() as conn:
        return await project(conn, project_id)


@router.post(
    "/api/organizations/{organization_id}/projects",
    status_code=201,
    responses=described(
        {
            404: "not_found: no such organization",
            409: "project_name_taken: the organization has a project with that name",
            422: f"invalid_name: the name is empty; {KEYWORD_FAILURES}",
        }
    ),
)
async def add_project(organization_id: Id, body: NewProject, request: Request, user: Admin) -> Project:
    """Adds a project to an organization, with its keywords and exclusions."""
    name, keywords, exclusions = clean_name(body.name), clean_keywords(body.keywords), clean_keywords(body.exclusions)
    if not keywords:
        raise Failure(422, "no_keywords", "A project needs a keyword")
    async with request.state.pool.connection() as conn:
        await organization(conn, organization_id)
        await check_keywords(conn, keywords, exclusions)
        try:
            added = await conn.execute(
                """INSERT INTO app.projects (organization_id, name, keywords, exclusions)
                   VALUES (%s, %s, %s, %s) RETURNING id""",
                [organization_id, name, keywords, exclusions],
            )
        except psycopg.errors.UniqueViolation:
            raise Failure(409, "project_name_taken", "The organization has a project with that name already") from None
        project_id = (await added.fetchone())[0]
        found = await project(conn, project_id)
    log.info(
        "project added", extra={"fields": {"project": project_id, "organization": organization_id, "user": user.id}}
    )
    return found


@router.patch(
    "/api/projects/{project_id}",
    responses=described(
        {
            404: "not_found: no such project",
            409: "project_name_taken: the organization has another project with that name",
            422: f"invalid_name: the name is empty; {KEYWORD_FAILURES}",
        }
    ),
)
async def change_project(project_id: Id, body: ProjectChange, request: Request, user: Admin) -> Project:
    """Renames a project, changes its keywords or exclusions, or disables or enables it."""
    name = clean_name(body.name) if body.name is not None else None
    keywords = clean_keywords(body.keywords) if body.keywords is not None else None
    exclusions = clean_keywords(body.exclusions) if body.exclusions is not None else None
    if keywords == []:
        raise Failure(422, "no_keywords", "A project needs a keyword")
    async with request.state.pool.connection() as conn, conn.transaction():
        await project(conn, project_id)
        await check_keywords(conn, keywords or [], exclusions or [])
        try:
            await conn.execute(
                """UPDATE app.projects SET name = coalesce(%(name)s::text, name),
                       keywords = coalesce(%(keywords)s::text[], keywords),
                       exclusions = coalesce(%(exclusions)s::text[], exclusions),
                       disabled_at = CASE WHEN %(disabled)s::boolean IS NULL THEN disabled_at
                                          WHEN %(disabled)s::boolean THEN coalesce(disabled_at, now()) END
                   WHERE id = %(id)s""",
                {
                    "name": name,
                    "keywords": keywords,
                    "exclusions": exclusions,
                    "disabled": body.disabled,
                    "id": project_id,
                },
            )
        except psycopg.errors.UniqueViolation:
            raise Failure(409, "project_name_taken", "The organization has another project with that name") from None
        changed = await project(conn, project_id)
    log.info(
        "project changed", extra={"fields": {"project": project_id, "user": user.id, "disabled": changed.disabled}}
    )
    return changed


# A preview's queries, one per kind of text: how many match in its days (counted up to a limit), and the newest
# examples, read a day at a time from today back, so a common word reads only its last day's matches. Each text's day
# and words are in its table's word index (app.sql), which both read for the keywords. The exclusions are checked on
# each text the keywords find instead: the index can't rule texts out, and an exclusion can start words in most texts
# (ob-havo's "ob" starts obuna too: a rare keyword's newest Telegram messages took 2 s with it in the index's search,
# 49 ms with it checked on each). Telegram's index holds only the messages from September 2026 on, and its queries
# say so, for PostgreSQL to read it.
SINCE = "app.day_of(now()) - %(days)s + 1"
TELEGRAM_INDEXED = "published_at >= '2026-09-01 00:00:00+05'"  # the messages Telegram's word index holds (app.sql)


def matching(words: str) -> str:
    """The condition for texts whose words (an expression, as their table's index has it) have a keyword and no
    exclusion; the exclusions' search is NULL when there are none"""
    return f"{words} @@ %(keywords)s::tsquery AND NOT coalesce({words} @@ %(exclusions)s::tsquery, false)"


MESSAGE = matching("to_tsvector('app.matching', app.matching_form(m.text))")
VIDEO = matching(
    "to_tsvector('app.matching', app.matching_form(coalesce(v.title, '') || ' ' || coalesce(v.description, '')))"
)
COMMENT = matching("to_tsvector('app.matching', app.matching_form(c.text))")
COUNTS: dict[Source, str] = {
    "telegram": f"""SELECT count(*) FROM (SELECT FROM telegram_messages m
        WHERE app.day_of(m.published_at) >= {SINCE} AND m.{TELEGRAM_INDEXED} AND {MESSAGE} LIMIT %(limit)s) AS t""",
    "youtube_videos": f"""SELECT count(*) FROM (SELECT FROM youtube_videos v
        WHERE app.day_of(v.published_at) >= {SINCE} AND {VIDEO} LIMIT %(limit)s) AS t""",
    "youtube_comments": f"""SELECT count(*) FROM (SELECT FROM youtube_comments c
        WHERE app.day_of(c.published_at) >= {SINCE} AND {COMMENT} LIMIT %(limit)s) AS t""",
}
NEWEST: dict[Source, str] = {
    "telegram": f"""SELECT m.* FROM generate_series(0, %(days)s - 1) AS d(back), LATERAL (
            SELECT m.published_at, m.text, c.title, NULL AS author, {PHOTO} AS image,
                'https://t.me/' || c.username || '/' || m.message_id AS url
            FROM telegram_messages m JOIN telegram_channels c USING (channel_id) {SAVED_PHOTO}
            WHERE app.day_of(m.published_at) = app.day_of(now()) - d.back AND m.{TELEGRAM_INDEXED} AND {MESSAGE}
            ORDER BY m.published_at DESC LIMIT %(examples)s) AS m
        LIMIT %(examples)s""",
    "youtube_videos": f"""SELECT v.* FROM generate_series(0, %(days)s - 1) AS d(back), LATERAL (
            SELECT v.published_at, concat_ws(E'\\n', v.title, v.description) AS text, ch.title, NULL AS author,
                v.thumbnail_url AS image,
                CASE WHEN v.kind = 'short' THEN '/youtube/shorts/' ELSE '/youtube/videos/' END || v.video_id AS url
            FROM youtube_videos v JOIN youtube_channels ch USING (channel_id)
            WHERE app.day_of(v.published_at) = app.day_of(now()) - d.back AND {VIDEO}
            ORDER BY v.published_at DESC LIMIT %(examples)s) AS v
        LIMIT %(examples)s""",
    "youtube_comments": f"""SELECT c.* FROM generate_series(0, %(days)s - 1) AS d(back), LATERAL (
            SELECT c.published_at, c.text, v.title, c.author_name AS author, v.thumbnail_url AS image,
                CASE WHEN v.kind = 'short' THEN '/youtube/shorts/' ELSE '/youtube/videos/' END || c.video_id AS url
            FROM youtube_comments c JOIN youtube_videos v USING (video_id)
            WHERE app.day_of(c.published_at) = app.day_of(now()) - d.back AND {COMMENT}
            ORDER BY c.published_at DESC LIMIT %(examples)s) AS c
        LIMIT %(examples)s""",
}


async def preview_source(
    request: Request, source: Source, search: str, excluded: str | None, keywords
) -> SourcePreview:
    params = {"days": DAYS, "keywords": search, "exclusions": excluded, "limit": COUNT_MAX + 1, "examples": EXAMPLES}
    async with request.state.pool.connection() as conn, conn.transaction():
        await conn.execute(f"SET LOCAL statement_timeout = '{PREVIEW_LIMIT}'")
        # Through the word index only: told a count stops at 1,001, PostgreSQL would read the table from its start
        # instead, working out each text's words as it goes (75 s for a common word in a month of comments, 1.4 s
        # through the index); and with memory enough that its list of matches stays exact, rather than whole pages
        # whose every text is to be checked again
        await conn.execute("SET LOCAL enable_seqscan = off")
        await conn.execute("SET LOCAL work_mem = '64MB'")
        count = (await (await conn.execute(COUNTS[source], params)).fetchone())[0]
        rows = await (await conn.cursor(row_factory=dict_row).execute(NEWEST[source], params)).fetchall()
    examples = []
    for row in rows:
        text, spans = highlight(row.pop("text") or "", keywords)
        examples.append(Mention(text=text, highlights=spans, **row))
    more = count > COUNT_MAX
    return SourcePreview(
        source=source, count=min(count, COUNT_MAX), more_than=COUNT_MAX if more else None, examples=examples
    )


@router.post("/api/projects/preview", responses=described({422: KEYWORD_FAILURES}))
async def preview_project(body: PreviewRequest, request: Request, _: Admin) -> Preview:
    """What keywords and exclusions find in the last 30 days, in Tashkent: Telegram's messages, YouTube's videos and
    their comments, each counted up to 1,000, with the newest 10, where the keywords are marked. Nothing is saved."""
    keywords, exclusions = clean_keywords(body.keywords), clean_keywords(body.exclusions)
    if not keywords:
        raise Failure(422, "no_keywords", "There's no keyword")
    async with request.state.pool.connection() as conn:
        await check_keywords(conn, keywords, exclusions)
        search, excluded = await (
            await conn.execute("SELECT app.any_keyword(%s)::text, app.any_keyword(%s)::text", [keywords, exclusions])
        ).fetchone()
    found = phrases(keywords)
    sources = await asyncio.gather(*(preview_source(request, source, search, excluded, found) for source in COUNTS))
    return Preview(days=DAYS, sources=list(sources))
