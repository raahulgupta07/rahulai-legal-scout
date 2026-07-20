"""
Interactive Person Pickers
==========================

In-chat human-in-the-loop pickers built on Agno's native pause/resume.

Each picker is a `@tool(requires_user_input=True, user_input_fields=[...])`
function. Agno pauses the
run before executing it and emits a RunPausedEvent carrying the tool's
arguments, so the candidate list travels to the frontend inside
`ToolExecution.tool_args["candidates_json"]`. The frontend renders the choices,
then resumes the SAME run via
`POST /agents/{agent_id}/runs/{run_id}/continue`.

The `lookup_*` helpers are ordinary (non-pausing) tools. The agent calls one
first to fetch the candidate payload, then passes it straight into the matching
picker.
"""

import json
from typing import Any, Dict, List, Optional

from agno.tools import tool

from db.connection import get_db_conn

DIRECTOR_ROLES = ("director", "both")
SHAREHOLDER_ROLES = ("individual_shareholder", "both")

NEW_PERSON_FIELDS = [
    {"name": "full_name", "label": "Full name", "required": True},
    {"name": "nrc_passport_no", "label": "NRC / Passport no.", "required": False},
    {"name": "nationality", "label": "Nationality", "required": False},
    {"name": "residential_address", "label": "Residential address", "required": False},
]


def _company_row(cur, company_name: str) -> Optional[tuple]:
    """Resolve a company by exact then fuzzy name match."""
    cur.execute(
        """
        SELECT id, company_name_english, company_registration_number,
               directors, members, shareholder_links
        FROM companies
        WHERE LOWER(company_name_english) = LOWER(%s)
        LIMIT 1
        """,
        (company_name.strip(),),
    )
    row = cur.fetchone()
    if row:
        return row

    cur.execute(
        """
        SELECT id, company_name_english, company_registration_number,
               directors, members, shareholder_links
        FROM companies
        WHERE company_name_english ILIKE %s
        ORDER BY LENGTH(company_name_english) ASC
        LIMIT 1
        """,
        (f"%{company_name.strip()}%",),
    )
    return cur.fetchone()


def _as_list(value: Any) -> List[Dict]:
    return [v for v in value if isinstance(v, dict)] if isinstance(value, list) else []


def _candidate(
    person_id: Any,
    name: str,
    identifier: str = "",
    subtitle: str = "",
    party_type: str = "individual",
    source: str = "company_people",
    representatives: Optional[List[Dict]] = None,
) -> Dict[str, Any]:
    """Build the stable candidate shape the chat UI renders."""
    return {
        "id": str(person_id) if person_id is not None else f"name:{name}",
        "name": name or "",
        "identifier": identifier or "",
        "subtitle": subtitle or "",
        "party_type": party_type,
        "source": source,
        "representatives": representatives or [],
    }


def _registered_people(cur, company_id: int, roles: tuple) -> List[Dict]:
    """Candidates from the people register for one company and role set."""
    cur.execute(
        """
        SELECT p.id, p.full_name, p.nrc_passport_no, p.nationality,
               cp.role, cp.appointed_date, cp.number_of_shares, cp.share_class
        FROM company_people cp
        JOIN people p ON p.id = cp.person_id
        WHERE cp.company_id = %s
          AND cp.role = ANY(%s)
          AND cp.resigned_date IS NULL
        ORDER BY p.full_name ASC
        """,
        (company_id, list(roles)),
    )

    candidates = []
    for row in cur.fetchall():
        bits = [row[4].replace("_", " ").title() if row[4] else ""]
        if row[5]:
            bits.append(f"appointed {row[5].isoformat()}")
        if row[6]:
            bits.append(f"{row[6]} shares")
        if row[7]:
            bits.append(str(row[7]))
        candidates.append(
            _candidate(
                person_id=row[0],
                name=row[1] or "",
                identifier=row[2] or "",
                subtitle=" · ".join(b for b in bits if b),
                party_type="individual",
                source="company_people",
            )
        )
    return candidates


def _legacy_people(entries: List[Dict], role_label: str) -> List[Dict]:
    """Fallback candidates from the legacy companies.directors / members JSONB."""
    candidates = []
    for entry in entries:
        name = entry.get("name") or entry.get("full_name") or ""
        if not name:
            continue
        bits = [entry.get("position") or role_label]
        if entry.get("appointed_date"):
            bits.append(f"appointed {entry['appointed_date']}")
        if entry.get("shares") or entry.get("number_of_shares"):
            bits.append(f"{entry.get('shares') or entry.get('number_of_shares')} shares")
        if entry.get("percentage"):
            bits.append(f"{entry['percentage']}%")
        candidates.append(
            _candidate(
                person_id=None,
                name=name,
                identifier=entry.get("nrc") or entry.get("nrc_passport_no") or entry.get("passport") or "",
                subtitle=" · ".join(b for b in bits if b),
                party_type="individual",
                source="legacy_jsonb",
            )
        )
    return candidates


