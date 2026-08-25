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
import logging
import re
from datetime import date
from typing import Any, Dict, List, Optional, Tuple

from agno.run import RunContext
from agno.tools import tool

from db.connection import get_db_conn


def _session_of(run_context: Any) -> str:
    """The conversation a tool was called in.

    agno injects `run_context` into any tool whose signature declares it and
    strips it from the schema the model sees, so the model can neither read nor
    forge it (agno/tools/function.py: entrypoint_args["run_context"] = ...).

    ### Only safe on tools that do NOT pause

    A `requires_user_input=True` tool must NOT declare `run_context`. agno builds
    that tool's `user_input_schema` from `for name in sig.parameters` with no
    exclusions, so `run_context` lands in the schema; the frontend echoes the
    WHOLE schema back on resume; and the call becomes
    `entrypoint(**entrypoint_args, **self.arguments)` with `run_context` in
    both — TypeError: got multiple values for keyword argument 'run_context'.
    The picker then never executes and no selection is ever recorded.

    So the lookup_* tools (which never pause) read the session here and publish
    it in their payload; the pickers read it back out with
    `_session_from_payload`.
    """
    return str(getattr(run_context, "session_id", "") or "").strip()


def _session_from_payload(candidates_json: Any) -> str:
    """The session id the matching lookup_* tool stamped into its payload.

    The pickers cannot take `run_context` themselves (see above), and the
    candidates payload is already passed through them unchanged, so it is the
    one channel that reaches a paused tool without the model being able to
    invent it — a made-up value would have to match a real session id.

    Empty on any parse failure. That is the safe direction: a selection stored
    with no session simply will not resolve at fill time and the agent asks
    again, rather than a pick leaking into another conversation.
    """
    try:
        payload = (
            json.loads(candidates_json)
            if isinstance(candidates_json, str)
            else (candidates_json or {})
        )
    except (ValueError, TypeError):
        return ""
    if not isinstance(payload, dict):
        return ""
    return str(payload.get("session") or "").strip()

DIRECTOR_ROLES = ("director", "both")
SHAREHOLDER_ROLES = ("individual_shareholder", "both")

# Myanmar courtesy titles. NOT part of a legal name and never stored in the
# register, but people write them constantly — "Daw Win Win Tint" is the normal
# way to refer to the person filed as WIN WIN TINT.
#
# Measured 2026-08-06: the lookup is `full_name ILIKE '%<search>%'`, so
# '%Daw Win Win Tint%' matched ZERO rows while '%Win Win Tint%' matched exactly
# one. The user named the person in their very first message and the agent could
# not find them, so it fell back to a picker listing every director — asking a
# question that had already been answered.
#
# U/Daw are the common adult titles; Ko/Ma/Maung/Mi are younger forms; Saw/Naw
# are Karen, Sai/Nang Shan, Nai Mon; Bo and Thakin are historical/military.
_HONORIFICS = frozenset({
    "u", "daw", "ko", "ma", "maung", "mi", "nai", "saw", "naw", "sai", "nang",
    "dr", "dr.", "bo", "thakin", "mr", "mr.", "mrs", "mrs.", "ms", "ms.", "miss",
})


def strip_honorifics(name: str) -> str:
    """A searchable name: courtesy titles removed, whitespace normalised.

    Only LEADING titles are removed, and never the final word — "Daw Daw" would
    otherwise strip to nothing, and a register really can hold a single-word
    name. Returns the original text when stripping would empty it.
    """
    words = str(name or "").replace("\xa0", " ").split()
    i = 0
    while i < len(words) - 1 and words[i].strip(".,").lower() in _HONORIFICS:
        i += 1
    stripped = " ".join(words[i:]).strip()
    return stripped or str(name or "").strip()

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
          -- A resignation dated in the FUTURE has not happened yet. The old
          -- `resigned_date IS NULL` dropped anyone carrying ANY date, so a
          -- director whose 1 Dec 2026 resignation had already been recorded
          -- vanished from every picker while still lawfully in office today —
          -- and a name that is never shown cannot be chosen, whereas a name
          -- shown in error can simply be declined.
          --
          -- KNOWN LIMIT: this is relative to TODAY, not to the DOCUMENT's date,
          -- so minutes backdated before a resignation still omit that director.
          -- The fix is to pass the document date down and compare against it;
          -- that date does not reach this call today.
          AND (cp.resigned_date IS NULL OR cp.resigned_date > CURRENT_DATE)
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


