"""
Repeat-region suite — the numbered-placeholder guard, offline.

WHY THIS EXISTS
---------------
`repeat_regions` grows a template's numbered party layout to a company's real
party list. That is right for a block of numbered slots and WRONG for a lone
placeholder, and the two were not being told apart.

`signing_director` gained a company fallback (`_parties_for_family` falls back
to `_board_parties_of(company_name)`, the same relationship `member` has to
`_members_of`). Its party count therefore went from 0 — where the expander was
a silent no-op — to the real board size. Every paragraph the expander had been
skipping for lack of parties started expanding, INCLUDING paragraphs holding a
single, UN-NUMBERED placeholder. Measured on four templates, a one-signature
block became four:

    Signed notice by a Company's director ...
    Sincerely,
    _________________________
    Name: MIN MIN
    Name: PHYOE MIN KYAW
    Name: SOE MOE THU
    Name: WIN WIN TINT
    Position: Director

Four names stacked under ONE signature rule with ONE "Position: Director".
That is a malformed legal instrument, and nobody was ever asked who actually
signs — the names came off the register in whatever order it returned them.
The same defect hit two Director Consent Forms and an Individual Shareholder
Consent Form, which is worse in kind: a consent form is signed by the one
person consenting, so expanding it to the whole board fabricates consent from
people who never gave it.

The rule now, and what this suite pins:

    a paragraph is a repeating region ONLY when its placeholder names an
    explicit position — `director_3_name`, `individual shareholder_2_name`.

`[director_name]` is one party, not a list of unknown length. Implemented as
`repeat_regions._is_numbered(placeholder)` and checked at the TOP of
`repeat_regions._rewrite_paragraph_block`, before any party lookup — so an
un-numbered placeholder must not even ASK who the parties are.

WHAT IS ASSERTED
----------------
The guard, at the guard. Every check runs in-process against the module: no
DB, no HTTP, no model, no container, and no `.docx` on disk. The expansion
arithmetic itself is already pinned by `tracker_fill.py`; this suite is only
about which paragraphs are eligible for it in the first place.

R3/R4 assert the guard by EFFECT rather than by return value.
`_rewrite_paragraph_block` returns None either way, so "it returned" proves
nothing. What separates the two cases is whether `_parties_for_family` is
REACHED — that call is the first thing past the guard, and it is exactly the
call that pulled a board into a consent form. So it is replaced with a
recorder: un-numbered must never reach it, numbered must.

Run:  python3 tests/tracker_regions.py [--controls]
"""

import sys
import types
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# No version floor here, deliberately — same reasoning as `tracker_fill.py`.
# `repeat_regions.py` already carries `from __future__ import annotations`, so
# its PEP 604 unions are strings and 3.9 imports it fine. A hard-coded version
# would be a guess about why an import might fail; the import below is the only
# honest check, and it reports its own reason.


# ── offline harness ─────────────────────────────────────────────────


def _install_stubs():
    """Make `scout.tools.repeat_regions` importable without importing the product.

    `scout/__init__.py` is `from scout.agent import scout`, which constructs the
    whole Agno agent and pulls `mcp`; `scout/tools/__init__.py` imports eight
    tool factories. Registering both names as bare packages with a `__path__`
    lets the submodule resolve while neither `__init__` ever runs.
    """
    sys.path.insert(0, str(REPO))
    for name, rel in (("scout", "scout"), ("scout.tools", "scout/tools")):
        if name in sys.modules:
            continue
        mod = types.ModuleType(name)
        mod.__path__ = [str(REPO / rel)]
        sys.modules[name] = mod


def _import_module():
    """`repeat_regions`, or None with the reason.

    The module imports `docx` at the top, and `_is_numbered` reaches into
    `slot_resolver`, which can pull `psycopg`. On a machine without them the
    honest answer is SKIP: a suite that swallows the ImportError and reports
    green is worse than one that does not run, because the guard it claims to
    protect would then be unguarded and look guarded.
    """
    _install_stubs()
    try:
        import importlib

        return importlib.import_module("scout.tools.repeat_regions"), None
    except Exception as exc:  # noqa: BLE001
        return None, f"{type(exc).__name__}: {exc}"


# ── fixtures — FICTIONAL ONLY ───────────────────────────────────────
# No client name appears in this file. The board in the docstring above is the
# real defect's output and is reproduced only as the bug report it is; nothing
# below is loaded from or compared against a register.

COMPANY = "GOLDEN LOTUS HOLDINGS LIMITED"

# The four spellings that must expand. `individual shareholder_2_name` carries
# the space-separated prefix five real templates use, and `appointed_director_
# 1_nrc` is the non-`_name` tail — a guard keyed on the word "name" would pass
# the first three and silently drop the NRC line.
NUMBERED = [
    "director_1_name",
    "director_3_name",
    "individual shareholder_2_name",
    "appointed_director_1_nrc",
]

