"""
Role Slot Resolver
==================

A field_mapping entry whose ``source`` is ``slot`` names a ROLE, not a row.
``directors[0].name`` froze "whoever the register happened to list first" into
the template at training time; a slot instead says "the director who signs" and
is answered by the user through the pickers in ``scout.tools.people_picker``.

Resolution order for a slot:

1. an explicit selection already captured for the document being generated
   (``document_signatories``),
2. a selection carried in the supplied data under the slot's name, in the shape
   the pickers return,
3. nothing — the caller must ask. A slot never falls back to a positional
   guess.

``slot.of`` decides WHOSE people are candidates. ``corporate_shareholder``
means the corporate shareholder's own directors: an AGM resolution signed by
City Holdings on CMHL's document is signed by a City Holdings director.
"""

import contextlib
import contextvars
import json
import logging
import re
from typing import Any

from scout.tools.field_aliases import normalize_field

# The conversation a fill is being performed for.
#
# A picker answer and the document fill are separate tool calls, so the answer
# is parked in party_selections and read back at fill time. The read-back has to
# know WHICH conversation is asking, or it will happily hand back a person
# chosen in somebody else's chat (see migration 017 for the measured case).
#
# Carried in a ContextVar rather than threaded through find_replacement ->
# fill_template_with_validation -> resolve_slot -> selected_parties, because
# that is six signatures deep and every caller would have to be correct. A
# ContextVar is per-context, not a shared global: concurrent runs cannot see
# each other's value, which is the property the threading would have given us.
_SESSION_SCOPE: contextvars.ContextVar[str] = contextvars.ContextVar(
    "legalscout_session_scope", default=""
)


@contextlib.contextmanager
def session_scope(session_id: str | None):
    """Bind the conversation a fill belongs to, for the duration of the block.

    Set once at the tool entry point, where agno's RunContext is available.
    Everything below reads it. Always resets, so a failed generation cannot
    leak its scope into whatever runs next on this thread.
    """
    token = _SESSION_SCOPE.set(str(session_id or "").strip())
    try:
        yield
    finally:
        _SESSION_SCOPE.reset(token)


def current_session_scope() -> str:
    """The conversation a fill belongs to, or '' when there is none.

    '' means a non-chat caller — the Fill-in view generates straight from values
    the user picked in the UI and must never inherit a chat's selections.
    """
    return _SESSION_SCOPE.get()

SLOT_KINDS = frozenset({
    "signatory", "attendee", "chairperson", "resigning_director",
    "new_director", "representative", "shareholder_list", "auditor",
})

SLOT_OF = frozenset({"document_company", "corporate_shareholder", "people_register"})

MULTI_KINDS = frozenset({"attendee", "shareholder_list"})

_CONTRACT_KINDS = None
_CONTRACT_OF = None
_contract_normalise = None
_contract_validate = None

try:  # app.slot_contract is authored in parallel; stay usable without it
    from app import slot_contract as _slot_contract

    _contract_normalise = getattr(_slot_contract, "normalise_legacy_entry", None)
    _contract_validate = getattr(_slot_contract, "validate_mapping_entry", None)
    for _name in ("ALLOWED_SLOT_KINDS", "SLOT_KINDS", "ALLOWED_KINDS"):
        _value = getattr(_slot_contract, _name, None)
        if _value:
            _CONTRACT_KINDS = frozenset(_value)
            break
    for _name in ("ALLOWED_SLOT_OF", "SLOT_OF", "ALLOWED_OF"):
        _value = getattr(_slot_contract, _name, None)
        if _value:
            _CONTRACT_OF = frozenset(_value)
            break
except Exception:  # noqa: BLE001 - module is optional at runtime
    _slot_contract = None

if _CONTRACT_KINDS:
    SLOT_KINDS = _CONTRACT_KINDS
if _CONTRACT_OF:
    SLOT_OF = _CONTRACT_OF

PICKERS = {
    "representative": ("choose_representative_director", "lookup_representative_candidates"),
    "attendee": ("choose_attendees", "lookup_attendee_candidates"),
    "shareholder_list": ("choose_attendees", "lookup_attendee_candidates"),
}
DEFAULT_PICKER = ("choose_director", "lookup_director_candidates")
REGISTER_PICKER = ("choose_person_from_register", "lookup_register_candidates")

