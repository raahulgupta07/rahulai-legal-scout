"""
Slot contract
=============

Single source of truth for the shape of a ``templates.field_mapping`` entry.

A field_mapping entry is::

    {
      "source": "db" | "user_input" | "slot",
      "db_column": str | None,     # only when source == "db"; never an array index
      "slot": {"kind": str, "of": str, "multi": bool} | None,
      "default": str | None,       # never "today"
      "description": str
    }

A ``slot`` is a person or party the user must choose at generation time. It is
resolved against ``company_people`` / ``people`` / ``document_signatories``
(migration 011), never frozen to an array position at training time.
"""

import re

SLOT_KINDS = frozenset({
    "signatory",
    "attendee",
    "chairperson",
    "resigning_director",
    "new_director",
    "representative",
    "shareholder_list",
    "auditor",
})

SLOT_OF = frozenset({
    "document_company",
    "corporate_shareholder",
    "people_register",
})

MAPPING_SOURCES = frozenset({"db", "user_input", "slot"})

FORBIDDEN_DEFAULTS = frozenset({"today", "now", "current_date", "today's date"})

PERSON_COLUMNS = frozenset({"directors", "members", "shareholder_links"})

COMPANY_COLUMNS = frozenset({
    "company_name_english",
    "company_name_myanmar",
    "company_registration_number",
    "registration_date",
    "status",
    "company_type",
    "foreign_company",
    "small_company",
    "principal_activity",
    "date_of_last_annual_return",
    "previous_registration_number",
    "registered_office_address",
    "principal_place_of_business",
    "ultimate_holding_company_name",
    "ultimate_holding_company_jurisdiction",
    "ultimate_holding_company_registration_number",
    "total_shares_issued",
    "currency_of_share_capital",
    "filing_history",
    "under_corpsec_management",
    "group_company",
    "total_capital",
    "consideration_amount_paid",
    "financial_year_end_date",
    "next_financial_year_end_date",
    "auditor_name",
    "auditor_fee",
    "custom_fields",
})

_INDEX_RE = re.compile(r"\[[^\]]*\]")
_NUMERIC_INDEX_RE = re.compile(r"\[\s*\d+\s*\]")

_LEGACY_SLOT_KINDS = {
    "directors": "signatory",
    "members": "attendee",
    "shareholder_links": "shareholder_list",
}


def _blank(value) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _empty_entry(description: str = "") -> dict:
    return {
        "source": "user_input",
        "db_column": None,
        "slot": None,
        "default": None,
        "description": description,
    }


def validate_mapping_entry(entry) -> tuple[bool, str | None]:
    """Validate one field_mapping entry. Returns (ok, error)."""
    if not isinstance(entry, dict):
        return False, "entry is not an object"

    source = entry.get("source")
    if source not in MAPPING_SOURCES:
        return False, f"source must be one of {sorted(MAPPING_SOURCES)}, got {source!r}"

    db_column = entry.get("db_column")
    slot = entry.get("slot")
    default = entry.get("default")
    description = entry.get("description")

    if not _blank(default):
        if not isinstance(default, str):
            return False, "default must be a string or null"
        if default.strip().lower() in FORBIDDEN_DEFAULTS:
            return False, f"default {default!r} is forbidden — dates are never auto-filled"

    if description is not None and not isinstance(description, str):
        return False, "description must be a string"

    if source == "db":
        if _blank(db_column):
            return False, "source 'db' requires db_column"
        if not isinstance(db_column, str):
            return False, "db_column must be a string"
        if _INDEX_RE.search(db_column):
            return False, f"db_column {db_column!r} contains an array index"
        if not _blank(slot):
            return False, "source 'db' must not carry a slot"
        root = db_column.split(".")[0].strip()
        if root in PERSON_COLUMNS:
            return False, f"db_column {db_column!r} names a person list — use a slot instead"
        if root not in COMPANY_COLUMNS:
            return False, f"db_column {db_column!r} is not a known companies column"
        return True, None

    if source == "user_input":
        if not _blank(db_column):
            return False, "source 'user_input' must not carry a db_column"
        if not _blank(slot):
            return False, "source 'user_input' must not carry a slot"
        return True, None

    if not isinstance(slot, dict):
        return False, "source 'slot' requires a slot object"
    if not _blank(db_column):
        return False, "source 'slot' must not carry a db_column"

    kind = slot.get("kind")
    of = slot.get("of")
    multi = slot.get("multi")
    if kind not in SLOT_KINDS:
        return False, f"slot.kind must be one of {sorted(SLOT_KINDS)}, got {kind!r}"
    if of not in SLOT_OF:
        return False, f"slot.of must be one of {sorted(SLOT_OF)}, got {of!r}"
    if not isinstance(multi, bool):
        return False, f"slot.multi must be a boolean, got {multi!r}"
    return True, None