# How a DICA filing spells "this officer has gone". people_sync.py reads
# `date_of_cessation` first and falls back to `resigned_date` (people_sync.py:163);
# the two lists must stay identical or the register and this fallback would
# disagree about who holds office at the very same company.
_CESSATION_KEYS = ("date_of_cessation", "resigned_date")

# people_sync only trusts an unambiguous ISO date (its `_DATE_RE`): "01/12/2024"
# is day-first in one filing and month-first in the next, and a half-parsed date
# is worse than none.
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# What a DICA filing writes when it means "blank" (people_sync `_EMPTY_MARKERS`).
# Without these a literal "-" in the cessation column reads as a resignation and
# silently removes a sitting director from every picker.
_EMPTY_DATE_MARKERS = frozenset({"", "-", "--", "n/a", "na", "none", "null", "nil"})


def _cessation_status(entry: Dict[str, Any]) -> Tuple[bool, str]:
    """Whether a legacy officer has already left office, and how that should read.

    `_registered_people` filters cessations in SQL, but this fallback used to read
    only name / position / appointed_date / shares — it never looked at cessation
    at all. A company that was never synced into the People register therefore
    offered its RESIGNED directors as if they were current, which is how a person
    with no authority reaches a signature block.

    Returns `(drop_this_person, subtitle_note)`. Only a cessation dated on or
    before today drops anyone; everything else is offered WITH a note, because the
    user can decline a name they can see and can do nothing about one they cannot:

    * a future date is a resignation that has not taken effect — that person is
      still lawfully in office today (same rule as the SQL filter above);
    * an unreadable or blank date is a data-quality problem, not evidence that
      anybody left.
    """
    unreadable = ""
    for key in _CESSATION_KEYS:
        text = str(entry.get(key) or "").strip()
        if not text or text.lower() in _EMPTY_DATE_MARKERS:
            continue
        # An unreadable value does not end the search: people_sync takes the first
        # PARSEABLE key (`_clean_date(date_of_cessation) or _clean_date(resigned_date)`),
        # so a garbled `date_of_cessation` beside a clean `resigned_date` must
        # resolve the same way here or one list would show a departed director the
        # other had already removed.
        try:
            ceased = date.fromisoformat(text) if _ISO_DATE_RE.match(text) else None
        except ValueError:  # regex matched, so only an impossible day (2026-02-31) lands here
            ceased = None
        if ceased is None:
            logging.getLogger("legalscout").warning(
                f"Unreadable {key} '{text}' on legacy officer "
                f"'{entry.get('name') or entry.get('full_name') or '?'}' — offering them "
                "anyway; check whether they have in fact resigned."
            )
            unreadable = unreadable or f"cessation recorded ({text})"
            continue
        if ceased <= date.today():
            return True, ""
        return False, f"resigns {text}"
    return False, unreadable


def _legacy_people(entries: List[Dict], role_label: str) -> List[Dict]:
    """Fallback candidates from the legacy companies.directors / members JSONB."""
    candidates = []
    for entry in entries:
        name = entry.get("name") or entry.get("full_name") or ""
        if not name:
            continue
        ceased, cessation_note = _cessation_status(entry)
        if ceased:
            continue
        bits = [entry.get("position") or role_label]
        if entry.get("appointed_date"):
            bits.append(f"appointed {entry['appointed_date']}")
        if entry.get("shares") or entry.get("number_of_shares"):
            bits.append(f"{entry.get('shares') or entry.get('number_of_shares')} shares")
        if entry.get("percentage"):
            bits.append(f"{entry['percentage']}%")
        # Shown, not hidden — but the user must be able to SEE that a departure is
        # on file before they put this person's name on a signature block.
        if cessation_note:
            bits.append(cessation_note)
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
    session: str = "",
) -> Dict[str, Any]:
    """Wrap candidates in the envelope the chat UI consumes."""
    return {
        "picker": picker,
        "purpose": purpose,
        # Carried so the picker that consumes this payload can record WHICH
        # conversation the choice belongs to. See _session_from_payload.
        "session": session,
        "company": company or {},
        "multi_select": multi_select,
        "candidates": candidates,
        "allow_new": True,
        "new_person_fields": NEW_PERSON_FIELDS,
        "note": note,
    }