PICKER_KINDS = {
    "choose_director": {"signatory", "chairperson", "resigning_director", "new_director", "auditor"},
    "choose_representative_director": {"representative"},
    "choose_attendees": {"attendee", "shareholder_list"},
    "choose_person_from_register": set(SLOT_KINDS),
}

# Ordered most-specific first: the first match wins, and "signatory" is the
# deliberate catch-all at the end.
#
# Separators are [ _-] rather than literal "_" because these run against TWO
# kinds of text: snake_case placeholder names ("new_director_name") AND the
# prose `purpose` a picker is given ("select the new director to be appointed").
# When they only matched underscores, every prose purpose fell through to the
# catch-all and was recorded as "signatory" — which is how a person chosen as
# the INCOMING director was later reused as the RESIGNING one.
_KIND_PATTERNS = (
    ("resigning_director", r"resign|outgoing|stepping[ _-]?down"),
    ("new_director", r"new[ _-]?director|appointed[ _-]?director|incoming[ _-]?director|appointee|being[ _-]?appointed|to[ _-]?be[ _-]?appointed"),
    ("chairperson", r"chair"),
    ("representative", r"represent|authoris?ed[ _-]?person|authoriz?ed[ _-]?person"),
    ("attendee", r"attend|present[ _-]?member|persons[ _-]?present"),
    ("auditor", r"auditor"),
    ("shareholder_list", r"shareholder|member"),
    ("signatory", r"director|signator|signed[ _-]?by|sign"),
)


def classify_kind(text: str) -> str:
    """Best-effort slot kind for a placeholder name or a picker's prose purpose.

    Shared with people_picker so a selection is RECORDED under the same
    vocabulary it is later looked up by. Returns "" when nothing matches, which
    callers treat as "unknown" rather than guessing.
    """
    probe = (text or "").lower()
    if not probe:
        return ""
    for kind, pattern in _KIND_PATTERNS:
        if re.search(pattern, probe):
            return kind
    return ""

_ARRAY_PATH = re.compile(r"^(\w+)\[(\d+)\](?:\.(\w+))?$")
_INDEX_IN_NAME = re.compile(r"(?:^|[^0-9a-z])(\d+)(?:[^0-9a-z]|$)")

_SELECTION_CONTAINERS = ("slot_selections", "selections", "party_selections", "chosen_parties")

_logger = logging.getLogger("legalscout")


def _norm(value: Any) -> str:
    return normalize_field(value)


def _infer_kind(placeholder: str, db_column: str) -> str:
    haystack = f"{_norm(placeholder)}|{_norm(db_column)}"
    for kind, pattern in _KIND_PATTERNS:
        if re.search(pattern, haystack):
            return kind
    return "signatory"


def _infer_of(placeholder: str, db_column: str, kind: str) -> str:
    haystack = f"{_norm(placeholder)}|{_norm(db_column)}"
    if kind == "representative" or "corporate" in haystack:
        return "corporate_shareholder"
    return "document_company"


def _fallback_normalise(placeholder: str, entry: dict) -> dict:
    """Upgrade an already-trained mapping entry to the slot contract."""
    source = str(entry.get("source") or "").strip().lower()
    db_column = str(entry.get("db_column") or "").strip()
    slot = entry.get("slot")

    if isinstance(slot, dict) and slot.get("kind"):
        kind = _norm(slot.get("kind"))
        of = _norm(slot.get("of")) or "document_company"
        return {
            "source": "slot",
            "db_column": None,
            "slot": {
                "kind": kind if kind in SLOT_KINDS else _infer_kind(placeholder, db_column),
                "of": of if of in SLOT_OF else "document_company",
                "multi": bool(slot.get("multi")),
            },
            "default": entry.get("default") if entry.get("default") != "today" else None,
            "description": entry.get("description", ""),
        }

    if source == "db" and _ARRAY_PATH.match(db_column):
        kind = _infer_kind(placeholder, db_column)
        return {
            "source": "slot",
            "db_column": None,
            "slot": {
                "kind": kind,
                "of": _infer_of(placeholder, db_column, kind),
                "multi": kind in MULTI_KINDS,
            },
            "default": None,
            "description": entry.get("description", ""),
        }

    default = entry.get("default")
    return {
        "source": source if source in ("db", "user_input", "slot") else "user_input",
        "db_column": db_column or None,
        "slot": None,
        "default": None if default == "today" else default,
        "description": entry.get("description", ""),
    }