# The four that must NOT. `resigning_director_name` and `authorized
# director_name` are the ones that actually broke: both name exactly one person
# by role, and both sit in documents where a second name is a legal defect.
UNNUMBERED = [
    "director_name",
    "shareholder_name",
    "authorized director_name",
    "resigning_director_name",
]


def parties(n):
    """`n` distinct fictional parties, in the shape a picker hands back."""
    return [
        {"name": f"FICTIONAL PARTY {i}", "party_type": "individual", "identifier": f"NRC-{i:03d}"}
        for i in range(1, n + 1)
    ]


class FakeParagraph:
    """The smallest thing `_rewrite_paragraph_block` can start on.

    It reads `block[0].text` to find the placeholder, then `_para_set_text`
    reaches for `.runs`, then the clone step reaches for `._p` — real lxml XML
    this fake cannot supply and should not try to. Stopping there is CORRECT
    for the numbered case: by then the guard has already been passed and
    `_parties_for_family` already called, which is the whole question. Building
    a working docx here would test the expander, which `tracker_fill.py`
    already does against the real templates.
    """

    def __init__(self, text):
        self.text = text
        self.runs = []

    def add_run(self, text):
        self.runs.append(types.SimpleNamespace(text=text))
        self.text = text


class Recorder:
    """Stands in for `_parties_for_family` and counts being reached."""

    def __init__(self, n=4):
        self.calls = []
        self._parties = parties(n)

    def __call__(self, family, tail, data, company_name):
        self.calls.append((family, tail))
        return self._parties


def _reached_parties(rr, placeholder, family):
    """Did `_rewrite_paragraph_block` get past the guard for this placeholder?

    Returns (reached, note). Anything raised AFTER the recorder fired is the
    fake docx API running out, not a guard failure — see `FakeParagraph`.
    """
    original = rr._parties_for_family
    recorder = Recorder()
    rr._parties_for_family = recorder
    raised = ""
    try:
        block = [FakeParagraph(f"[{placeholder}] (Director)")]
        counter = iter(range(1, 100))
        try:
            rr._rewrite_paragraph_block(block, family, {}, COMPANY, {}, counter)
        except Exception as exc:  # noqa: BLE001
            raised = f"{type(exc).__name__} after the guard"
    finally:
        rr._parties_for_family = original
    note = f"calls={len(recorder.calls)}" + (f"; {raised}" if raised else "")
    return bool(recorder.calls), note


# ── checks ──────────────────────────────────────────────────────────
#
# Each returns (id, ok, name, detail).


def check_numbered_true(rr):
    """R1 — an explicit position IS a repeating region."""
    bad = [p for p in NUMBERED if not rr._is_numbered(p)]
    return ("R1", not bad, "_is_numbered True for explicit positions",
            f"not recognised: {bad}" if bad else f"{len(NUMBERED)}/{len(NUMBERED)}")


def check_unnumbered_false(rr):
    """R2 — ★ THE GUARD. A lone role placeholder is one party, not a list."""
    bad = [p for p in UNNUMBERED if rr._is_numbered(p)]
    return ("R2", not bad, "_is_numbered False for un-numbered placeholders",
            f"WOULD EXPAND: {bad}" if bad else f"{len(UNNUMBERED)}/{len(UNNUMBERED)}")


def check_unnumbered_blocks_lookup(rr):
    """R3 — ★ the un-numbered case must not even ASK for the party list.

    Pinned on the call, not on the document. Returning early and returning
    after a harmless lookup are indistinguishable from the outside, and the
    lookup is what dragged a company's board into a consent form.
    """
    reached, note = _reached_parties(rr, "resigning_director_name", "signing_director")
    return ("R3", not reached, "un-numbered placeholder never reaches _parties_for_family",
            note)


def check_numbered_reaches_lookup(rr):
    """R4 — the mirror. The guard must not have closed the door on everybody.

    Without this, `_is_numbered` returning False unconditionally would satisfy
    R2 and R3 and disable expansion entirely — a template declaring seven
    numbered slots would render seven raw placeholders.
    """
    reached, note = _reached_parties(rr, "director_2_name", "signing_director")
    return ("R4", reached, "numbered placeholder does reach _parties_for_family", note)


def check_families(rr):
    """R5 — the guard sits downstream of the classifier; it must still classify.

    `_rewrite_paragraph_block` is only called for a block the family detection
    already claimed. A classifier that stopped recognising `signing_director`
    would make R2 and R3 pass for the emptiest possible reason.
    """
    got = {
        "director_2_name": rr._family("director_2_name"),
        "appointed_director_1_nrc": rr._family("appointed_director_1_nrc"),
        "individual shareholder_2_name": rr._family("individual shareholder_2_name"),
    }
    want = {
        "director_2_name": "signing_director",
        "appointed_director_1_nrc": "appointed_director",
        "individual shareholder_2_name": "member",
    }
    wrong = {k: v for k, v in got.items() if v != want[k]}
    return ("R5", not wrong, "family classifier recognises the three families",
            f"wrong: {wrong}" if wrong else "signing_director / appointed_director / member")