# Read by the model, never rendered to the user (same contract as
# smart_doc.py's agent_instruction).
#
# Measured 2026-08-06: after a lookup returned, runs ended having written ZERO
# characters to the user while producing a couple of hundred characters of
# invisible reasoning — the model worked out its next step and then simply
# stopped talking. A rule sitting far away in the system prompt did not hold.
# The tool result is the last thing read before the turn ends, so the
# instruction belongs here. Sent on every call: keep it short.
_LOOKUP_FAILED_INSTRUCTION = (
    "ACT NOW, IN THIS SAME TURN — do not end your turn empty. This lookup failed: "
    "say so briefly, then retry with a corrected name or ask for it with ask_questions."
)


def _lookup_instruction(picker: str, hint: str = "", resolved: Any = None) -> str:
    """What to do the moment this lookup returns — picker, or carry on.

    Branches on the `resolved` block: when exactly one named person matched there
    is nothing to choose between, so opening a picker would re-ask an answered
    question. That block carries its own instruction; this one only points at it
    rather than restating (or contradicting) it.
    """
    if resolved:
        return (
            "ACT NOW, IN THIS SAME TURN — do not end your turn empty. One person was "
            f"RESOLVED, so do NOT call {picker}. Follow the `resolved` block: use that "
            "person, continue the task, and name them in your reply."
        )
    return (
        "ACT NOW, IN THIS SAME TURN — do not end your turn empty. Call "
        f"{picker} now, passing this whole payload as candidates_json{hint}. "
        "There is no reason to stop here."
    )


def lookup_director_candidates(
    company_name: str, person_name: str = "", run_context: RunContext = None
) -> str:
    """Fetch the director candidates for a company, as JSON for choose_director.

    Args:
        company_name: Company whose directors should be listed.
        person_name: The person the USER already named, if they named one — e.g.
            "Daw Win Win Tint". Courtesy titles are stripped automatically. When
            exactly one director matches, the result carries a `resolved` block
            and no picker is needed. Pass it whenever the request names someone;
            leave empty to list every director.
    """
    conn = None
    try:
        conn = get_db_conn()
        cur = conn.cursor()
        resolved = _directors_of(cur, company_name)
        cur.close()
        payload = _payload(
            picker="choose_director",
            session=_session_of(run_context),
            candidates=_narrow(resolved["candidates"], person_name),
            company=resolved.get("company"),
        )
        match = _resolution(payload["candidates"], person_name)
        if match:
            payload["resolved"] = match
        payload["agent_instruction"] = _lookup_instruction(
            "choose_director",
            " and purpose set to what this director is being chosen for",
            resolved=match,
        )
        return json.dumps(payload)
    except Exception as e:
        return json.dumps({
            "error": str(e), "candidates": [], "allow_new": True,
            "agent_instruction": _LOOKUP_FAILED_INSTRUCTION,
        })
    finally:
        if conn is not None:
            conn.close()


def lookup_representative_candidates(corporate_shareholder_name: str, run_context: RunContext = None) -> str:
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
        payload = _payload(
            picker="choose_representative_director",
            session=_session_of(run_context),
            candidates=resolved["candidates"],
            company=resolved.get("company"),
            note="Candidates are directors of the corporate shareholder, not of the document company.",
        )
        payload["agent_instruction"] = _lookup_instruction(
            "choose_representative_director",
            " — these are the corporate shareholder's OWN directors, so never "
            "substitute the document company's board",
        )
        return json.dumps(payload)
    except Exception as e:
        return json.dumps({
            "error": str(e), "candidates": [], "allow_new": True,
            "agent_instruction": _LOOKUP_FAILED_INSTRUCTION,
        })
    finally:
        if conn is not None:
            conn.close()


def lookup_attendee_candidates(company_name: str, run_context: RunContext = None) -> str:
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
        payload = _payload(
            picker="choose_attendees",
            session=_session_of(run_context),
            candidates=resolved["candidates"],
            company=resolved.get("company"),
            multi_select=True,
        )
        payload["agent_instruction"] = _lookup_instruction(
            "choose_attendees",
            " — it is multi-select, so let the user pick every attendee and keep their order",
        )
        return json.dumps(payload)
    except Exception as e:
        return json.dumps({
            "error": str(e), "candidates": [], "allow_new": True,
            "agent_instruction": _LOOKUP_FAILED_INSTRUCTION,
        })
    finally:
        if conn is not None:
            conn.close()