def _directors_of(cur, company_name: str) -> Dict[str, Any]:
    """Director candidates for a company, register first then legacy JSONB."""
    row = _company_row(cur, company_name)
    if not row:
        return {"found": False, "company": company_name, "candidates": []}

    company_id, resolved_name, reg_no, directors, _members, _links = row
    candidates = _registered_people(cur, company_id, DIRECTOR_ROLES)
    if not candidates:
        candidates = _legacy_people(_as_list(directors), "Director")

    return {
        "found": True,
        "company": {"id": company_id, "name": resolved_name, "registration_number": reg_no or ""},
        "candidates": candidates,
    }


def _corporate_representatives(cur, corporate_name: str) -> List[Dict]:
    """Directors of a corporate shareholder, used as its representatives."""
    resolved = _directors_of(cur, corporate_name)
    return resolved["candidates"] if resolved.get("found") else []


def _shareholders_of(cur, company_name: str) -> Dict[str, Any]:
    """Individual and corporate shareholder candidates for a company."""
    row = _company_row(cur, company_name)
    if not row:
        return {"found": False, "company": company_name, "candidates": []}

    company_id, resolved_name, reg_no, _directors, members, links = row
    candidates = _registered_people(cur, company_id, SHAREHOLDER_ROLES)
    if not candidates:
        candidates = _legacy_people(_as_list(members), "Shareholder")

    for link in _as_list(links):
        if (link.get("party_type") or link.get("type") or "").lower() != "corporate":
            continue
        corporate_name = link.get("name") or link.get("company_name") or ""
        if not corporate_name:
            continue
        corp_row = _company_row(cur, corporate_name)
        bits = ["Corporate shareholder"]
        if link.get("shares") or link.get("number_of_shares"):
            bits.append(f"{link.get('shares') or link.get('number_of_shares')} shares")
        candidates.append(
            _candidate(
                person_id=corp_row[0] if corp_row else None,
                name=corp_row[1] if corp_row else corporate_name,
                identifier=(corp_row[2] if corp_row else link.get("registration_number")) or "",
                subtitle=" · ".join(bits),
                party_type="corporate",
                source="shareholder_links",
                representatives=_corporate_representatives(cur, corporate_name),
            )
        )

    return {
        "found": True,
        "company": {"id": company_id, "name": resolved_name, "registration_number": reg_no or ""},
        "candidates": candidates,
    }


def _payload(
    picker: str,
    candidates: List[Dict],
    company: Any = None,
    purpose: str = "",
    multi_select: bool = False,
    note: str = "",
) -> Dict[str, Any]:
    """Wrap candidates in the envelope the chat UI consumes."""
    return {
        "picker": picker,
        "purpose": purpose,
        "company": company or {},
        "multi_select": multi_select,
        "candidates": candidates,
        "allow_new": True,
        "new_person_fields": NEW_PERSON_FIELDS,
        "note": note,
    }


def lookup_director_candidates(company_name: str) -> str:
    """Fetch the director candidates for a company, as JSON for choose_director.

    Args:
        company_name: Company whose directors should be listed.
    """
    conn = None
    try:
        conn = get_db_conn()
        cur = conn.cursor()
        resolved = _directors_of(cur, company_name)
        cur.close()
        return json.dumps(
            _payload(
                picker="choose_director",
                candidates=resolved["candidates"],
                company=resolved.get("company"),
            )
        )
    except Exception as e:
        return json.dumps({"error": str(e), "candidates": [], "allow_new": True})
    finally:
        if conn is not None:
            conn.close()


def lookup_representative_candidates(corporate_shareholder_name: str) -> str:
    """Fetch the directors of a corporate shareholder, as JSON for choose_representative_director.

    Args:
        corporate_shareholder_name: The corporate shareholder whose own directors are the candidates.
    """
    conn = None
    try:
        conn = get_db_conn()
        cur = conn.cursor()
        resolved = _directors_of(cur, corporate_shareholder_name)
        cur.close()
        return json.dumps(
            _payload(
                picker="choose_representative_director",
                candidates=resolved["candidates"],
                company=resolved.get("company"),
                note="Candidates are directors of the corporate shareholder, not of the document company.",
            )
        )
    except Exception as e:
        return json.dumps({"error": str(e), "candidates": [], "allow_new": True})
    finally:
        if conn is not None:
            conn.close()


def lookup_attendee_candidates(company_name: str) -> str:
    """Fetch the shareholder candidates for a company, as JSON for choose_attendees.

    Args:
        company_name: Company whose shareholders should be listed.
    """
    conn = None
    try:
        conn = get_db_conn()
        cur = conn.cursor()
        resolved = _shareholders_of(cur, company_name)
        cur.close()
        return json.dumps(
            _payload(
                picker="choose_attendees",
                candidates=resolved["candidates"],
                company=resolved.get("company"),
                multi_select=True,
            )
        )
    except Exception as e:
        return json.dumps({"error": str(e), "candidates": [], "allow_new": True})
    finally:
        if conn is not None:
            conn.close()


