"""
Placeholder Pattern
===================

Single definition of the template placeholder syntax used across template
analysis and document filling.

Supported forms: ``{{field}}``, ``{field}``, ``[field]`` and the bare ``[]``
slot. Bare slots carry no name, so they are given a positional identity
(``_empty_1``, ``_empty_2``, ...) in document order.
"""

import itertools
import re
from collections.abc import Iterator

PLACEHOLDER_PATTERN = re.compile(r"\{\{([^}]+)\}\}|\{([^}]+)\}|\[([^\]]*)\]")

EMPTY_PLACEHOLDER_PREFIX = "_empty_"


def new_empty_counter() -> Iterator[int]:
    """Counter for naming bare ``[]`` slots in document order."""
    return itertools.count(1)


def placeholder_name(groups, empty_counter=None) -> str:
    """Resolve a regex match's groups to a placeholder name.

    Returns "" for a bare slot when no counter is supplied, preserving the
    previous behaviour for callers that only handle named placeholders.
    """
    name = (groups[0] or groups[1] or groups[2] or "").strip()
    if name:
        # Word silently inserts non-breaking spaces (U+00A0), and five of the
        # client's templates carry them INSIDE placeholder names — e.g.
        # "[individual\xa0shareholder_1_name]". That is a different string from
        # "individual shareholder_1_name", so any lookup, alias or field_mapping
        # written with an ordinary space misses it and the field silently comes
        # out blank. Fold it to a normal space at the single point every caller
        # goes through, so the rest of the system only ever sees one spelling.
        # ​ (zero-width space) gets the same treatment for the same reason.
        name = name.replace(" ", " ").replace("\u200b", "")
        return name
    if empty_counter is None:
        return ""
    return f"{EMPTY_PLACEHOLDER_PREFIX}{next(empty_counter)}"


def is_empty_placeholder(name: str) -> bool:
    """True when the name was generated for a bare ``[]`` slot."""
    return str(name).startswith(EMPTY_PLACEHOLDER_PREFIX)

# --- Tracked changes -------------------------------------------------------
#
# A placeholder inside an unaccepted Word INSERTION is invisible to python-docx.
#
# `paragraph.runs` and `paragraph.text` return only the runs that are DIRECT
# children of `<w:p>`. Text a reviewer inserted with Track Changes on lives in
# `<w:ins><w:r>…`, one level deeper, so neither sees it — while Word renders it
# perfectly normally.
#
# Measured 2026-08-27 on `Notice of Annual General Meeting to Shareholders.docx`
# as installed (30,807 bytes, hand-edited): the file carries 8 `<w:ins>` and 2
# `<w:del>` blocks, and FOUR placeholders live inside the insertions —
# `[director_name]`, `[shareholder_2_name]`, `[shareholder_3_name]` and a
# `[shareholder…_1_name]` split across two runs. `paragraph.text` returns
# "Name: " for the signature line. The fill therefore never saw them, never
# replaced them, and the finished document went out reading:
#
#     Name: [director_name]
#
# on the signature line of a notice to shareholders. Training missed them for
# the same reason — the trained mapping holds 8 fields where the document has 11.
#
# `<w:del>` is the opposite case and must stay excluded: deleted text is NOT
# rendered by Word, so filling it would put a value into something nobody sees,
# and counting it would ask the user for a field that does not exist.
_DEL_TAGS = ("del", "moveFrom")


def visible_runs(paragraph):
    """Every run Word will RENDER, including tracked insertions.

    Ordered as they appear. Excludes runs inside a tracked deletion.
    """
    try:
        runs = paragraph._p.xpath(".//w:r")
    except Exception:
        return list(getattr(paragraph, "runs", []))

    from docx.text.run import Run

    out = []
    for r in runs:
        node = r.getparent()
        deleted = False
        while node is not None:
            tag = getattr(node, "tag", "")
            if isinstance(tag, str) and tag.rsplit("}", 1)[-1] in _DEL_TAGS:
                deleted = True
                break
            node = node.getparent()
        if not deleted:
            out.append(Run(r, paragraph))
    return out


def paragraph_text(paragraph) -> str:
    """The text Word shows, tracked insertions included."""
    try:
        return "".join(r.text or "" for r in visible_runs(paragraph))
    except Exception:
        return getattr(paragraph, "text", "") or ""

def tracked_changes(document) -> dict:
    """Unaccepted Word revisions in a template, or {} when it is clean.

    A template carrying tracked changes cannot produce a trustworthy document,
    and the failure is invisible from the outside. Measured on the installed
    `Notice of Annual General Meeting to Shareholders.docx`: a reviewer re-typed
    `[director_name]` with Track Changes on and never deleted the original, so
    the paragraph holds the placeholder TWICE —

        <w:r>Name: [director_name]</w:r>
        <w:ins author="CH Legal" date="2025-12-29">[ director_name]</w:ins>

    Word renders both. Fill both and the signature line reads
    "Name: MIN MINMIN MIN"; fill neither and it reads "Name: [director_name]".
    There is no reading of that file that produces a correct document, so the
    right answer is not a cleverer fill — it is to say so.

    Deliberately NOT auto-accepted: accepting a revision rewrites the firm's
    template and discards a lawyer's pending edit. That is their decision.
    """
    try:
        body = document.element.body
    except Exception:
        return {}
    counts = {}
    for tag in ("ins", "del", "moveFrom", "moveTo"):
        try:
            n = len(body.xpath(f".//w:{tag}"))
        except Exception:
            n = 0
        if n:
            counts[tag] = n
    if not counts:
        return {}
    authors = set()
    try:
        for node in body.xpath(".//w:ins | .//w:del"):
            a = node.get(
                "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}author"
            )
            if a:
                authors.add(a.strip())
    except Exception:
        pass
    return {"revisions": counts, "authors": sorted(authors)}