def lookup_register_candidates(search: str = "", company_name: str = "", run_context: RunContext = None) -> str:
    """Fetch people from the people register, as JSON for choose_person_from_register.

    Args:
        search: Optional name fragment to filter the register.
        company_name: The company this person is being chosen FOR. Always pass it
            when known — the choice is stored against the company and read back
            at generation time, so omitting it means the picked person never
            reaches the document.
    """
    conn = None
    try:
        conn = get_db_conn()
        cur = conn.cursor()
        term = strip_honorifics(search)
        if term:
            cur.execute(
                """
                SELECT id, full_name, nrc_passport_no, nationality
                FROM people
                WHERE full_name ILIKE %s
                ORDER BY full_name ASC
                LIMIT 100
                """,
                (f"%{term}%",),
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
        payload = _payload(
            picker="choose_person_from_register",
            session=_session_of(run_context),
            candidates=candidates,
            company={"name": company_name.strip()} if company_name.strip() else None,
        )
        resolved = _resolution(candidates, search)
        if resolved:
            payload["resolved"] = resolved
        payload["agent_instruction"] = _lookup_instruction(
            "choose_person_from_register",
            " — the company is already in this payload, leave it there",
            resolved=resolved,
        )
        return json.dumps(payload)
    except Exception as e:
        return json.dumps({
            "error": str(e), "candidates": [], "allow_new": True,
            "agent_instruction": _LOOKUP_FAILED_INSTRUCTION,
        })
    finally:
        if conn is not None:
            conn.close()


def _narrow(candidates: List[Dict], person_name: str) -> List[Dict]:
    """Candidates filtered to a name the user gave, or all of them.

    Falls back to the FULL list whenever the name matches nothing — a typo or an
    unregistered person must still show every option rather than an empty picker
    with no way forward.
    """
    term = strip_honorifics(person_name).lower()
    if not term:
        return candidates
    hits = [c for c in candidates if term in str(c.get("name") or "").lower()]
    return hits or candidates


def _resolution(candidates: List[Dict], search: str) -> Optional[Dict[str, Any]]:
    """The one person the user already named, when there is exactly one.

    Asking "who is resigning?" after the user opened with "resignation letter of
    Daw Win Win Tint" is asking a question they have already answered. When a
    searched name matches a single register entry there is nothing to choose
    between, so the payload says so and the agent proceeds.

    This does NOT weaken the rule that a person is never guessed. It fires only
    when the user typed a name AND exactly one person matches it — resolving
    what someone said is not the same as picking for them. Zero matches, several
    matches, or no name at all all still go to the picker card.

    Nothing is written to party_selections here: this function cannot know which
    ROLE the person is being resolved for, and a selection stored under the wrong
    slot_kind is how a chosen incoming director once ended up on a resignation
    line. The agent carries the name forward in custom_data instead, which the
    slot resolver already reads.
    """
    term = strip_honorifics(search)
    if not term or len(candidates) != 1:
        return None

    only = candidates[0]
    name = str(only.get("name") or "").strip()
    if not name:
        return None

    identifier = str(only.get("identifier") or "").strip()
    return {
        "matched_name": name,
        "identifier": identifier,
        "searched_for": term,
        "instruction": (
            f"The user already named this person, and exactly one register entry matches "
            f"\"{term}\": {name}"
            + (f" (NRC/passport {identifier})" if identifier else "")
            + ". Do NOT open a picker card and do NOT ask who they mean — that question is "
            "already answered. Use this person, pass the name through custom_data when "
            "generating, and say in your reply who you resolved and from where, adding that "
            "they can ask for someone else to change it."
        ),
    }


def _describe(entry: Dict[str, Any]) -> str:
    """"NAME (represented by REP)" — how one chosen party reads in prose."""
    name = str(entry.get("name") or "").strip()
    rep = entry.get("representative")
    rep_name = str(rep.get("name") or "").strip() if isinstance(rep, dict) else ""
    return f"{name} (represented by {rep_name})" if rep_name else name


PICKER_SLOT_KINDS = {
    "choose_director": "signatory",
    "choose_representative_director": "representative",
    "choose_attendees": "attendee",
    "choose_person_from_register": "signatory",
}


def _classify_purpose(purpose: str) -> str:
    """Role this pick is FOR, inferred from the agent's prose purpose.

    Imported lazily: both modules are leaves today, and keeping it lazy means
    neither can constrain the other's import order later.
    """
    try:
        from scout.tools.slot_resolver import classify_kind

        return classify_kind(purpose)
    except Exception:  # noqa: BLE001 — a classification miss must never break a pick
        return ""


def _record_selection(
    picker: str,
    company_name: str,
    chosen: List[Dict],
    purpose: str = "",
    session_id: str = "",
) -> None:
    """Persist a confirmed selection so document generation can find it.

    Choosing the person and filling the template are two separate tool calls, and
    the model cannot be relied on to carry the name between them — it routinely
    calls generate_document with an empty custom_data. Writing the choice down
    makes the fill deterministic. Best-effort: a failure here must never break
    the picker itself.
    """
    if not chosen:
        return
    conn = None
    try:
        conn = get_db_conn()
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO party_selections (company_name, picker, slot_kind, selection, session_id)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (
                (company_name or "").strip(),
                picker,
                # The ROLE this person was chosen for, read out of the purpose
                # the agent supplied ("select the new director to be appointed"
                # → new_director). PICKER_SLOT_KINDS is only a fallback: it maps
                # a whole picker to one kind, so choose_director always claimed
                # "signatory" whether the person was joining or resigning. That
                # made every selection look alike on read-back, and a person
                # picked as the incoming director was reused as the resigning
                # one on the next document.
                _classify_purpose(purpose) or PICKER_SLOT_KINDS.get(picker, ""),
                json.dumps(chosen),
                # The conversation this pick belongs to. Read back only by the
                # same conversation — without it a pick bleeds into somebody
                # else's chat for the same company (see migration 017).
                str(session_id or "").strip(),
            ),
        )
        conn.commit()
        cur.close()
    except Exception as e:  # noqa: BLE001
        import logging

        logging.getLogger("legalscout").warning(f"Could not record {picker} selection: {e}")
    finally:
        if conn is not None:
            conn.close()

    _bind_session_company(session_id, company_name)


