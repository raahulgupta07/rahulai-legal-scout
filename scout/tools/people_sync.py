"""
People-register sync
====================

A company record carries its directors and members as JSONB blobs straight from
the DICA filing. The People register is the deduped projection of those blobs:
one row per human, linked to as many companies as they appear in.

Nothing used to bridge the two, so the register stayed empty unless an admin
typed every person in by hand. `sync_company_people` closes that gap. It runs
after a company is saved and can also be replayed over every existing company
(the backfill endpoint) — it is idempotent either way.

Identity rules
--------------
NRC / passport number is the real key: it is nationally unique, and the
`idx_people_nrc` partial UNIQUE index enforces that. When a person has no NRC in
the filing we fall back to normalised name + date of birth, then to name alone.

Merge rule: the existing person row wins. We only fill columns that are
currently NULL or blank, so a hand-corrected spelling or an address typed into
the register survives every later DICA extract.

Corporate members are deliberately skipped — a company is not a person. They
stay on `companies.members` and are handled by the corporate-signing path.
"""

import json
import logging
import re
from typing import Any

logger = logging.getLogger("legalscout.people_sync")

# Stamped on rows the sync created, so cleanup can tell them from hand-added
# people. Anything typed into the register by an admin carries their email.
SYNC_AUTHOR = "sync@company"

# Person columns the sync may fill in, mapped to the keys DICA uses for them.
_FIELD_SOURCES = {
    "nationality": ("nationality",),
    "nrc_passport_no": ("nrc_passport", "nrc_passport_no", "nrc", "passport"),
    "gender": ("gender",),
    "date_of_birth": ("date_of_birth", "dob"),
    "phone": ("phone",),
    "email": ("email",),
    "residential_address": ("residential_address", "address"),
    # DICA publishes an occupation per director; the register kept no column for
    # it until migration 015, so every sync before that quietly dropped it.
    "business_occupation": ("business_occupation", "occupation"),
    # Not in the DICA extract — hand-entered, but carried here so a filing that
    # does supply it (or a manual re-sync) is not thrown away.
    "country_of_residence": ("country_of_residence", "country"),
}

# Values that mean "the filing left this blank".
_EMPTY_MARKERS = {"", "-", "--", "n/a", "na", "none", "null", "nil"}

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _clean(value: Any, limit: int = 500) -> str | None:
    """Trim a DICA value, mapping its placeholder markers to None."""
    if value is None:
        return None
    text = str(value).strip()
    if text.lower() in _EMPTY_MARKERS:
        return None
    return text[:limit]


def _pick(entry: dict[str, Any], keys: tuple[str, ...], limit: int = 500) -> str | None:
    for key in keys:
        cleaned = _clean(entry.get(key), limit)
        if cleaned:
            return cleaned
    return None


def _clean_date(value: Any) -> str | None:
    """Only accept an unambiguous ISO date — a half-parsed date is worse than none."""
    text = _clean(value, 32)
    if text and _DATE_RE.match(text):
        return text
    return None


def _norm_name(name: str) -> str:
    """Fold spacing and case so 'MIN  MIN' and 'Min Min' are the same person."""
    return re.sub(r"\s+", " ", (name or "").strip()).upper()


def _is_corporate(entry: dict[str, Any]) -> bool:
    """A member row is a company, not a human."""
    kind = (_clean(entry.get("type")) or "").lower()
    if kind in {"company", "corporate", "corporation", "body corporate", "corporate shareholder"}:
        return True
    # A registration number only ever belongs to an entity.
    return bool(_clean(entry.get("registration_number")))


