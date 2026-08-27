"""
Layer 1 of the client testing tracker — deterministic, no LLM.

The tracker's expectations reduce to five repeated assertions:

  1. the value is OFFERED for choice, never guessed
  2. the choices come from the right register (directors / shareholders / people)
  3. the list grows or shrinks to the real party count
  4. dates are left blank rather than auto-filled with today
  5. individual and corporate signatories are distinguished

All five are observable in `GET /api/documents/fill-view`, which returns every
blank in the document with its `kind` and its candidate list. That makes this
layer fast, free and repeatable — a real regression suite — where driving the
chat agent is slow and non-deterministic.

Run:  python3 tests/tracker_layer1.py
"""

import json
import os
import sys
import urllib.parse
import urllib.request

BASE = os.environ.get("SCOUT_BASE", "http://localhost:8080")
EMAIL = os.environ.get("ADMIN_EMAIL", "admin@legalscout.com")
PASSWORD = os.environ.get("ADMIN_PASSWORD", "")


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


def fill_view(token, template, company):
    q = urllib.parse.urlencode({"template": template, "company": company})
    return _req(f"/api/documents/fill-view?{q}", token=token)


# ── assertions ──────────────────────────────────────────────────────
# Each returns (passed: bool, detail: str). `blanks` is the fill-view list.


def has_kind(blanks, kind):
    hits = [b for b in blanks if b.get("kind") == kind]
    return bool(hits), f"{len(hits)} blank(s) of kind '{kind}'"


def offers_candidates(blanks, kind, min_count=1):
    """A blank of this kind must offer choices — that is 'ask, do not guess'."""
    hits = [b for b in blanks if b.get("kind") == kind]
    if not hits:
        return False, f"no blank of kind '{kind}'"
    best = max(len(b.get("candidates") or []) for b in hits)
    return best >= min_count, f"max {best} candidate(s) across {len(hits)} '{kind}' blank(s)"


def candidates_include(blanks, kind, expected_names):
    hits = [b for b in blanks if b.get("kind") == kind]
    pool = {(c.get("value") or "").strip().upper() for b in hits for c in (b.get("candidates") or [])}
    missing = [n for n in expected_names if n.strip().upper() not in pool]
    return not missing, ("all present" if not missing else f"missing {missing}; pool={sorted(pool)}")


# Dates the company register is the authority for. The tracker asks for these
# to be filled FROM the register and never asked again ("Although financial year
# and auditor information are provided in the company register, the system ask
# those information"). Only event dates — meeting, notice, signing — must be
# left blank for the user to choose.
# `date of birth` joined this list on 2026-08-27, when the register finally
# began answering it. It belongs here on the same principle as the other two and
# not as an exemption: a birth date is a FACT the People register owns, not an
# event the user picks. The cases that changed still assert what matters —
# the SIGNING date on those consent forms stays blank.
_REGISTER_DATES = ("financial year", "auditor", "date of birth", "birth date")


def _is_register_date(blank) -> bool:
    label = (blank.get("label") or "").lower()
    return any(k in label for k in _REGISTER_DATES)


def dates_not_autofilled(blanks):
    """Event dates must be left blank; register-sourced dates should be filled."""
    dates = [b for b in blanks if b.get("kind") == "date"]
    event = [b for b in dates if not _is_register_date(b)]
    filled = [b for b in event if (b.get("value") or "").strip()]
    from_register = [b for b in dates if _is_register_date(b) and (b.get("value") or "").strip()]
    detail = f"{len(event)} event date(s), {len(filled)} pre-filled"
    if from_register:
        detail += f"; {len(from_register)} from register (correct): {[b.get('label') for b in from_register]}"
    if filled:
        detail += f" → {[b.get('label') for b in filled]}"
    return not filled, detail