def normalise_entry(placeholder: str, entry: Any) -> dict:
    """Normalise one field_mapping entry, preferring app.slot_contract."""
    if not isinstance(entry, dict):
        entry = {"source": "user_input", "db_column": None, "default": None, "description": str(entry or "")}

    if _contract_normalise is not None:
        for args in ((entry,), (placeholder, entry), (entry, placeholder)):
            try:
                normalised = _contract_normalise(*args)
            except TypeError:
                continue
            except Exception as e:  # noqa: BLE001
                _logger.warning(f"slot_contract.normalise_legacy_entry failed for '{placeholder}': {e}")
                break
            if isinstance(normalised, dict):
                return normalised

    return _fallback_normalise(placeholder, entry)


def is_valid_entry(entry: dict) -> bool:
    """Validate an entry, preferring app.slot_contract."""
    if _contract_validate is not None:
        try:
            return bool(_contract_validate(entry))
        except Exception as e:  # noqa: BLE001
            _logger.warning(f"slot_contract.validate_mapping_entry failed: {e}")

    if not isinstance(entry, dict):
        return False
    source = entry.get("source")
    if source not in ("db", "user_input", "slot"):
        return False
    if source == "db":
        return bool(entry.get("db_column")) and "[" not in str(entry.get("db_column"))
    if source == "slot":
        slot = entry.get("slot")
        return (
            isinstance(slot, dict)
            and slot.get("kind") in SLOT_KINDS
            and slot.get("of") in SLOT_OF
        )
    return entry.get("default") != "today"


def normalise_mapping(mapping: dict) -> dict:
    """Normalise a whole field_mapping so legacy templates keep working."""
    if not isinstance(mapping, dict):
        return {}
    return {key: normalise_entry(key, value) for key, value in mapping.items()}


def slot_of(entry: dict) -> dict | None:
    """The slot descriptor of an entry, or None when it is not a slot entry."""
    if not isinstance(entry, dict) or entry.get("source") != "slot":
        return None
    slot = entry.get("slot")
    return slot if isinstance(slot, dict) and slot.get("kind") else None


def _party(name: str, identifier: str = "", party_type: str = "individual", representative: str = "") -> dict:
    return {
        "name": str(name or "").strip(),
        "identifier": str(identifier or "").strip(),
        "party_type": party_type,
        "representative": str(representative or "").strip(),
    }


def _coerce_parties(value: Any) -> list[dict]:
    """Normalise anything a picker or the agent may hand back into parties."""
    if value is None or value == "":
        return []

    if isinstance(value, str):
        text = value.strip()
        if text.startswith("{") or text.startswith("["):
            try:
                return _coerce_parties(json.loads(text))
            except (ValueError, TypeError):
                return [_party(text)]
        return [_party(text)] if text and text.upper() != "TBD" else []

    if isinstance(value, list):
        parties = []
        for item in value:
            parties.extend(_coerce_parties(item))
        return parties

    if isinstance(value, dict):
        if "selected" in value:
            return _coerce_parties(value.get("selected"))
        if "candidates" in value and "selected" not in value:
            return []
        name = value.get("name") or value.get("full_name") or value.get("value") or ""
        if not name:
            return []
        representative = value.get("representative") or value.get("representative_name") or ""
        if isinstance(representative, dict):
            representative = representative.get("name") or representative.get("full_name") or ""
        return [
            _party(
                name=name,
                identifier=value.get("identifier") or value.get("nrc_passport_no") or value.get("nrc") or "",
                party_type=value.get("party_type") or "individual",
                representative=representative,
            )
        ]

    return [_party(str(value))]


