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

import json
import logging
import re
from typing import Any

from scout.tools.field_aliases import normalize_field

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

_KIND_PATTERNS = (
    ("resigning_director", r"resign"),
    ("new_director", r"new_director|appointed_director|incoming_director|appointee"),
    ("chairperson", r"chair"),
    ("representative", r"represent|authoris?ed_person|authoriz?ed_person"),
    ("attendee", r"attend|present_member|persons_present"),
    ("auditor", r"auditor"),
    ("shareholder_list", r"shareholder|member"),
    ("signatory", r"director|signator|signed_by|sign"),
)

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


def selected_parties(placeholder: str, entry: dict, data: dict, document_id: Any = None) -> list[dict]:
    """Explicit selections for a slot: this document first, then supplied data."""
    slot = slot_of(entry)
    if not slot:
        return []
    return _parties_from_document(document_id, slot) or _parties_from_data(placeholder, slot, data)


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

    parties = selected_parties(placeholder, entry, data, document_id=document_id)
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
        key = (request["kind"], request["of"], request["candidates_from"], request["multi"])
        if key in seen:
            continue
        seen.add(key)
        requests.append(request)

    return requests