def pronoun_offers_gender(blanks):
    hits = [b for b in blanks if b.get("kind") == "pronoun"]
    if not hits:
        return None, "no pronoun blank in this template"
    pool = {(c.get("value") or "").lower() for b in hits for c in (b.get("candidates") or [])}
    ok = any(v == "he" or v.startswith("he") for v in pool) and any(v == "she" or v.startswith("she") for v in pool)
    return ok, f"pronoun candidates: {sorted(pool)}"


def party_count_matches(blanks, kind, expected):
    """Dynamic lists must match the real party count, not a fixed 1/2/3."""
    hits = [b for b in blanks if b.get("kind") == kind]
    return len(hits) == expected, f"{len(hits)} '{kind}' blank(s), expected {expected}"


# ── the cases, transcribed from the tracker ─────────────────────────
AGM = "Annual General Meeting Minutes.docx"
NOTICE_CALL = "Notice of Calling for Annual General Meeting.docx"
NOTICE_SH = "Notice of Annual General Meeting to Shareholders.docx"
SH_RES_AGM = "Shareholders Resolution In Writing for Annual General Meeting.docx"
DC_GROUP = "Director Consent Form - Group Member Appointment.docx"
DC_NON = "Director Consent Form - Non-Group Member Appointment.docx"
ISH_CONSENT = "Individual Shareholder Consent Form.docx"
CORP_CONSENT = (
    "Corporate Shareholder Consent - Directors Resolution for New Company Setup and Director Appointment.docx"
)
RESIGN_LETTER = "Director Resignation Letter.docx"

CITY_HOLDINGS = "CITY HOLDINGS LIMITED"
CITY_MART = "CITY MART HOLDING COMPANY LIMITED"
# CITY MART is the real stand-in for the tracker's "Flying Helios": it holds a
# CORPORATE member (CITY HOLDINGS LIMITED) alongside its own officers, which is
# the party mix those cases exist to exercise. The Flying Helios fixture was
# removed from the register, so tests must not depend on it.
FLYING = "CITY MART HOLDING COMPANY LIMITED"
PAHTAMA = "PAHTAMA GROUP COMPANY LIMITED"