def _selection_keys(placeholder: str, slot: dict) -> list[str]:
    kind = slot.get("kind", "")
    keys = [placeholder, _norm(placeholder), kind, f"{kind}_name", f"{kind}s"]
    if kind in MULTI_KINDS:
        keys.append(f"{kind}_list")
    return [k for k in keys if k]


def _parties_from_data(placeholder: str, slot: dict, data: dict) -> list[dict]:
    """Selections carried in the supplied data, in the pickers' own shape."""
    if not isinstance(data, dict):
        return []

    kind = slot.get("kind", "")
    keys = _selection_keys(placeholder, slot)

    for container_key in _SELECTION_CONTAINERS:
        container = data.get(container_key)
        if isinstance(container, dict):
            for key in keys:
                if container.get(key):
                    parties = _coerce_parties(container[key])
                    if parties:
                        return parties
        elif isinstance(container, list):
            for item in container:
                if not isinstance(item, dict):
                    continue
                item_slot = _norm(item.get("slot") or item.get("kind"))
                picker = item.get("picker")
                matches_slot = item_slot and item_slot in {_norm(k) for k in keys}
                matches_picker = picker in PICKER_KINDS and kind in PICKER_KINDS[picker]
                if matches_slot or matches_picker:
                    parties = _coerce_parties(item)
                    if parties:
                        return parties

    for key in keys:
        if data.get(key):
            parties = _coerce_parties(data[key])
            if parties:
                return parties

    for picker, kinds in PICKER_KINDS.items():
        if kind in kinds and data.get(picker):
            parties = _coerce_parties(data[picker])
            if parties:
                return parties

    return []


def _parties_from_document(document_id: Any, slot: dict) -> list[dict]:
    """Selections already captured for this document in document_signatories."""
    if not document_id:
        return []
    try:
        doc_id = int(document_id)
    except (TypeError, ValueError):
        return []

    conn = None
    try:
        from db.connection import get_db_conn

        conn = get_db_conn()
        cur = conn.cursor()
        cur.execute(
            """
            SELECT ds.party_type, p.full_name, p.nrc_passport_no,
                   c.company_name_english, c.company_registration_number, rp.full_name
            FROM document_signatories ds
            LEFT JOIN people p ON p.id = ds.person_id
            LEFT JOIN companies c ON c.id = ds.corporate_company_id
            LEFT JOIN people rp ON rp.id = ds.representative_person_id
            WHERE ds.document_id = %s AND ds.slot = %s
            ORDER BY ds.position ASC, ds.id ASC
            """,
            (doc_id, slot.get("kind", "")),
        )
        rows = cur.fetchall()
        cur.close()
    except Exception as e:  # noqa: BLE001
        _logger.warning(f"Failed to load document_signatories for document {document_id}: {e}")
        return []
    finally:
        if conn is not None:
            conn.close()

    parties = []
    for party_type, person_name, person_nrc, corporate_name, corporate_reg, rep_name in rows:
        if party_type == "corporate" and corporate_name:
            parties.append(_party(corporate_name, corporate_reg or "", "corporate", rep_name or ""))
        elif person_name:
            parties.append(_party(person_name, person_nrc or "", "individual"))
    return parties


