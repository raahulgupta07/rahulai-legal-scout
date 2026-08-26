"""
Routine engine — matching, planning and advancing, with no model and no DB.

Everything in this module is a pure function of (routine, state). That is the
whole value of the layer: given a routine definition and the dict of what is
known so far, the next step is COMPUTED, not inferred by a model re-reading its
own transcript. Which means a sequence can be replayed, resumed after a
restart, and tested offline.

THE FLAG
--------
`routines_enabled()` reads LEGAL_SCOUT_ROUTINES from the environment and
defaults to OFF. It is checked at the two boundaries where this layer could
change what the product does — `prompt.apply_routines_block()` and
`select_routine()` — and nowhere else, so a caller cannot accidentally take a
routine path by calling a helper directly.

There are deliberately TWO switches. The env flag says "does this product have
routines at all"; `Routine.enabled` says "is THIS routine ready". Every routine
in the catalogue ships `enabled=False`, so turning the env flag on still
produces no behaviour change until somebody enables a specific routine. A single
switch would have made "try the layer" and "trust this sequence" the same
decision.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Any

from scout.routines.model import (
    DONE_ALWAYS,
    DONE_MANUAL,
    DONE_PRODUCED,
    Routine,
    RoutineStep,
)

FLAG_ENV = "LEGAL_SCOUT_ROUTINES"
_TRUE = frozenset({"1", "true", "yes", "on"})

# Manual-gate completions live under this key inside run state. A reserved key
# rather than a second dict, so a run's whole progress is one JSONB column and a
# resume cannot half-load.
MANUAL_KEY = "__manual_done__"


def routines_enabled() -> bool:
    """True only when LEGAL_SCOUT_ROUTINES is explicitly set to an on value.

    Anything else — unset, empty, "0", "off", a typo — is OFF. A flag that
    turns itself on when misspelled is not a flag.
    """
    return str(os.getenv(FLAG_ENV, "") or "").strip().lower() in _TRUE


# ---------------------------------------------------------------------------
# State helpers
# ---------------------------------------------------------------------------
def is_present(state: dict[str, Any], key: str) -> bool:
    """Whether `key` counts as answered in run state.

    None and a blank/whitespace string are ABSENT. Everything else is present,
    INCLUDING an empty list, a zero and a False.

    That is not fussiness. `get_directors` returning [] is a real answer — this
    company has no directors on file — and treating it as "not asked yet" would
    put the routine into an ask loop that can never be satisfied. The failure
    mode of the opposite choice is worse than the failure mode of this one: a
    step that runs on a genuinely empty list produces a visibly empty document,
    while a step that never runs produces nothing and says nothing.
    """
    if key not in state:
        return False
    value = state[key]
    if value is None:
        return False
    return not (isinstance(value, str) and not value.strip())


def step_is_done(step: RoutineStep, state: dict[str, Any]) -> bool:
    """Whether this step counts as complete, per its own done_when."""
    if step.done_when == DONE_ALWAYS:
        return True
    if step.done_when == DONE_MANUAL:
        done = state.get(MANUAL_KEY) or []
        return step.key in done
    if step.done_when == DONE_PRODUCED:
        # `all([])` is True, which would make a step that produces nothing
        # permanently done without ever running. model.validate() rejects that
        # combination at definition time; this guard is the runtime half, so a
        # routine loaded from DB rows that skipped validation cannot silently
        # skip a step.
        if not step.produces:
            return False
        return all(is_present(state, key) for key in step.produces)
    # An unknown done_when is never satisfied — a routine cannot be quietly
    # completed by a typo in its own definition.
    return False


def missing_requires(step: RoutineStep, state: dict[str, Any]) -> list[str]:
    return [key for key in step.requires if not is_present(state, key)]


# ---------------------------------------------------------------------------
# Plan
# ---------------------------------------------------------------------------
@dataclass
class Plan:
    """What a routine still needs and what it would do next.

    Computed, never stored. Recomputing from (routine, state) is what makes a
    run resumable: nothing about the position is written down except the state
    that produced it, so a stale `current_step` can never disagree with reality.
    """

    routine: str
    done: bool
    next_step: str | None = None
    next_tool: str | None = None
    blocked_on: list[str] = field(default_factory=list)
    missing_inputs: list[str] = field(default_factory=list)
    completed: list[str] = field(default_factory=list)
    remaining: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "routine": self.routine,
            "done": self.done,
            "next_step": self.next_step,
            "next_tool": self.next_tool,
            "blocked_on": list(self.blocked_on),
            "missing_inputs": list(self.missing_inputs),
            "completed": list(self.completed),
            "remaining": list(self.remaining),
        }


def plan(routine: Routine, state: dict[str, Any] | None = None) -> Plan:
    """Compute the next step of `routine` given everything known so far."""
    state = dict(state or {})

    missing_inputs = [key for key in routine.required_input_keys() if not is_present(state, key)]

    completed: list[str] = []
    remaining: list[str] = []
    next_step: RoutineStep | None = None

    for step in routine.ordered_steps():
        if step_is_done(step, state):
            completed.append(step.key)
            continue
        remaining.append(step.key)
        if next_step is None:
            next_step = step

    return Plan(
        routine=routine.name,
        done=next_step is None,
        next_step=next_step.key if next_step else None,
        next_tool=next_step.tool if next_step else None,
        blocked_on=missing_requires(next_step, state) if next_step else [],
        missing_inputs=missing_inputs,
        completed=completed,
        remaining=remaining,
    )


def resolve_args(step: RoutineStep, state: dict[str, Any]) -> dict[str, Any]:
    """Render a step's argument template against run state.

    A string value of the form "$key" is replaced by state["key"]; every other
    value is passed through as a literal. An unresolved "$key" is left as the
    literal "$key" rather than dropped or replaced with None — a call that goes
    out with a visible "$company_name" fails loudly at the tool, whereas a
    silently dropped argument produces a document filled from a default.
    """
    out: dict[str, Any] = {}
    for name, value in (step.args or {}).items():
        if isinstance(value, str) and value.startswith("$"):
            ref = value[1:]
            out[name] = state[ref] if is_present(state, ref) else value
        else:
            out[name] = value
    return out


def advance(
    routine: Routine,
    state: dict[str, Any],
    step_key: str,
    produced: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Return a NEW state with `step_key`'s results recorded.

    Never mutates the state passed in. A caller that holds the pre-step state
    (to retry, to diff, to show what changed) still holds it afterwards, and a
    partially-applied advance cannot leave a shared dict half-written.

    Raises KeyError for a step that is not part of this routine. That is a
    programming error — a caller advancing a step the routine does not contain
    is recording progress against the wrong sequence — and silently ignoring it
    would let a run report completion it never achieved.
    """
    step = routine.step(step_key)
    if step is None:
        raise KeyError(f"routine {routine.name!r} has no step {step_key!r}")

    new_state = dict(state or {})
    if produced:
        new_state.update(produced)

    if step.done_when == DONE_MANUAL:
        done = list(new_state.get(MANUAL_KEY) or [])
        if step_key not in done:
            done.append(step_key)
        new_state[MANUAL_KEY] = done

    return new_state