def _as_list(value: Any) -> list[dict[str, Any]]:
    """companies.directors / .members arrive as JSONB, str or already-parsed list."""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (ValueError, TypeError):
            return []
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _collect(directors: Any, members: Any) -> list[dict[str, Any]]:
    """Merge directors and individual members into one entry per human.

    Someone who is both a director and a shareholder collapses into a single
    person carrying the role 'both' and the shareholding from the member row.
    """
    by_key: dict[str, dict[str, Any]] = {}
    order: list[str] = []

    def absorb(entry: dict[str, Any], role: str) -> None:
        name = _clean(entry.get("name"))
        if not name:
            return
        # Key on NRC when we have one so the two source lists line up even when
        # the name is spelled differently between them.
        nrc = _pick(entry, _FIELD_SOURCES["nrc_passport_no"], 100)
        key = f"nrc:{nrc.upper()}" if nrc else f"name:{_norm_name(name)}"

        record = by_key.get(key)
        if record is None:
            record = {"name": name, "roles": set(), "fields": {}, "link": {}}
            by_key[key] = record
            order.append(key)
        record["roles"].add(role)

        for column, keys in _FIELD_SOURCES.items():
            if record["fields"].get(column):
                continue
            value = _clean_date(entry.get(keys[0])) if column == "date_of_birth" else _pick(entry, keys, 2000)
            if column == "date_of_birth" and not value:
                value = _clean_date(entry.get("dob"))
            if value:
                record["fields"][column] = value

        link = record["link"]
        for column, keys, limit in (
            ("number_of_shares", ("share_quantity", "number_of_shares", "shares"), 100),
            ("capital_amount", ("amount_paid", "capital_amount"), 100),
            ("share_class", ("share_class",), 100),
        ):
            if not link.get(column):
                picked = _pick(entry, keys, limit)
                if picked:
                    link[column] = picked
        if not link.get("appointed_date"):
            appointed = _clean_date(entry.get("date_of_appointment")) or _clean_date(entry.get("appointed_date"))
            if appointed:
                link["appointed_date"] = appointed
        if not link.get("resigned_date"):
            resigned = _clean_date(entry.get("date_of_cessation")) or _clean_date(entry.get("resigned_date"))
            if resigned:
                link["resigned_date"] = resigned

    for entry in _as_list(directors):
        absorb(entry, "director")
    for entry in _as_list(members):
        if _is_corporate(entry):
            continue
        absorb(entry, "individual_shareholder")

    people = []
    for key in order:
        record = by_key[key]
        roles = record["roles"]
        record["role"] = "both" if len(roles) > 1 else next(iter(roles))
        people.append(record)
    return people


def _find_person(
    cur,
    name: str,
    nrc: str | None,
    dob: str | None,
    company_id: int | None = None,
) -> int | None:
    """Locate an existing person, strongest evidence first.

    NRC → name + date of birth → same name already linked to THIS company →
    name alone against someone carrying no NRC.

    The same-company rule exists because DICA's member table often gives a bare
    name with no NRC or date of birth, while the officers table on the very same
    filing gives the full identity. A single filing does not list two different
    people under one name, so a name match scoped to one company is safe — where
    the same match made globally would eventually merge two strangers who happen
    to share a common Myanmar name.
    """
    if nrc:
        cur.execute(
            "SELECT id FROM people WHERE upper(trim(nrc_passport_no)) = upper(trim(%s)) LIMIT 1",
            (nrc,),
        )
        row = cur.fetchone()
        if row:
            return row[0]

    if dob:
        cur.execute(
            "SELECT id FROM people WHERE upper(regexp_replace(trim(full_name), '\\s+', ' ', 'g')) = %s "
            "AND date_of_birth = %s LIMIT 1",
            (_norm_name(name), dob),
        )
        row = cur.fetchone()
        if row:
            return row[0]

    # Same filing, same name → same person, even with nothing else to go on.
    if company_id is not None:
        cur.execute(
            "SELECT p.id FROM people p "
            "JOIN company_people cp ON cp.person_id = p.id "
            "WHERE cp.company_id = %s "
            "AND upper(regexp_replace(trim(p.full_name), '\\s+', ' ', 'g')) = %s "
            "LIMIT 1",
            (company_id, _norm_name(name)),
        )
        row = cur.fetchone()
        if row:
            return row[0]

    # Name-only match is the weakest key, so it must not swallow a namesake who
    # already carries a different NRC.
    cur.execute(
        "SELECT id FROM people WHERE upper(regexp_replace(trim(full_name), '\\s+', ' ', 'g')) = %s "
        "AND (nrc_passport_no IS NULL OR trim(nrc_passport_no) = '') LIMIT 1",
        (_norm_name(name),),
    )
    row = cur.fetchone()
    return row[0] if row else None