def _parties_from_picker_log(company_name: str | None, slot: dict) -> list[dict]:
    """The most recent in-chat picker answer for this company and slot kind.

    The picker and the document generation are separate tool calls, so the answer
    is written to party_selections when the user confirms and read back here.
    Without this the model has to remember to pass the name through custom_data,
    and when it forgets the fill silently falls back to the first director on
    file — which is the wrong person.
    """
    kind = slot.get("kind", "")
    if not company_name or not kind:
        return []

    # No conversation in scope means a non-chat caller — the Fill-in view, which
    # generates from values the user chose in the UI. It has no picker log of
    # its own and must not inherit one, so there is nothing to read back.
    session_id = current_session_scope()
    if not session_id:
        return []

    pickers = [p for p, kinds in PICKER_KINDS.items() if kind in kinds]
    if not pickers:
        return []

    conn = None
    try:
        from db.connection import get_db_conn

        conn = get_db_conn()
        cur = conn.cursor()
        cur.execute(
            """
            SELECT selection FROM party_selections
            WHERE LOWER(company_name) = LOWER(%s)
              AND picker = ANY(%s)
              AND slot_kind = %s
              AND session_id = %s
              AND created_at > NOW() - INTERVAL '30 minutes'
            ORDER BY created_at DESC, id DESC
            LIMIT 1
            """,
            # Three things scope a read-back, and each one closed a real defect:
            #
            # slot_kind — without it this matched on company + picker alone, so
            # ANY pick for this company in the last 30 minutes was reusable for
            # ANY role: a person chosen as the INCOMING director on one document
            # appeared on the NEXT document's resignation line, replacing the
            # director who was actually resigning. Wrong person, right company,
            # no warning.
            #
            # session_id — without it a pick bled between CONVERSATIONS. Measured
            # 2026-08-06: a director chosen in one chat was silently reused in an
            # unrelated chat 24 minutes later, putting a name nobody in that
            # conversation had given into generated meeting minutes.
            #
            # the 30-minute window — a backstop, not the guard. Session scope is.
            #
            # `slot_kind = ''` and `session_id = ''` are deliberately NOT
            # tolerated. Rows written before either column existed simply stop
            # resolving, and the agent asks again — which is the correct
            # behaviour, and better than reusing a pick whose role or
            # conversation we cannot establish.
            (company_name.strip(), pickers, kind, session_id),
        )
        row = cur.fetchone()
        cur.close()
    except Exception as e:  # noqa: BLE001
        _logger.warning(f"Failed to read party_selections for '{company_name}': {e}")
        return []
    finally:
        if conn is not None:
            conn.close()

    return _coerce_parties(row[0]) if row and row[0] else []


def selected_parties(
    placeholder: str,
    entry: dict,
    data: dict,
    document_id: Any = None,
    company_name: str | None = None,
) -> list[dict]:
    """Explicit selections for a slot, most authoritative first.

    The picker log outranks `data`: by fill time `data` carries the company
    record's auto-filled value for the placeholder (the first director on file),
    which is a guess, whereas the picker log is a person the user actually
    clicked. Letting `data` win is what silently replaced the chosen director
    with directors[0].
    """
    slot = slot_of(entry)
    if not slot:
        return []
    return (
        _parties_from_document(document_id, slot)
        or _parties_from_picker_log(company_name, slot)
        or _parties_from_data(placeholder, slot, data)
    )


def _party_text(party: dict, kind: str) -> str:
    if kind == "representative" and party.get("representative"):
        return party["representative"]
    return party.get("name", "")


def render_parties(placeholder: str, slot: dict, parties: list[dict], blank: str = "") -> Any:
    """Render selected parties as the template expects for this placeholder.

    Templates lay a multi slot out either as one placeholder per position
    (``shareholder_2_name``) or as a single inline list.
    """
    kind = slot.get("kind", "")
    names = [n for n in (_party_text(p, kind) for p in parties) if n]
    if not names:
        return None

    if not slot.get("multi"):
        return names[0]

    match = _INDEX_IN_NAME.search(_norm(placeholder))
    if match:
        index = int(match.group(1))
        if index < 1:
            return None
        return names[index - 1] if index <= len(names) else blank

    return names


def corporate_shareholder_directors(corporate_name: str) -> list[dict]:
    """Directors of a CORPORATE SHAREHOLDER — its own board, not the document company's."""
    if not corporate_name:
        return []
    conn = None
    try:
        from db.connection import get_db_conn

        from scout.tools.people_picker import _directors_of

        conn = get_db_conn()
        cur = conn.cursor()
        resolved = _directors_of(cur, corporate_name)
        cur.close()
        return resolved.get("candidates", []) if resolved.get("found") else []
    except Exception as e:  # noqa: BLE001
        _logger.warning(f"Failed to load directors of corporate shareholder '{corporate_name}': {e}")
        return []
    finally:
        if conn is not None:
            conn.close()