def normalise_legacy_entry(entry) -> dict:
    """Upgrade an index-based or otherwise legacy entry to the slot contract."""
    if not isinstance(entry, dict):
        return _empty_entry()

    description = entry.get("description") or ""
    if not isinstance(description, str):
        description = str(description)

    source = entry.get("source")
    db_column = entry.get("db_column")
    slot = entry.get("slot")
    default = entry.get("default")

    if not isinstance(db_column, str) or not db_column.strip():
        db_column = None
    else:
        db_column = db_column.strip()

    if isinstance(default, str):
        default = default.strip() or None
        if default and default.lower() in FORBIDDEN_DEFAULTS:
            default = None
    elif default is not None and not isinstance(default, str):
        default = str(default)

    if isinstance(slot, dict) and slot.get("kind") in SLOT_KINDS:
        return {
            "source": "slot",
            "db_column": None,
            "slot": {
                "kind": slot.get("kind"),
                "of": slot.get("of") if slot.get("of") in SLOT_OF else "document_company",
                "multi": bool(slot.get("multi")),
            },
            "default": default,
            "description": description,
        }

    if db_column:
        root = db_column.split(".")[0].split("[")[0].strip()
        if root in _LEGACY_SLOT_KINDS:
            indexed = _INDEX_RE.search(db_column)
            single = bool(indexed and _NUMERIC_INDEX_RE.search(db_column))
            kind = _LEGACY_SLOT_KINDS[root]
            if root == "members" and not single:
                kind = "shareholder_list"
            return {
                "source": "slot",
                "db_column": None,
                "slot": {
                    "kind": kind,
                    "of": "document_company",
                    "multi": not single,
                },
                "default": default,
                "description": description,
            }
        db_column = _INDEX_RE.sub("", db_column)
        return {
            "source": "db",
            "db_column": db_column,
            "slot": None,
            "default": default,
            "description": description,
        }

    if source == "db":
        return _empty_entry(description) | {"default": default}

    return {
        "source": "user_input",
        "db_column": None,
        "slot": None,
        "default": default,
        "description": description,
    }


def normalise_mapping(mapping) -> dict:
    """Upgrade a whole stored field_mapping to the slot contract."""
    if not isinstance(mapping, dict):
        return {}
    return {str(key): normalise_legacy_entry(value) for key, value in mapping.items()}


def sanitise_mapping(mapping) -> tuple[dict, list[str], list[str]]:
    """Normalise then validate a mapping.

    Returns (clean_mapping, rejected, repaired). An entry the model got wrong is
    repaired when normalisation can rescue it, and dropped when it cannot.
    """
    clean, rejected, repaired = {}, [], []
    if not isinstance(mapping, dict):
        return clean, ["mapping is not an object"], repaired
    for key, value in mapping.items():
        raw_ok, raw_error = validate_mapping_entry(value)
        entry = normalise_legacy_entry(value)
        ok, error = validate_mapping_entry(entry)
        if not ok:
            rejected.append(f"{key}: {error}")
            continue
        if not raw_ok:
            repaired.append(f"{key}: {raw_error}")
        clean[str(key)] = entry
    return clean, rejected, repaired