def sync_company_people(
    conn,
    company_id: int,
    directors: Any,
    members: Any,
    created_by_email: str | None = None,
) -> dict[str, Any]:
    """Project a company's directors and individual members into the register.

    Runs on the caller's connection and does NOT commit — the caller owns the
    transaction. Existing person fields are never overwritten, only filled in.
    """
    stats = {"created": 0, "updated": 0, "linked": 0, "skipped_corporate": 0, "people": []}
    people = _collect(directors, members)
    stats["skipped_corporate"] = sum(1 for m in _as_list(members) if _is_corporate(m))
    if not people:
        return stats

    # person_id -> merged roles + link data, so one human yields one link row
    # however many times the filing describes them.
    resolved: dict[int, dict[str, Any]] = {}

    cur = conn.cursor()
    try:
        for record in people:
            name = record["name"]
            fields = record["fields"]
            nrc = fields.get("nrc_passport_no")
            dob = fields.get("date_of_birth")

            # Directors are absorbed before members in _collect, so by the time
            # a bare-name member is looked up the officer's link for this
            # company already exists for the same-company rule to find.
            person_id = _find_person(cur, name, nrc, dob, company_id)

            if person_id is None:
                columns = ["full_name", "created_by_email", *list(fields.keys())]
                # Always SYNC_AUTHOR, never the admin who triggered it: this
                # stamp is what lets prune_orphan_people tell a row the sync
                # created from one a human typed in.
                values = [name, SYNC_AUTHOR, *list(fields.values())]
                placeholders = ", ".join(["%s"] * len(columns))
                cur.execute(
                    f"INSERT INTO people ({', '.join(columns)}) VALUES ({placeholders}) RETURNING id",
                    values,
                )
                person_id = cur.fetchone()[0]
                stats["created"] += 1
            elif fields:
                # Fill blanks only — a hand-edited register entry always wins.
                # Column names come from _FIELD_SOURCES, never from user input.
                sets, values, blanks = [], [], []
                for col, value in fields.items():
                    if col == "date_of_birth":
                        sets.append("date_of_birth = COALESCE(date_of_birth, NULLIF(%s, '')::date)")
                        blanks.append("date_of_birth IS NULL")
                    else:
                        # A stored empty string counts as blank, same as NULL.
                        sets.append(f"{col} = COALESCE(NULLIF(trim({col}), ''), NULLIF(%s, ''))")
                        blanks.append(f"({col} IS NULL OR trim({col}) = '')")
                    values.append(value)
                # Only touch the row when there is genuinely a blank to fill, so
                # the reported "updated" count means something to the admin.
                cur.execute(
                    f"UPDATE people SET {', '.join(sets)}, updated_at = NOW() "
                    f"WHERE id = %s AND ({' OR '.join(blanks)})",
                    [*values, person_id],
                )
                if cur.rowcount:
                    stats["updated"] += 1

            # Roles are grouped by the RESOLVED person, not by the extracted
            # record. A filing can describe one human twice — a real DICA
            # extract had the same director as "12/LAHTANA(N)016603" in the
            # officer table and "12/LATHANA(N)016603" in the member table, a
            # transposed township code. Those key as two records but resolve to
            # one person, and only grouping here turns them into a single
            # 'both' link instead of two contradictory rows.
            slot = resolved.setdefault(person_id, {"name": name, "roles": set(), "link": {}})
            slot["roles"].update(record["roles"])
            for k, v in record["link"].items():
                if v and not slot["link"].get(k):
                    slot["link"][k] = v

        for person_id, slot in resolved.items():
            roles = slot["roles"]
            role = "both" if len(roles) > 1 else next(iter(roles))
            link = slot["link"]
            cur.execute(
                "INSERT INTO company_people (company_id, person_id, role, number_of_shares, "
                "capital_amount, share_class, appointed_date, resigned_date) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) "
                "ON CONFLICT (company_id, person_id, role) DO UPDATE SET "
                "number_of_shares = COALESCE(company_people.number_of_shares, EXCLUDED.number_of_shares), "
                "capital_amount = COALESCE(company_people.capital_amount, EXCLUDED.capital_amount), "
                "share_class = COALESCE(company_people.share_class, EXCLUDED.share_class), "
                "appointed_date = COALESCE(company_people.appointed_date, EXCLUDED.appointed_date), "
                "resigned_date = COALESCE(company_people.resigned_date, EXCLUDED.resigned_date), "
                "updated_at = NOW()",
                (
                    company_id,
                    person_id,
                    role,
                    link.get("number_of_shares"),
                    link.get("capital_amount"),
                    link.get("share_class"),
                    link.get("appointed_date"),
                    link.get("resigned_date"),
                ),
            )
            stats["linked"] += 1

            # Drop every role row for this person at this company except the one
            # just written — including rows left by an earlier, coarser sync.
            cur.execute(
                "DELETE FROM company_people WHERE company_id = %s AND person_id = %s AND role <> %s",
                (company_id, person_id, role),
            )

            stats["people"].append({"id": person_id, "name": slot["name"], "role": role})
    finally:
        cur.close()

    return stats


