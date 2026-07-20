"""
Field Alias Table
=================

Collapses known synonyms to a single canonical key so a value captured under
one name (``nric``) resolves a placeholder written under another (``nrc_no``).

To extend: add a new entry to ALIAS_GROUPS. Keys are matched after
normalisation (lowercase, spaces/hyphens folded to underscores).
"""

ALIAS_GROUPS: dict[str, list[str]] = {
    "nrc_no": [
        "nric", "nrc", "nrc_no", "nrc_number", "nrc_passport",
        "passport_no", "passport_number", "id_number", "identification_number",
        "identity_number", "nrc_or_passport", "nrc_passport_no",
    ],
    "date_of_birth": ["dob", "date_of_birth", "birth_date", "birthdate"],
    "phone_number": [
        "phone", "phone_number", "telephone", "telephone_number",
        "contact_number", "contact_no", "mobile", "mobile_number",
    ],
    "address": [
        "address", "residential_address", "addr", "home_address",
    ],
    "number_of_shares": [
        "shares", "number_of_shares", "share_quantity", "no_of_shares",
        "shares_held", "shareholding",
    ],
    "capital_amount": [
        "capital", "capital_amount", "amount", "share_capital_amount",
    ],
}

GENERIC_TOKENS: frozenset[str] = frozenset({
    "date", "name", "number", "no", "id", "type", "amount", "value",
    "of", "the", "and", "address", "time",
})


def _build_alias_map() -> dict[str, str]:
    alias_map: dict[str, str] = {}
    for canonical, synonyms in ALIAS_GROUPS.items():
        alias_map[canonical] = canonical
        for synonym in synonyms:
            alias_map[synonym] = canonical
    return alias_map


ALIAS_MAP: dict[str, str] = _build_alias_map()


def normalize_field(name: str) -> str:
    """Normalise a placeholder or data key to comparison form."""
    return str(name or "").strip().lower().replace(" ", "_").replace("-", "_")


def canonical_field(name: str) -> str:
    """Return the canonical key for a placeholder or data key."""
    normalized = normalize_field(name)
    return ALIAS_MAP.get(normalized, normalized)


def tokens_of(name: str) -> set[str]:
    """Split a normalised field name into its comparison tokens."""
    return {tok for tok in normalize_field(name).split("_") if tok}


def tokens_match(placeholder: str, key: str) -> bool:
    """True when every token of the placeholder is present in the data key.

    A placeholder made up only of generic tokens never matches this way —
    'date' must not claim 'meeting_date'.
    """
    placeholder_tokens = tokens_of(placeholder)
    if not placeholder_tokens:
        return False
    if placeholder_tokens <= GENERIC_TOKENS:
        return False
    return placeholder_tokens <= tokens_of(key)
