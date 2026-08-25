"""
The prompt seam — and the proof that with the flag off there is no seam.

`apply_routines_block()` is the ONE function `app/main.py` calls. With
LEGAL_SCOUT_ROUTINES off it returns the string it was handed, unchanged and by
identity, so the system prompt is byte-identical to today's. That is not an
assertion in a comment: `tests/tracker_routines.py` runs the real
`scout/agent.py` INSTRUCTIONS text through it in both flag states and compares
md5 digests.

Marker fences are `## Routines (numbered sequences)` .. "\n▣▣▣", chosen to be
unique and greppable and to collide with neither of the two spans app/main.py
already splices: template knowledge (marker .. "\n═══") and legal skills
(marker .. "\n■■■").
"""

from __future__ import annotations

from typing import List, Optional

from scout.routines.engine import routines_enabled
from scout.routines.model import Routine

START_MARKER = "## Routines (numbered sequences)"
END_MARKER = "\n▣▣▣"


def build_routines_block(routines: Optional[List[Routine]] = None) -> str:
    """Render the L1 routines block: one line per ENABLED routine.

    Deliberately the same shape as `_build_legal_skills_block()` — name plus a
    one-line description — and deliberately NOT the steps. The steps are the
    part that does not need to be in the prompt: a routine's value is that the
    sequence is executed from data rather than recalled from context, so
    spending 40 lines of prompt describing it would reintroduce exactly the
    cost the layer removes.
    """
    if routines is None:
        from scout.routines.catalog import CATALOG

        routines = CATALOG

    live = [r for r in routines or [] if r.enabled]
    lines = [
        START_MARKER,
        "These sequences are defined as data. When one applies, follow its "
        "steps in order — the step list, the inputs it still needs and what "
        "counts as done are computed for you, not remembered.",
    ]
    if live:
        for routine in sorted(live, key=lambda r: r.name):
            desc = " ".join(str(routine.description or "").split())
            if len(desc) > 300:
                desc = desc[:297].rstrip() + "..."
            lines.append(f"- {routine.name}: {desc}")
    else:
        lines.append("- (no routines enabled)")
    return "\n".join(lines) + END_MARKER


def apply_routines_block(
    instructions: str, routines: Optional[List[Routine]] = None
) -> str:
    """Splice the routines block into `instructions`, or return it untouched.

    Flag off  -> returns the SAME object, by identity. No copy, no rebuild, no
                 whitespace difference to argue about.
    Flag on   -> replaces an existing marked span if one is present, otherwise
                 appends the block at the end (which creates the markers, so
                 every subsequent refresh takes the splice path).

    The append-when-absent branch is what keeps the flag-off prompt clean: the
    markers are NOT baked into scout/agent.py's INSTRUCTIONS. If they were, the
    flag-off prompt would carry an empty fence and would no longer be
    byte-identical to today's — which is the one property this whole design was
    asked to preserve.
    """
    if not routines_enabled():
        return instructions

    block = build_routines_block(routines)
    text = instructions or ""

    if START_MARKER in text and END_MARKER in text:
        start = text.index(START_MARKER)
        end = text.index(END_MARKER, start) + len(END_MARKER)
        return text[:start] + block + text[end:]

    joiner = "" if text.endswith("\n") else "\n"
    return text + joiner + "\n" + block + "\n"