def _bind_session_company(session_id: str, company_name: str) -> None:
    """Record which company this conversation is about, once it is settled.

    A picker only ever runs after the company has been established, and both the
    session and the company name are in scope right here — but nothing wrote the
    pairing down, so every later turn re-derived the subject from whatever the
    model happened to say. Measured live: mid-conversation the agent re-asked
    which template and which parent company, both already agreed.

    Binds ONLY on a RESOLVED name. `resolve_company` treats a substring match as
    AMBIGUOUS even when it is the sole hit, so a short form that merely contains
    the query never binds — writing that down would attach the conversation to
    the wrong client, which is far worse than asking again.

    Imported from `scout.memory` explicitly: `scout.effects.turn` exports an
    unrelated `bind_session` taking a single argument, and a bare name here
    would be a coin flip between them.
    """
    key = str(session_id or "").strip()
    name = (company_name or "").strip()
    if not key or not name:
        return
    try:
        from scout.memory import RESOLVED, bind_session, resolve_company

        resolution = resolve_company(name)
        if resolution.status != RESOLVED:
            return
        bind_session(key, resolution.company_id, bound_by="people_picker")
    except Exception as e:  # noqa: BLE001
        import logging

        logging.getLogger("legalscout").warning(f"Could not bind session {key!r} to {name!r}: {e}")


def _selection_result(
    picker: str,
    selected: str,
    company_name: str = "",
    purpose: str = "",
    session_id: str = "",
) -> str:
    """Normalise whatever the UI sent back into a result the agent can use.

    The result carries an explicit `instruction`, not just the raw choice. Without
    it the model reads the JSON echo as "here are some candidates" and re-asks the
    same question as an a)/b)/c) text list — which is the one interaction the
    client rejected. The picker card is the only place a person may be chosen.
    """
    try:
        parsed = json.loads(selected) if isinstance(selected, str) else selected
    except (ValueError, TypeError):
        parsed = selected

    if isinstance(parsed, dict):
        chosen = [parsed]
    elif isinstance(parsed, list):
        chosen = [p if isinstance(p, dict) else {"name": str(p)} for p in parsed]
    elif parsed in (None, ""):
        chosen = []
    else:
        chosen = [{"name": str(parsed)}]

    chosen = [c for c in chosen if str(c.get("name") or "").strip()]
    names = [str(c.get("name")).strip() for c in chosen]

    if not chosen:
        return json.dumps(
            {
                "picker": picker,
                "selected": [],
                "count": 0,
                "status": "no_selection",
                "instruction": (
                    "The user has not chosen anyone yet. ACT NOW, IN THIS SAME TURN — call "
                    "this picker tool again so the choice is made from the in-chat card, and "
                    "do not end your turn empty. NEVER ask for the name as a text question "
                    "and NEVER offer a), b), c) options."
                ),
            }
        )

    _record_selection(picker, company_name, chosen, purpose, session_id=session_id)

    # This return is the exact point where a measured session lost the thread.
    # Session 3be25e3c: the picker confirmed MIN MIN, and the agent's own
    # reasoning read "Now I am trying to determine what the next logical step
    # would be... I'm checking the original context" — then it called
    # list_templates and started over. "If a document was requested" was not
    # enough; it did not know WHICH document. So the goal is now named here,
    # read from the server rather than from the model's memory of the turn.
    try:
        from scout.tools.task_memory import pending_task_instruction

        _pending = pending_task_instruction(session_id)
    except Exception:  # noqa: BLE001 — a picker must never fail for memory
        _pending = ""

    return json.dumps(
        {
            "picker": picker,
            "selected": chosen,
            "count": len(chosen),
            "status": "confirmed",
            "chosen_names": names,
            "instruction": (
                f"The user has ALREADY chosen: {', '.join(_describe(c) for c in chosen)}. "
                "This selection is final and confirmed. Do NOT ask who to use, do NOT list "
                "the candidates again, and do NOT offer a), b), c) options. Use exactly "
                "these names and continue the task NOW, IN THIS SAME TURN — if a document "
                "was requested, generate it immediately, passing these names through "
                "custom_data. Never end your turn empty: always write the user a line "
                "saying who was chosen and what you did next."
                + _pending
            ),
        }
    )


