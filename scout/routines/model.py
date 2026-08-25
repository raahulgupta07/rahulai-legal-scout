"""
Routine model — the declarative shape of a document-production sequence.

WHY THIS EXISTS
---------------
"Produce a director resignation" is, today, an emergent behaviour of a model
reading `legal_skills.body` — five numbered lines of markdown naming five tools.
That prose is not readable by anything but the model: its steps cannot be
counted, its tool names cannot be checked against the registry, its required
inputs cannot be collected up front, and "step 3 happened" exists nowhere but in
the conversation transcript.

These dataclasses are that same sequence as data. Nothing here imports the DB,
agno, or a model — a routine can be built, validated and planned in a process
with no infrastructure at all, which is the point: it is the seam that lets a
sequence be replayed, resumed or tested WITHOUT a model.

PYTHON 3.9 COMPATIBILITY
------------------------
`from __future__ import annotations` is load-bearing, not decorative. The system
python3 on the development laptop is 3.9.6 and the container is 3.12.8; without
the future import a PEP 604 annotation like `str | None` is evaluated at class
definition time and raises TypeError on import. `scout/tools/slot_resolver.py`
has exactly that problem and cannot be imported on 3.9 at all.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

# A step is done when every key it `produces` is present in run state.
DONE_PRODUCED = "produced"
# A step is done when a human said so (a review, a signature, an approval).
DONE_MANUAL = "manual"
# A step never blocks — it is a note, a warning, a follow-up reminder.
DONE_ALWAYS = "always"

DONE_KINDS = frozenset({DONE_PRODUCED, DONE_MANUAL, DONE_ALWAYS})

INPUT_KINDS = frozenset({"company", "template", "person", "date", "choice", "text"})
SOURCE_HINTS = frozenset({"register", "company", "user", "derived"})

_KEY_RE = re.compile(r"^[a-z][a-z0-9_]*$")
_NAME_RE = re.compile(r"^[a-z][a-z0-9-]*$")


@dataclass(frozen=True)
class RoutineInput:
    """One value the routine needs before it can finish.

    `required` is about the ROUTINE, not the step: an optional input is one the
    sequence can complete without (an auditor fee on minutes that do not report
    one), not one that some steps happen not to read.
    """

    key: str
    label: str
    kind: str = "text"
    required: bool = True
    source_hint: str = "user"
    notes: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "key": self.key,
            "label": self.label,
            "kind": self.kind,
            "required": self.required,
            "source_hint": self.source_hint,
            "notes": self.notes,
        }


@dataclass(frozen=True)
class RoutineStep:
    """One numbered step: what it calls, what it needs, what counts as done."""

    key: str
    no: float
    title: str
    tool: Optional[str] = None
    args: Dict[str, Any] = field(default_factory=dict)
    requires: List[str] = field(default_factory=list)
    produces: List[str] = field(default_factory=list)
    done_when: str = DONE_PRODUCED
    optional: bool = False
    notes: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "key": self.key,
            "no": self.no,
            "title": self.title,
            "tool": self.tool,
            "args": dict(self.args),
            "requires": list(self.requires),
            "produces": list(self.produces),
            "done_when": {"kind": self.done_when},
            "optional": self.optional,
            "notes": self.notes,
        }


@dataclass(frozen=True)
class Routine:
    """A named, ordered, inspectable sequence.

    `skill` names the `legal_skills` row this formalises. It is a plain string,
    resolved by name and allowed to dangle — see the migration header for why a
    hard foreign key was rejected.
    """

    name: str
    title: str
    description: str = ""
    skill: Optional[str] = None
    version: str = "1.0.0"
    enabled: bool = False
    source: str = "catalog"
    triggers: List[str] = field(default_factory=list)
    inputs: List[RoutineInput] = field(default_factory=list)
    steps: List[RoutineStep] = field(default_factory=list)

    # -- lookups ------------------------------------------------------------
    def step(self, key: str) -> Optional[RoutineStep]:
        for s in self.steps:
            if s.key == key:
                return s
        return None

    def input(self, key: str) -> Optional[RoutineInput]:
        for i in self.inputs:
            if i.key == key:
                return i
        return None

    def ordered_steps(self) -> List[RoutineStep]:
        """Steps in execution order.

        Sorted by `no`, not by list position. The two agree in the catalogue,
        and a routine assembled from DB rows in whatever order the query
        returned them must still plan identically — so the order is taken from
        the data, never from how the rows arrived.
        """
        return sorted(self.steps, key=lambda s: (s.no, s.key))

    def required_input_keys(self) -> List[str]:
        return [i.key for i in self.inputs if i.required]

    def tool_names(self) -> List[str]:
        """Every distinct tool this routine calls, in step order."""
        out: List[str] = []
        for s in self.ordered_steps():
            if s.tool and s.tool not in out:
                out.append(s.tool)
        return out

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "title": self.title,
            "description": self.description,
            "skill": self.skill,
            "version": self.version,
            "enabled": self.enabled,
            "source": self.source,
            "triggers": list(self.triggers),
            "inputs": [i.to_dict() for i in self.inputs],
            "steps": [s.to_dict() for s in self.ordered_steps()],
        }


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------
def validate(routine: Routine, known_tools: Optional[set] = None) -> List[str]:
    """Return a list of defect strings. Empty list means the routine is sound.

    Returns rather than raises. A malformed routine is a data problem, and the
    caller that can do something useful about it — an admin UI, a test summary,
    a startup log line — wants ALL the defects at once, not the first one. A
    raise here would also make one bad row take down catalogue loading for
    every other routine.

    `known_tools` is the live registry's name set (scout.agent:
    _registered_tool_names). It is OPTIONAL and when it is None the tool-name
    checks are SKIPPED rather than passed — this is the difference between "no
    dead tool names" and "nobody looked". A caller that cannot supply the
    registry gets fewer checks, and knows it, because the returned list will
    never contain a tool finding.

    That distinction is the whole reason migration 021 had to exist: six skill
    bodies named `preview_document`, no tool by that name was registered, and
    nothing raised — the model followed the instruction, found no such tool,
    and the review step simply did not happen.
    """
    defects: List[str] = []
    where = f"routine {routine.name!r}"

    if not _NAME_RE.match(routine.name or ""):
        defects.append(f"{where}: name must be kebab-case [a-z][a-z0-9-]*")
    if not (routine.title or "").strip():
        defects.append(f"{where}: title is empty")

    # -- inputs -------------------------------------------------------------
    seen_inputs = set()
    for inp in routine.inputs:
        if not _KEY_RE.match(inp.key or ""):
            defects.append(f"{where}: input key {inp.key!r} must be snake_case")
        if inp.key in seen_inputs:
            defects.append(f"{where}: duplicate input key {inp.key!r}")
        seen_inputs.add(inp.key)
        if inp.kind not in INPUT_KINDS:
            defects.append(f"{where}: input {inp.key!r} has unknown kind {inp.kind!r}")
        if inp.source_hint not in SOURCE_HINTS:
            defects.append(
                f"{where}: input {inp.key!r} has unknown source_hint {inp.source_hint!r}"
            )

    # -- steps --------------------------------------------------------------
    if not routine.steps:
        defects.append(f"{where}: has no steps")

    seen_keys = set()
    seen_nos = set()
    # Every key that could possibly be in state by the time a step runs.
    available = set(seen_inputs)
    for step in routine.ordered_steps():
        sw = f"{where} step {step.key!r}"
        if not _KEY_RE.match(step.key or ""):
            defects.append(f"{sw}: step key must be snake_case")
        if step.key in seen_keys:
            defects.append(f"{where}: duplicate step key {step.key!r}")
        seen_keys.add(step.key)
        if step.no in seen_nos:
            defects.append(f"{where}: duplicate step number {step.no}")
        seen_nos.add(step.no)
        if not (step.title or "").strip():
            defects.append(f"{sw}: title is empty")
        if step.done_when not in DONE_KINDS:
            defects.append(f"{sw}: unknown done_when {step.done_when!r}")
        if step.done_when == DONE_PRODUCED and not step.produces:
            # A `produced` step with nothing to produce is done the instant it
            # is looked at — the "all of []" is vacuously true. That is a step
            # which silently never runs, which is the exact failure mode this
            # whole layer exists to make visible.
            defects.append(
                f"{sw}: done_when='produced' but produces nothing — "
                "it would count as done without ever running"
            )

        for key in step.requires:
            if key not in available:
                defects.append(
                    f"{sw}: requires {key!r}, which is neither a declared input "
                    "nor produced by any earlier step"
                )
        for key in step.produces:
            if not _KEY_RE.match(key or ""):
                defects.append(f"{sw}: produces key {key!r} must be snake_case")

        # An arg spelled "$foo" reads state key foo. Anything else is literal.
        for arg_name, arg_val in (step.args or {}).items():
            if isinstance(arg_val, str) and arg_val.startswith("$"):
                ref = arg_val[1:]
                if ref not in available:
                    defects.append(
                        f"{sw}: arg {arg_name!r} references ${ref}, which is "
                        "neither a declared input nor produced by an earlier step"
                    )

        if known_tools is not None and step.tool and step.tool not in known_tools:
            defects.append(
                f"{sw}: tool {step.tool!r} is not in the live registry — "
                "calling it does nothing and ends the turn with no reply"
            )

        available.update(step.produces)

    return defects