def _corporate_shareholder_name(data: dict, company_name: str | None) -> str:
    """Which corporate shareholder a corporate_shareholder slot belongs to."""
    if isinstance(data, dict):
        for key in (
            "corporate_shareholder_name", "corporate_shareholder", "signing_shareholder",
            "corporate_shareholder_3_name", "shareholder_company_name",
        ):
            value = data.get(key)
            if value and str(value).strip().upper() != "TBD":
                return str(value).strip()

    if not company_name:
        return ""

    conn = None
    try:
        from db.connection import get_db_conn

        conn = get_db_conn()
        cur = conn.cursor()
        cur.execute(
            "SELECT shareholder_links FROM companies WHERE company_name_english ILIKE %s LIMIT 1",
            (f"%{company_name}%",),
        )
        row = cur.fetchone()
        cur.close()
    except Exception as e:  # noqa: BLE001
        _logger.warning(f"Failed to load shareholder_links for '{company_name}': {e}")
        return ""
    finally:
        if conn is not None:
            conn.close()

    links = row[0] if row and isinstance(row[0], list) else []
    for link in links:
        if not isinstance(link, dict):
            continue
        if (link.get("party_type") or link.get("type") or "").lower() != "corporate":
            continue
        name = link.get("name") or link.get("company_name") or ""
        if name:
            return str(name)
    return ""


# An NRC / passport / identification placeholder — the identifier half of a
# person, as opposed to their name.
_IDENTIFIER_ATTR_RE = re.compile(
    r"(?:^|[_\s])(?:"
    r"nrc|nrc_no|nrc_number|nrc_passport_no|nrc_passport_number|"
    r"passport|passport_no|passport_number|"
    r"identification_number|identification_no|identity_number|"
    r"identification|id_number|id_no"
    r")$"
)

# The name half of a person, so a role prefix can be matched to its slot.
_NAME_ATTR_RE = re.compile(r"(?:^|[_\s])(?:name|full_name)$")


def _role_prefix(placeholder: str, attr_re: re.Pattern) -> str:
    """The role part of `new_director_identification_number` → `new_director`."""
    norm = str(placeholder or "").replace("\xa0", " ").strip().lower()
    match = attr_re.search(norm)
    if not match:
        return ""
    return norm[: match.start()].strip(" _")


def companion_identifier(
    placeholder: str,
    mapping: dict,
    data: dict,
    company_name: str | None = None,
    document_id: Any = None,
) -> str | None:
    """The NRC/passport of the person a sibling slot already resolved to.

    Templates split one person across two placeholders — `new_director_name`
    (a slot, answered by a picker) and `new_director_identification_number`
    (classified `user_input` by training, so asked as free text). Nothing tied
    them together, so the two halves of one person's identity resolved from two
    different sources.

    Measured 2026-08-06: the name arrived from a picker selection while the NRC
    was asked as text and left blank, and the minutes went out reading
    "SOE MOE THU (holder of Myanmar NRC/Passport number: )". The register had
    his NRC the whole time.

    So an identifier placeholder is answered by the person its sibling name slot
    resolved to, and is only asked when there is no such person.
    """
    prefix = _role_prefix(placeholder, _IDENTIFIER_ATTR_RE)
    if not prefix or not isinstance(mapping, dict):
        return None

    for key, entry in mapping.items():
        if not slot_of(entry):
            continue
        # The sibling is the name of the SAME role: `new_director_name` for
        # `new_director_identification_number`. A bare `new_director` counts
        # too — some templates name the slot without the `_name` suffix.
        key_norm = str(key or "").replace("\xa0", " ").strip().lower()
        if _role_prefix(key, _NAME_ATTR_RE) != prefix and key_norm != prefix:
            continue

        parties = selected_parties(
            key, entry, data, document_id=document_id, company_name=company_name
        )
        for party in parties:
            identifier = str(party.get("identifier") or "").strip()
            if identifier:
                return identifier
        # The sibling resolved to somebody with no identifier on file, or to
        # nobody at all. Either way there is nothing to copy; fall through so
        # the normal user_input path asks.
        return None

    return None