@tool(requires_user_input=True, user_input_fields=["selected"])
def choose_director(
    company_name: str,
    purpose: str,
    candidates_json: str,
    selected: str = "",
) -> str:
    """Ask the user in chat which director of a company should sign, chair or be named.

    Call lookup_director_candidates first and pass its output as candidates_json.

    Args:
        company_name: Company whose director is being chosen.
        purpose: What the director is being chosen for, e.g. "sign the AGM resolution".
        candidates_json: JSON payload from lookup_director_candidates, passed through unchanged.
        selected: Filled in by the user from the chat picker. Never set this yourself.
    """
    return _selection_result(
        "choose_director", selected, company_name, purpose,
        session_id=_session_from_payload(candidates_json),
    )


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
    # This picker only ever answers one role, so its purpose is forced rather
    # than inferred — a prose purpose like "who signs for the shareholder" would
    # otherwise classify as a plain signatory.
    return _selection_result(
        "choose_representative_director", selected, document_company, "representative",
        session_id=_session_from_payload(candidates_json),
    )


@tool(requires_user_input=True, user_input_fields=["selected"])
def choose_attendees(
    company_name: str,
    purpose: str,
    candidates_json: str,
    selected: str = "",
) -> str:
    """Ask the user to multi-select which shareholders attend or are listed, in order.

    Call lookup_attendee_candidates first and pass its output as candidates_json.

    Args:
        company_name: Company whose shareholders are being chosen.
        purpose: What the attendee list is for, e.g. "AGM attendance list".
        candidates_json: JSON payload from lookup_attendee_candidates, passed through unchanged.
        selected: Ordered list filled in by the user from the chat picker. Never set this yourself.
    """
    return _selection_result(
        "choose_attendees", selected, company_name, purpose,
        session_id=_session_from_payload(candidates_json),
    )


@tool(requires_user_input=True, user_input_fields=["selected"])
def choose_person_from_register(
    purpose: str,
    candidates_json: str,
    selected: str = "",
) -> str:
    """Ask the user to pick a person from the people register, for companies with no register entry yet.

    Call lookup_register_candidates first and pass its output as candidates_json.

    Args:
        purpose: What the person is being chosen for.
        candidates_json: JSON payload from lookup_register_candidates, passed through unchanged.
        selected: Filled in by the user from the chat picker. Never set this yourself.
    """
    # The company MUST be recorded with the selection. party_selections is read
    # back via idx_party_selections_lookup on (lower(company_name), picker), so a
    # row stored with an empty company can never be found again — the user picks
    # a person, the pick is logged, and the document still generates without
    # them. lookup_register_candidates already puts the company in the payload;
    # carry it through.
    company_name = ""
    try:
        payload = json.loads(candidates_json) if isinstance(candidates_json, str) else (candidates_json or {})
        if isinstance(payload, dict):
            company = payload.get("company")
            if isinstance(company, dict):
                company_name = str(company.get("name") or company.get("company_name") or "").strip()
            elif isinstance(company, str):
                company_name = company.strip()
    except (ValueError, TypeError) as e:
        logging.getLogger("legalscout").warning(
            f"choose_person_from_register: could not read company from candidates_json: {e}"
        )

    return _selection_result(
        "choose_person_from_register", selected, company_name, purpose,
        session_id=_session_from_payload(candidates_json),
    )


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
