"""
Template coverage — does every template on disk actually have a trained mapping?

Nothing in this product counted templates. Fifteen `.docx` files sit in
`documents/legal/templates/`, and for weeks only TWO of them had a row in the
`templates` table carrying a non-null `field_mapping`. The other thirteen were
present, offered, matched by name, and generated from — while silently falling
back to guessing, because a template with no mapping has nothing to consult.

That is not a visible failure. An untrained template does not error; it fills
the signing director from `directors[0]` instead of offering the choice, and
the document that comes out looks entirely plausible to anyone who does not
already know who was supposed to sign it. Layer 1 tests the blanks of ONE
template against ONE company and passes; the register-wide gap is invisible to
it. This suite exists to make the gap a NUMBER that goes red.

Two sources are compared and neither is trusted alone:

  * the filesystem — `documents/legal/templates/*.docx`, the files the firm
    actually uses;
  * the API — `GET /api/dashboard/templates` (what the DB knows exists) and
    `GET /api/templates/field-mapping/{name}` (what training produced).

A file with no row is an untrained template. A row with an empty mapping is a
training run that reported success and stored nothing.

Run:      python3 tests/tracker_templates.py
Controls: python3 tests/tracker_templates.py --controls
"""

import copy
import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

BASE = os.environ.get("SCOUT_BASE", "http://localhost:8080")
EMAIL = os.environ.get("ADMIN_EMAIL", "admin@legalscout.com")
PASSWORD = os.environ.get("ADMIN_PASSWORD", "")

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE_DIR = ROOT / "documents" / "legal" / "templates"

# The only sources a placeholder may declare. Anything else means the trainer
# invented a category — and `find_replacement` has no branch for it, so the
# placeholder resolves through the smart-default path, which is the guessing
# this whole suite exists to catch.
VALID_SOURCES = {"db", "user_input", "slot"}


def _req(path, method="GET", body=None, token=None):
    url = f"{BASE}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode("utf-8", "replace"), strict=False)


def login():
    if not PASSWORD:
        sys.exit("Set ADMIN_PASSWORD in the environment — this script will not hardcode it.")
    out = _req("/api/auth/login", "POST", {"email": EMAIL, "password": PASSWORD})
    token = out.get("token") or out.get("access_token")
    if not token:
        sys.exit(f"Login failed: {out}")
    return token


# ── the state under test ────────────────────────────────────────────
#
# Everything is fetched ONCE into a plain dict, and every check reads only that
# dict. That is what makes the controls below honest: a mutant perturbs this
# structure in memory and nothing else — no file is written, no request is
# made, the server is never touched. A control that had to sabotage the server
# to fire would be a second product, not a control.


def fetch_state(token):
    disk = sorted(p.name for p in TEMPLATE_DIR.glob("*.docx")) if TEMPLATE_DIR.is_dir() else []

    listing = _req("/api/dashboard/templates", token=token)
    rows = listing.get("templates") or []

    # The dashboard projection does NOT carry field_mapping — it is a display
    # list. Ask the mapping endpoint per template, or this suite would assert
    # against a key that is absent for every row and read as a clean sweep of
    # failures for the wrong reason.
    mappings = {}
    for name in sorted({r.get("name") for r in rows if r.get("name")}):
        quoted = urllib.parse.quote(name, safe="")
        try:
            out = _req(f"/api/templates/field-mapping/{quoted}", token=token)
            mappings[name] = out.get("field_mapping")
        except Exception as e:
            # A fetch failure is not the same as an empty mapping, but for the
            # purpose of "is this template trained" it lands in the same place:
            # nothing usable. Recorded as None and reported by T2.
            mappings[name] = None
            mappings.setdefault("__errors__", {})
            if isinstance(mappings.get("__errors__"), dict):
                mappings["__errors__"][name] = str(e)[:60]

    errors = mappings.pop("__errors__", {})
    return {"disk": disk, "rows": rows, "mappings": mappings, "fetch_errors": errors}


def _row_names(state):
    return {r.get("name") for r in state["rows"] if r.get("name")}


# ── checks ──────────────────────────────────────────────────────────
# Each returns (passed: bool, detail: str).