def resolve_slot(
    placeholder: str,
    entry: dict,
    data: dict,
    company_name: str | None = None,
    document_id: Any = None,
    blank: str = "",
) -> Any:
    """Resolve a slot entry, or None when the caller must ask."""
    slot = slot_of(entry)
    if not slot:
        return None

    parties = selected_parties(
        placeholder, entry, data, document_id=document_id, company_name=company_name
    )
    if parties:
        return render_parties(placeholder, slot, parties, blank=blank)

    default = entry.get("default")
    if default and default != "today" and str(default).strip():
        return str(default)

    return None


def slot_request(placeholder: str, entry: dict, data: dict, company_name: str | None = None) -> dict | None:
    """Describe an unresolved slot as a picker call, not a prose question."""
    slot = slot_of(entry)
    if not slot:
        return None

    kind = slot.get("kind", "")
    of = slot.get("of", "document_company")

    if of == "people_register":
        picker, lookup = REGISTER_PICKER
        scope = ""
    else:
        picker, lookup = PICKERS.get(kind, DEFAULT_PICKER)
        scope = company_name or ""
        if of == "corporate_shareholder":
            scope = _corporate_shareholder_name(data, company_name)
            picker, lookup = PICKERS.get("representative", DEFAULT_PICKER)

    return {
        "placeholder": placeholder,
        "kind": kind,
        "of": of,
        "multi": bool(slot.get("multi")),
        "picker": picker,
        "lookup_tool": lookup,
        "candidates_from": scope,
        "document_company": company_name or "",
        "description": entry.get("description", ""),
    }


def _member_family_parties(data: dict, company_name: str | None) -> list[dict]:
    """The real member/attendee list a template's numbered shareholder slots will
    be expanded to by repeat_regions — from supplied data or the company register.
    Used to suppress phantom numbered-slot asks (finding F1)."""
    try:
        from scout.tools.repeat_regions import _parties_for_family
        return _parties_for_family("member", "name", data or {}, company_name) or []
    except Exception as e:  # noqa: BLE001
        _logger.warning(f"member-family resolve failed for {company_name!r}: {e}")
        return []


def _party_is_corporate(party: dict) -> bool:
    try:
        from scout.tools.repeat_regions import _is_corporate
        return _is_corporate(party if isinstance(party, dict) else {"name": str(party)})
    except Exception:  # noqa: BLE001
        return False


def _repeat_family(placeholder: str) -> str | None:
    """Which repeat_regions party family a placeholder belongs to (or None).

    Asking repeat_regions itself — rather than re-deriving the rule here — keeps
    the ask step and the fill step from drifting apart: we only ever suppress a
    question the expander demonstrably answers.
    """
    try:
        from scout.tools.repeat_regions import _family
        return _family(placeholder or "")
    except Exception as e:  # noqa: BLE001
        _logger.warning(f"repeat_regions family classify failed for {placeholder!r}: {e}")
        return None


def _slot_position(placeholder: str) -> int | None:
    """The 1-based position a numbered slot occupies (`shareholder_2_name` -> 2)."""
    match = _INDEX_IN_NAME.search(_norm(placeholder))
    if not match:
        return None
    index = int(match.group(1))
    return index if index >= 1 else None


def _member_position_covered(placeholder: str, member_parties: list[dict]) -> bool:
    """True when repeat_regions will settle this numbered MEMBER slot on its own.

    Two ways it settles: the register has a party at that position (the slot is
    filled from it), or the register has fewer members than the template has
    slots, in which case the surplus unit is DELETED from the document and the
    position stops existing. Either way the ask is noise.

    Only the `member` family qualifies — appointed-director and signing-director
    lists have no register fallback in `_parties_for_family`, so they are only
    resolvable when the agent supplies them, and `resolve_slot` above already
    catches that case.
    """
    if not member_parties:
        return False  # nothing on file: we cannot prove anything, so ask
    position = _slot_position(placeholder)
    if position is None:
        return False
    if position > len(member_parties):
        return True
    try:
        from scout.tools.repeat_regions import _render_value, _tail_attr
        return bool(_render_value(member_parties[position - 1], _tail_attr(placeholder)))
    except Exception as e:  # noqa: BLE001
        _logger.warning(f"member-position render check failed for {placeholder!r}: {e}")
        return False