def prune_orphan_people(conn) -> dict[str, Any]:
    """Remove people the sync created who are no longer linked to any company.

    Called after a company is deleted. Deliberately narrow: a person is only
    removed when they hold ZERO company links AND the sync created them. Anyone
    an admin typed in by hand stays, as does anyone still linked elsewhere —
    a director sitting on two boards survives one of them being deleted.

    Caller commits.
    """
    cur = conn.cursor()
    try:
        cur.execute(
            "DELETE FROM people p "
            "WHERE p.created_by_email = %s "
            "AND NOT EXISTS (SELECT 1 FROM company_people cp WHERE cp.person_id = p.id) "
            "AND NOT EXISTS (SELECT 1 FROM document_signatories ds "
            "                WHERE ds.person_id = p.id OR ds.representative_person_id = p.id) "
            "RETURNING full_name",
            (SYNC_AUTHOR,),
        )
        removed = [r[0] for r in cur.fetchall()]
    finally:
        cur.close()

    if removed:
        logger.info(f"[PEOPLE SYNC] pruned {len(removed)} orphan(s): {', '.join(removed)}")
    return {"removed": len(removed), "names": removed}


def sync_all_companies(conn, created_by_email: str | None = None) -> dict[str, Any]:
    """Replay the sync over every stored company. Caller commits."""
    totals = {"companies": 0, "created": 0, "updated": 0, "linked": 0, "errors": []}
    cur = conn.cursor()
    try:
        cur.execute("SELECT id, company_name_english, directors, members FROM companies ORDER BY id")
        rows = cur.fetchall()
    finally:
        cur.close()

    for company_id, company_name, directors, members in rows:
        try:
            stats = sync_company_people(conn, company_id, directors, members, created_by_email)
            totals["companies"] += 1
            for key in ("created", "updated", "linked"):
                totals[key] += stats[key]
        except Exception as e:
            logger.warning(f"[PEOPLE SYNC] {company_name} (id={company_id}) failed: {e}")
            totals["errors"].append(f"{company_name}: {e}")

    return totals