def t1_every_file_registered(state):
    """A `.docx` on disk with no DB row is an untrained template the agent will
    still happily match by name. The files never register themselves — that
    only happens through the admin upload endpoint — so 'the file is there'
    has never been evidence that the template is known."""
    if not state["disk"]:
        return False, f"no .docx found under {TEMPLATE_DIR}"
    missing = sorted(set(state["disk"]) - _row_names(state))
    detail = f"{len(state['disk']) - len(missing)}/{len(state['disk'])} file(s) registered"
    if missing:
        detail += f" — missing: {missing}"
    return not missing, detail


def t2_every_row_has_a_mapping(state):
    """The defect this suite was written for. `load_field_mapping` returns `{}`
    on a missing row, a null column OR a DB error, so an untrained template is
    indistinguishable from a healthy one at every call site — it just quietly
    has nothing to say about any placeholder."""
    names = sorted(_row_names(state))
    if not names:
        return False, "no template rows returned by /api/dashboard/templates"
    empty = [n for n in names if not state["mappings"].get(n)]
    detail = f"{len(names) - len(empty)}/{len(names)} row(s) carry a mapping"
    if empty:
        detail += f" — untrained: {empty}"
    if state.get("fetch_errors"):
        detail += f"; fetch errors: {state['fetch_errors']}"
    return not empty, detail


def _entries(state):
    """(template, placeholder, entry) for every mapping entry that is a dict."""
    for name, mapping in sorted(state["mappings"].items()):
        if not isinstance(mapping, dict):
            continue
        for ph, entry in sorted(mapping.items()):
            if isinstance(entry, dict):
                yield name, ph, entry


def t3_sources_are_known(state):
    """`source` decides which resolver runs. A value outside the contract does
    not raise anywhere — it simply matches no branch and falls through to the
    smart defaults (today's date, registered office, "they")."""
    bad = [
        f"{name}:{ph}={entry.get('source')!r}"
        for name, ph, entry in _entries(state)
        if entry.get("source") not in VALID_SOURCES
    ]
    total = sum(1 for _ in _entries(state))
    detail = f"{total - len(bad)}/{total} entr(ies) declare a known source"
    if bad:
        detail += f" — offenders: {bad[:8]}" + (" …" if len(bad) > 8 else "")
    return not bad, detail


def t4_slots_carry_a_kind(state):
    """`source: "slot"` means 'ask the user to pick a party'. The `kind` is what
    decides WHICH register the picker offers and which role is recorded against
    the choice — a slot with no kind is the exact shape that put a person
    chosen as the incoming director onto the next document's resignation line."""
    slots = [(n, ph, e) for n, ph, e in _entries(state) if e.get("source") == "slot"]
    bad = []
    for name, ph, entry in slots:
        slot = entry.get("slot")
        kind = slot.get("kind") if isinstance(slot, dict) else None
        if not isinstance(kind, str) or not kind.strip():
            bad.append(f"{name}:{ph} kind={kind!r}")
    detail = f"{len(slots) - len(bad)}/{len(slots)} slot entr(ies) name a kind"
    if bad:
        detail += f" — offenders: {bad[:8]}" + (" …" if len(bad) > 8 else "")
    return not bad, detail


def t5_no_template_declares_zero_placeholders(state):
    """Distinct from T2 on purpose. T2 asks whether a mapping came back at all;
    this asks whether the one that came back says anything. A mapping that
    parsed to `{}` is a training run that completed, wrote a row, reported
    success and stored no placeholders — the only difference from a healthy
    template is a number nobody was printing."""
    names = sorted(_row_names(state))
    zero = [
        n for n in names
        if isinstance(state["mappings"].get(n), dict) and len(state["mappings"][n]) == 0
    ]
    detail = f"{len(names) - len(zero)}/{len(names)} template(s) declare ≥1 placeholder"
    if zero:
        detail += f" — zero placeholders: {zero}"
    return not zero, detail


CHECKS = [
    ("T1", "every .docx on disk has a DB row", t1_every_file_registered),
    ("T2", "every row carries a non-empty field_mapping", t2_every_row_has_a_mapping),
    ("T3", "every source is db / user_input / slot", t3_sources_are_known),
    ("T4", "every slot entry names a non-empty kind", t4_slots_carry_a_kind),
    ("T5", "no template declares zero placeholders", t5_no_template_declares_zero_placeholders),
]