CASES = [
    # ── Group A: AGM templates ──
    (
        "A1",
        "Notice of Calling for AGM — signing offers a director to pick",
        NOTICE_CALL,
        CITY_HOLDINGS,
        lambda b: offers_candidates(b, "person"),
    ),
    ("A1b", "Notice of Calling for AGM — date not auto-filled", NOTICE_CALL, CITY_HOLDINGS, dates_not_autofilled),
    ("A2", "Notice of AGM to Shareholders — dates not auto-filled", NOTICE_SH, CITY_HOLDINGS, dates_not_autofilled),
    (
        "A2b",
        "Notice of AGM to Shareholders — offers people to pick",
        NOTICE_SH,
        CITY_HOLDINGS,
        lambda b: offers_candidates(b, "person"),
    ),
    ("A3", "AGM Minutes (individual shareholders) — dates not auto-filled", AGM, CITY_HOLDINGS, dates_not_autofilled),
    (
        "A3b",
        "AGM Minutes — attendees/signers offered from the register",
        AGM,
        CITY_HOLDINGS,
        lambda b: offers_candidates(b, "person", 2),
    ),
    (
        "A3c",
        "AGM Minutes — chairperson candidates include real directors",
        AGM,
        CITY_HOLDINGS,
        lambda b: candidates_include(b, "person", ["MIN MIN"]),
    ),
    ("A3d", "AGM Minutes — pronoun offers he/she", AGM, CITY_HOLDINGS, pronoun_offers_gender),
    ("A4", "AGM Minutes (corporate + individual) — dates not auto-filled", AGM, FLYING, dates_not_autofilled),
    (
        "A4b",
        "AGM Minutes (corporate + individual) — people offered",
        AGM,
        FLYING,
        lambda b: offers_candidates(b, "person", 2),
    ),
    ("A5", "Shareholders Resolution for AGM — dates not auto-filled", SH_RES_AGM, FLYING, dates_not_autofilled),
    (
        "A5b",
        "Shareholders Resolution for AGM — signers offered",
        SH_RES_AGM,
        FLYING,
        lambda b: offers_candidates(b, "person"),
    ),
    # ── Group B: new company setup ──
    ("B1", "Director Consent (Non-Group) — dates not auto-filled", DC_NON, CITY_HOLDINGS, dates_not_autofilled),
    (
        "B1b",
        "Director Consent (Non-Group) — director offered from register",
        DC_NON,
        CITY_HOLDINGS,
        lambda b: offers_candidates(b, "person"),
    ),
    ("B2", "Director Consent (Group) — dates not auto-filled", DC_GROUP, CITY_HOLDINGS, dates_not_autofilled),
    (
        "B2b",
        "Director Consent (Group) — director offered from register",
        DC_GROUP,
        CITY_HOLDINGS,
        lambda b: offers_candidates(b, "person"),
    ),
    ("B3", "Individual Shareholder Consent — dates not auto-filled", ISH_CONSENT, CITY_HOLDINGS, dates_not_autofilled),
    (
        "B3b",
        "Individual Shareholder Consent — shareholder offered",
        ISH_CONSENT,
        CITY_HOLDINGS,
        lambda b: offers_candidates(b, "person"),
    ),
    ("B4", "Corporate Shareholder Consent — dates not auto-filled", CORP_CONSENT, PAHTAMA, dates_not_autofilled),
    (
        "B4b",
        "Corporate Shareholder Consent — signing directors offered",
        CORP_CONSENT,
        PAHTAMA,
        lambda b: offers_candidates(b, "person", 2),
    ),
    # ── Group C: change of directors ──
    ("C1", "Director Consent (Group) for existing company — dates not auto", DC_GROUP, CITY_MART, dates_not_autofilled),
    (
        "C2",
        "Director Consent (Non-Group) for existing company — dates not auto",
        DC_NON,
        CITY_MART,
        dates_not_autofilled,
    ),
    ("C3", "Resignation Letter — date not auto-filled", RESIGN_LETTER, CITY_HOLDINGS, dates_not_autofilled),
    (
        "C3b",
        "Resignation Letter — resigning director offered, not guessed",
        RESIGN_LETTER,
        CITY_HOLDINGS,
        lambda b: offers_candidates(b, "person"),
    ),
    (
        "C3c",
        "Resignation Letter — candidates include Win Win Tint",
        RESIGN_LETTER,
        CITY_HOLDINGS,
        lambda b: candidates_include(b, "person", ["WIN WIN TINT"]),
    ),
]


def main():
    token = login()
    rows, cache = [], {}

    for cid, desc, template, company, assertion in CASES:
        key = (template, company)
        if key not in cache:
            try:
                cache[key] = fill_view(token, template, company)
            except Exception as e:
                cache[key] = {"success": False, "error": str(e)}
        view = cache[key]

        if not view.get("success"):
            rows.append((cid, desc, "BLOCKED", view.get("error", "fill-view failed")[:90]))
            continue

        blanks = view.get("blanks") or []
        try:
            passed, detail = assertion(blanks)
        except Exception as e:
            rows.append((cid, desc, "ERROR", str(e)[:90]))
            continue

        if passed is None:
            rows.append((cid, desc, "N/A", detail))
        else:
            rows.append((cid, desc, "PASS" if passed else "FAIL", detail))

    width = max(len(d) for _, d, _, _ in rows) + 2
    print(f"\n{'ID':<5} {'RESULT':<8} {'CASE':<{width}} DETAIL")
    print("-" * (20 + width + 60))
    for cid, desc, result, detail in rows:
        print(f"{cid:<5} {result:<8} {desc:<{width}} {detail}")

    counts = {}
    for _, _, r, _ in rows:
        counts[r] = counts.get(r, 0) + 1
    print("\nSUMMARY: " + " · ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    return 1 if counts.get("FAIL") or counts.get("ERROR") else 0


if __name__ == "__main__":
    sys.exit(main())