def lookup_register_candidates(search: str = "") -> str:
    """Fetch people from the people register, as JSON for choose_person_from_register.

    Args:
        search: Optional name fragment to filter the register.
    """
    conn = None
    try:
        conn = get_db_conn()
        cur = conn.cursor()
        if search.strip():
            cur.execute(
                """
                SELECT id, full_name, nrc_passport_no, nationality
                FROM people
                WHERE full_name ILIKE %s
                ORDER BY full_name ASC
                LIMIT 100
                """,
                (f"%{search.strip()}%",),
            )
        else:
            cur.execute(
                """
                SELECT id, full_name, nrc_passport_no, nationality
                FROM people
                ORDER BY full_name ASC
                LIMIT 100
                """
            )
        candidates = [
            _candidate(
                person_id=row[0],
                name=row[1] or "",
                identifier=row[2] or "",
                subtitle=row[3] or "People register",
                party_type="individual",
                source="people",
            )
            for row in cur.fetchall()
        ]
        cur.close()
        return json.dumps(_payload(picker="choose_person_from_register", candidates=candidates))
    except Exception as e:
        return json.dumps({"error": str(e), "candidates": [], "allow_new": True})
    finally:
        if conn is not None:
            conn.close()


def _selection_result(picker: str, selected: str) -> str:
    """Normalise whatever the UI sent back into a result the agent can use."""
    try:
        parsed = json.loads(selected) if isinstance(selected, str) else selected
    except (ValueError, TypeError):
        parsed = selected

    if isinstance(parsed, dict):
        chosen = [parsed]
    elif isinstance(parsed, list):
        chosen = [p if isinstance(p, dict) else {"name": str(p)} for p in parsed]
    else:
        chosen = [{"name": str(parsed)}]

    return json.dumps({"picker": picker, "selected": chosen, "count": len(chosen)})


@tool(requires_user_input=True, user_input_fields=["selected"])
def choose_director(company_name: str, purpose: str, candidates_json: str, selected: str = "") -> str:
    """Ask the user in chat which director of a company should sign, chair or be named.

    Call lookup_director_candidates first and pass its output as candidates_json.

    Args:
        company_name: Company whose director is being chosen.
        purpose: What the director is being chosen for, e.g. "sign the AGM resolution".
        candidates_json: JSON payload from lookup_director_candidates, passed through unchanged.
        selected: Filled in by the user from the chat picker. Never set this yourself.
    """
    return _selection_result("choose_director", selected)


@tool(requires_user_input=True, user_input_fields=["selected"])
def choose_representative_director(
    document_company: str,
    corporate_shareholder_name: str,
    purpose: str,
    candidates_json: str,
    selected: str = "",
) -> str:
    """Ask which director of a CORPORATE SHAREHOLDER will represent it on another company's document.

    The candidates are the corporate shareholder's own directors, never the document
    company's. Call lookup_representative_candidates(corporate_shareholder_name)
    first and pass its output as candidates_json.

    Args:
        document_company: The company the document is being prepared for.
        corporate_shareholder_name: The corporate shareholder that is signing.
        purpose: What the representative is being chosen for.
        candidates_json: JSON payload from lookup_representative_candidates, passed through unchanged.
        selected: Filled in by the user from the chat picker. Never set this yourself.
    """
    return _selection_result("choose_representative_director", selected)


@tool(requires_user_input=True, user_input_fields=["selected"])
def choose_attendees(company_name: str, purpose: str, candidates_json: str, selected: str = "") -> str:
    """Ask the user to multi-select which shareholders attend or are listed, in order.

    Call lookup_attendee_candidates first and pass its output as candidates_json.

    Args:
        company_name: Company whose shareholders are being chosen.
        purpose: What the attendee list is for, e.g. "AGM attendance list".
        candidates_json: JSON payload from lookup_attendee_candidates, passed through unchanged.
        selected: Ordered list filled in by the user from the chat picker. Never set this yourself.
    """
    return _selection_result("choose_attendees", selected)


@tool(requires_user_input=True, user_input_fields=["selected"])
def choose_person_from_register(purpose: str, candidates_json: str, selected: str = "") -> str:
    """Ask the user to pick a person from the people register, for companies with no register entry yet.

    Call lookup_register_candidates first and pass its output as candidates_json.

    Args:
        purpose: What the person is being chosen for.
        candidates_json: JSON payload from lookup_register_candidates, passed through unchanged.
        selected: Filled in by the user from the chat picker. Never set this yourself.
    """
    return _selection_result("choose_person_from_register", selected)


people_picker = {
    "lookup_director_candidates": lookup_director_candidates,
    "lookup_representative_candidates": lookup_representative_candidates,
    "lookup_attendee_candidates": lookup_attendee_candidates,
    "lookup_register_candidates": lookup_register_candidates,
    "choose_director": choose_director,
    "choose_representative_director": choose_representative_director,
    "choose_attendees": choose_attendees,
    "choose_person_from_register": choose_person_from_register,
}