# ── mutants ─────────────────────────────────────────────────────────
#
# Each perturbs a COPY of the fetched state and must move the failure count.
# A check that cannot be made to fail measures nothing, and a green suite made
# of such checks is worse than no suite — it is a claim of coverage. Every
# mutant here reproduces a shape that has actually occurred: a file added
# without an upload, a training run that stored nothing, a trainer inventing a
# source name, a slot written without its kind.


def _first_mapping(state, predicate=lambda m: bool(m)):
    for name in sorted(state["mappings"]):
        if predicate(state["mappings"].get(name)):
            return name
    return None


def m_missing_row(state):
    """What adding a `.docx` to the bind mount does: the file is live, the row
    never appears, and only a count of the two sides can tell."""
    if state["rows"]:
        state["rows"] = state["rows"][1:]
    return state


def m_null_mapping(state):
    name = _first_mapping(state)
    if name:
        state["mappings"][name] = None
    return state


def m_bad_source(state):
    for name, ph, entry in _entries(state):
        entry["source"] = "guess"
        return state
    return state


def m_slot_without_kind(state):
    for name, ph, entry in _entries(state):
        if entry.get("source") == "slot" and isinstance(entry.get("slot"), dict):
            entry["slot"]["kind"] = ""
            return state
    # No slot entry exists to blank. Say so — a control that silently does
    # nothing because its target is absent reads as INERT below, which is the
    # honest verdict: on this data the check is unexercised.
    return state


def m_empty_mapping(state):
    name = _first_mapping(state, lambda m: isinstance(m, dict) and len(m) > 0)
    if name:
        state["mappings"][name] = {}
    return state


MUTANTS = [
    ("missing_row", m_missing_row),
    ("null_mapping", m_null_mapping),
    ("bad_source", m_bad_source),
    ("slot_without_kind", m_slot_without_kind),
    ("empty_mapping", m_empty_mapping),
]


# ── runner ──────────────────────────────────────────────────────────


def run_checks(state, quiet=False):
    rows = []
    for cid, desc, fn in CHECKS:
        try:
            passed, detail = fn(state)
        except Exception as e:
            rows.append((cid, desc, "ERROR", f"{type(e).__name__}: {e}"[:90]))
            continue
        rows.append((cid, desc, "PASS" if passed else "FAIL", detail))

    if not quiet:
        width = max(len(d) for _, d, _ in CHECKS) + 2
        print(f"\n{'ID':<5} {'RESULT':<8} {'CHECK':<{width}} DETAIL")
        print("-" * (20 + width + 60))
        for cid, desc, result, detail in rows:
            print(f"{cid:<5} {result:<8} {desc:<{width}} {detail}")

    failed = sum(1 for _, _, r, _ in rows if r in ("FAIL", "ERROR"))
    passed = sum(1 for _, _, r, _ in rows if r == "PASS")
    return failed, passed


def main():
    token = login()
    state = fetch_state(token)

    print(f"\n{len(state['disk'])} .docx on disk · {len(_row_names(state))} row(s) in the templates table")

    failed, passed = run_checks(state)
    print(f"\nSUMMARY: FAIL={failed} · PASS={passed}")

    if "--controls" in sys.argv:
        print("\n── controls ──────────────────────────────────────────")
        print(f"{'MUTANT':<24}{'BEFORE':>10}{'AFTER':>10}   VERDICT")
        inert = []
        for name, fn in MUTANTS:
            after, _ = run_checks(fn(copy.deepcopy(state)), quiet=True)
            moved = after > failed
            if not moved:
                inert.append(name)
            verdict = "moved" if moved else "INERT — measures nothing"
            print(f"{name:<24}{failed:>10}{after:>10}   {verdict}")
        if inert:
            print(f"\nBROKEN GATE: inert control(s): {', '.join(inert)}")
            print("A check that cannot be made to fail is not a check — fix it "
                  "before trusting the number above.")
        print(f"\nPASS: {len(MUTANTS) - len(inert)}/{len(MUTANTS)} controls moved the number.")

    # Always 0: the runner greps the SUMMARY line, same contract as
    # tracker_layer1.py. An exit code here would make a red suite look like a
    # crashed one.
    return 0


if __name__ == "__main__":
    sys.exit(main())