# ---------------------------------------------------------------------------
# Matching
# ---------------------------------------------------------------------------
_WS = re.compile(r"\s+")


def _normalise(text: str) -> str:
    return _WS.sub(" ", str(text or "").strip().lower())


def match_routine(text: str, routines: list[Routine]) -> Routine | None:
    """Pick the routine whose trigger phrase best matches `text`.

    Pure: no flag check, no DB, no model. Disabled routines are skipped.

    Longest matching trigger wins, and a tie is broken by routine name so the
    result cannot depend on list order. "director resignation and appointment"
    matches both `director-resignation` ("director resignation", 20 chars) and
    `director-appointment` ("director appointment" — not present) — the longest
    literal match is the more specific intent, which is the behaviour the skill
    descriptions already assume.

    This is deliberately dumb. It is a substring match over phrases that come
    from the skill bodies, not a classifier: a wrong routine chosen confidently
    is worse than no routine, and with the flag off nothing calls this at all.
    """
    haystack = _normalise(text)
    if not haystack:
        return None

    best: Routine | None = None
    best_len = 0
    for routine in sorted(routines or [], key=lambda r: r.name):
        if not routine.enabled:
            continue
        for trigger in routine.triggers:
            needle = _normalise(trigger)
            if needle and needle in haystack and len(needle) > best_len:
                best, best_len = routine, len(needle)
    return best


def select_routine(text: str, routines: list[Routine] | None = None) -> Routine | None:
    """Flag-gated entry point. Returns None whenever routines are off.

    This is the ONLY matching function a caller outside this package should
    use. `match_routine` is ungated so it can be tested in both flag states
    without touching the environment.
    """
    if not routines_enabled():
        return None
    if routines is None:
        from scout.routines.catalog import CATALOG

        routines = CATALOG
    return match_routine(text, routines)