def _corp_rep_resolvable(party: dict, data: dict) -> bool:
    """True when a corporate member's authorised representative is already known
    or auto-resolvable (from the party, the supplied data, or the register). When
    it is, forcing a representative pick is a phantom ask (findings F1 + F4)."""
    try:
        from scout.tools.repeat_regions import _corp_representative
        return bool(_corp_representative(
            party if isinstance(party, dict) else {"name": str(party)}, data or {}))
    except Exception:  # noqa: BLE001
        p = party if isinstance(party, dict) else {}
        return bool(p.get("representative") or p.get("representative_name"))


# Roles the register can never answer: a director being APPOINTED is not on the
# register yet, a RESIGNING one has to be named by the user, a chairperson is a
# choice among many, an auditor is an engagement decision. These are the reason
# the ask step exists, so no suppression rule below may touch them. (Pronouns and
# dates are not slots at all — they are user_input entries this function never
# sees — so they keep being asked for free.)
_NEVER_SUPPRESS_KINDS = frozenset({
    "new_director", "resigning_director", "chairperson", "auditor",
})

_CORPORATE_SLOT_RE = re.compile(r"corporate", re.I)


def collect_slot_requests(
    mapping: dict,
    required_fields: list,
    data: dict,
    company_name: str | None = None,
    document_id: Any = None,
) -> list[dict]:
    """Unresolved slots for the placeholders a template actually renders."""
    if not isinstance(mapping, dict):
        return []

    wanted = {_norm(f) for f in (required_fields or [])}
    requests = []
    seen = set()

    # The numbered shareholder/member/attendee slots in a template
    # (`individual shareholder_1_name`, `corporate shareholder_3_name`, ...) are a
    # FIXED layout; repeat_regions grows/shrinks them to the company's REAL member
    # list at fill time. So when that list is already known (supplied or on the
    # register) we must not force the user to fill phantom positions the company
    # does not have (finding F1). The corporate-representative sub-ask is only real
    # when an actual corporate member is present and its representative is unknown.
    member_parties = _member_family_parties(data, company_name)
    corp_members = [p for p in member_parties if _party_is_corporate(p)]
    corp_needs_rep = any(not _corp_rep_resolvable(p, data) for p in corp_members)

    for placeholder, entry in mapping.items():
        slot = slot_of(entry)
        if not slot:
            continue
        if wanted and _norm(placeholder) not in wanted:
            continue
        if resolve_slot(placeholder, entry, data, company_name=company_name, document_id=document_id) is not None:
            continue
        request = slot_request(placeholder, entry, data, company_name=company_name)
        if not request:
            continue

        kind = request["kind"]
        # Member/attendee list: repeat_regions fills it from the same source, so
        # the forced pick is only needed when NO member list is resolvable at all.
        if kind in ("shareholder_list", "attendee") and member_parties:
            continue
        # Corporate representative: skip unless a real corporate member needs one.
        if kind == "representative" and request["of"] == "corporate_shareholder":
            if not corp_members or not corp_needs_rep:
                continue

        if kind not in _NEVER_SUPPRESS_KINDS:
            # A slot that names the CORPORATE side of the member layout
            # (`corporate shareholder_3_name`, and anything scoped to the corporate
            # shareholder) exists only because the template hard-codes a corporate
            # position. When the register is known and holds no corporate member,
            # repeat_regions collapses that region away, so the question is about a
            # position the finished document will not contain. An EMPTY register
            # proves nothing, hence the `member_parties` guard.
            targets_corporate = (
                request["of"] == "corporate_shareholder"
                or _CORPORATE_SLOT_RE.search(_norm(placeholder) or "") is not None
            )
            if targets_corporate and member_parties and not corp_members:
                continue

            # A numbered member position the register already covers (or that the
            # register shrinks out of the document entirely). Checked per position
            # rather than per kind so a slot that classifies as something else but
            # still belongs to the member family is caught too.
            if _repeat_family(placeholder) == "member" and _member_position_covered(
                placeholder, member_parties
            ):
                continue

        key = (request["kind"], request["of"], request["candidates_from"], request["multi"])
        if key in seen:
            continue
        seen.add(key)
        requests.append(request)

    return requests
