"""What the names labelled in Telegram's messages and YouTube's texts share: their kinds, whose names they are, a name
as the site gets it, how another labeller's names compare with the hand's, and the changes admins make: the names they
label by hand, and marking them checked."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from media_monitoring.api.errors import Failure

Kind = Literal["person", "organization", "location", "event"]
# Whose names: labelled by hand (corrected by admins), Claude's as first made, or Gemma 4 26B's
Labeller = Literal["hand", "claude", "gemma"]
NAMES_MAX = 300  # names in a text


class LabelledName(BaseModel):
    name: str  # as written in the text
    kind: Kind
    # Where it is in the text, in UTF-16 units, as a browser counts a string's characters (end not included); None for
    # a model's name not written so in it
    start: int | None
    end: int | None
    # Another labeller's name, as it compares with the names labelled by hand: one of them (right), overlapping one of
    # the same kind, but not the same words (part), overlapping only names of another kind (kind: labelled_as is the
    # hand's), or none (extra); or one of the hand's that no name of the labeller's overlaps (missed). None for the
    # hand's own.
    verdict: Literal["right", "part", "kind", "extra", "missed"] | None = None
    labelled_as: Kind | None = None


class NameSpan(BaseModel):
    kind: Kind
    start: int = Field(ge=0)  # where it is in the text, in UTF-16 units, as the names come
    end: int = Field(ge=1)


class NamesChange(BaseModel):
    names: list[NameSpan] = Field(max_length=NAMES_MAX)


class CheckChange(BaseModel):
    checked: bool


class LabelCheck(BaseModel):
    checked_at: datetime | None  # when it was marked checked; None when it isn't


def compared(names: list[dict], hand: list[dict]) -> list[dict]:
    """A labeller's names, each as it compares with the names labelled by hand (see LabelledName.verdict), by where
    they are, and the hand's that none of its own overlaps, missed, in order"""
    hand = [h for h in hand if h["start"] is not None]

    def overlap(a: dict, b: dict) -> bool:
        return a["start"] < b["end"] and b["start"] < a["end"]

    out = []
    for name in names:
        if name["start"] is None:
            out.append(name)
            continue
        over = [h for h in hand if overlap(h, name)]
        if any((h["start"], h["end"], h["kind"]) == (name["start"], name["end"], name["kind"]) for h in over):
            out.append(name | {"verdict": "right"})
        elif any(h["kind"] == name["kind"] for h in over):
            out.append(name | {"verdict": "part"})
        elif over:
            out.append(name | {"verdict": "kind", "labelled_as": over[0]["kind"]})
        else:
            out.append(name | {"verdict": "extra"})
    placed = [name for name in names if name["start"] is not None]
    out += [h | {"verdict": "missed"} for h in hand if not any(overlap(h, name) for name in placed)]
    return sorted(out, key=lambda name: (name["start"] is None, name["start"] or 0))


def in_utf16(text: str, names: list[dict]) -> list[dict]:
    """Names placed in UTF-16 units, as a browser counts a string's characters, from the characters the labels count
    (an emoji before a name counts twice in the browser)"""
    return [
        name | {edge: len(text[: name[edge]].encode("utf-16-le")) // 2 for edge in ("start", "end")}
        if name["start"] is not None
        else name
        for name in names
    ]


def placed(text: str, spans: list[NameSpan]) -> list[dict]:
    """The names a change gives, as they're saved: each with the words it marks and where they are in characters, in
    order. Fails when one is out of the text, splits a character, has no letters, or overlaps another."""
    # Each character's place in UTF-16 units, and the text's end: where a name may start or end
    index, at = {}, 0
    for i, character in enumerate(text):
        index[at] = i
        at += len(character.encode("utf-16-le")) // 2
    index[at] = len(text)
    names = []
    for span in sorted(spans, key=lambda span: span.start):
        start, end = index.get(span.start), index.get(span.end)
        if start is None or end is None or start >= end or not text[start:end].strip():
            raise Failure(422, "invalid_names", "A name is out of the text, splits a character, or has no letters")
        if names and start < names[-1]["end"]:
            raise Failure(422, "invalid_names", "Two names overlap")
        names.append({"name": text[start:end], "kind": span.kind, "start": start, "end": end})
    return names