def check_non_party_is_none(rr):
    """R6 — and it must still refuse everything else.

    A classifier that answered a family for any string would hand ordinary
    prose to the expander.
    """
    got = rr._family("not_a_party_field")
    return ("R6", got is None, "_family returns None for a non-party field", f"got={got!r}")


CHECKS = [
    check_numbered_true,
    check_unnumbered_false,
    check_unnumbered_blocks_lookup,
    check_numbered_reaches_lookup,
    check_families,
    check_non_party_is_none,
]


# ── controls ────────────────────────────────────────────────────────
#
# `scout/tools/repeat_regions.py` is not edited by this suite — each control
# monkeypatches a seam at runtime and restores it in a `finally`. What is
# asserted is that the FAILURE COUNT MOVES. A control that leaves the number
# alone means the checks above are not measuring the guard, and it is reported
# as a broken gate rather than passed over: a suite whose controls are inert
# is a suite that will stay green through the next regression.


def control_always_numbered(rr):
    """Every placeholder is treated as a position — the shipped defect exactly.

    This is the state the code was in before the guard: `_rewrite_paragraph_block`
    had no eligibility test, so a lone `[resigning_director_name]` was expanded
    to the full board. R2 and R3 must both go red.
    """
    original = rr._is_numbered
    rr._is_numbered = lambda p: True
    return lambda: setattr(rr, "_is_numbered", original)


def control_never_numbered(rr):
    """Nothing is a position — the over-correction.

    Fixing the defect by disabling expansion would satisfy R2 and R3 while
    breaking every genuinely numbered template. R1 and R4 must go red.
    """
    original = rr._is_numbered
    rr._is_numbered = lambda p: False
    return lambda: setattr(rr, "_is_numbered", original)


def control_family_blind(rr):
    """The classifier stops recognising families.

    Proves R5 is live. It also shows why R5 belongs in this suite: with the
    classifier blind, R2 and R3 still pass — the guard checks would report
    green on a module that can no longer identify a repeating region at all.
    """
    original = rr._family
    rr._family = lambda p: None
    return lambda: setattr(rr, "_family", original)


CONTROLS = [
    # (name, apply, the check ids that MUST go red)
    ("always_numbered", control_always_numbered, ["R2", "R3"]),
    ("never_numbered", control_never_numbered, ["R1", "R4"]),
    ("family_blind", control_family_blind, ["R5"]),
]


# ── runner ──────────────────────────────────────────────────────────


def run_checks(rr):
    return [c(rr) for c in CHECKS]


def main(argv):
    rr, reason = _import_module()
    if rr is None:
        print(f"SKIP: scout.tools.repeat_regions could not be imported — {reason}")
        print("  This suite drives the module in-process; with no module there is "
              "nothing to assert, and reporting a pass here would hide the guard "
              "being gone.")
        print("SUMMARY: 0 checks · 0 failed")
        return 0

    rows = run_checks(rr)
    print(f"{'ID':<4} {'':<4} {'CHECK':<58} DETAIL")
    print("-" * 100)
    for cid, ok, name, detail in rows:
        print(f"{cid:<4} {'PASS' if ok else 'FAIL':<4} {name:<58} {detail}")
    failed = [r for r in rows if not r[1]]

    if "--controls" in argv:
        baseline = len(failed)
        print(f"\ncontrols (fault injected at a seam, restored after) — "
              f"baseline failures: {baseline}")
        moved = 0
        for name, apply, must_redden in CONTROLS:
            restore = apply(rr)
            try:
                mrows = run_checks(rr)
            finally:
                restore()
            mfailed = [r[0] for r in mrows if not r[1]]
            did_move = len(mfailed) != baseline
            expected = [i for i in must_redden if i in mfailed]
            missing = [i for i in must_redden if i not in mfailed]
            ok = did_move and not missing
            moved += 1 if ok else 0
            print(f"  {'OK ' if ok else 'BAD'} {name:<18} failures {baseline} -> "
                  f"{len(mfailed)}  red={mfailed}  expected={must_redden}")
            if not did_move:
                print(f"      <<< BROKEN GATE: '{name}' changed nothing. The checks "
                      f"are not measuring the guard.")
            elif missing:
                print(f"      <<< BROKEN GATE: '{name}' left {missing} green; those "
                      f"checks do not depend on the seam they claim to.")
            rows.append((f"C:{name}", ok, f"control {name} moves the number",
                         f"red={mfailed}"))
        print(f"PASS: {moved}/{len(CONTROLS)} controls moved the number.")

        # The seams really are restored — a control that leaked would make every
        # later run of this file lie in whichever direction it leaked.
        rows.extend([(f"{cid}!", ok, f"{name} (after controls)", detail)
                     for cid, ok, name, detail in run_checks(rr)])
        failed = [r for r in rows if not r[1]]
    else:
        print("\n(controls not run — pass --controls to prove the checks can go red)")

    print(f"\nSUMMARY: {len(rows)} checks · {len(failed)} failed")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
