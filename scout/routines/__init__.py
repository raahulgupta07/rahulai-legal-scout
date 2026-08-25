"""
Routines — the multi-step document sequences the agent performs, as data.

WHAT THIS IS, IN ONE PARAGRAPH
------------------------------
"Produce a director resignation" is today an emergent behaviour of a model
reading `legal_skills.body`: five numbered lines of markdown naming five tools.
A routine is that same sequence with a spine — named steps, declared inputs, the
tool each step calls, and what counts as done — so it can be enumerated,
checked, resumed and tested without a model.

BUILT ON `legal_skills`, NOT BESIDE IT
--------------------------------------
`legal_skills` already owns the hard half: WHEN a sequence applies (the L1
description injected into the prompt), WHY each step is there (the body), and
whether it is live (`enabled`, toggled from the admin Skills tab). None of that
is rebuilt. `Routine.skill` points at the skill row it formalises and every
routine's first step is `load_skill(name)` — the playbook is still what the
model reads for the reasoning, the wording and the gates. The routine only adds
the order and the inputs.

FLAG
----
Everything is off unless LEGAL_SCOUT_ROUTINES is explicitly set on, AND the
individual routine's `enabled` column is true. Every routine ships disabled.
With the flag off `prompt.apply_routines_block()` returns the prompt it was
given by identity, `engine.select_routine()` returns None, and every function in
`store` returns without opening a connection.

LOCAL IMPORTABILITY
-------------------
No module in this package imports psycopg, agno or mcp at import time, and every
module carries `from __future__ import annotations`. The whole package imports
and its tests run on the 3.9.6 system python with no database and no container.
"""

from __future__ import annotations

from scout.routines.engine import (
    FLAG_ENV,
    MANUAL_KEY,
    Plan,
    advance,
    is_present,
    match_routine,
    missing_requires,
    plan,
    resolve_args,
    routines_enabled,
    select_routine,
    step_is_done,
)
from scout.routines.model import (
    DONE_ALWAYS,
    DONE_MANUAL,
    DONE_PRODUCED,
    Routine,
    RoutineInput,
    RoutineStep,
    validate,
)
from scout.routines.prompt import apply_routines_block, build_routines_block

__all__ = [
    "FLAG_ENV",
    "MANUAL_KEY",
    "DONE_ALWAYS",
    "DONE_MANUAL",
    "DONE_PRODUCED",
    "Plan",
    "Routine",
    "RoutineInput",
    "RoutineStep",
    "advance",
    "apply_routines_block",
    "build_routines_block",
    "is_present",
    "match_routine",
    "missing_requires",
    "plan",
    "resolve_args",
    "routines_enabled",
    "select_routine",
    "step_is_done",
    "validate",
]
