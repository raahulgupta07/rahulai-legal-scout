"""
Fast Info Tool
============

Quick direct answers for common questions without deep searching.
Uses PostgreSQL database for ALL data.
"""

from pathlib import Path
from typing import Any

from scout.tools.template_analyzer import get_all_templates_from_db, get_db_connection
from scout.tools.document_tracker import get_all_documents, get_document_stats
from scout.tools.companies_db import get_companies_info

DOCUMENTS_DIR = Path("/documents")


def get_companies_from_knowledge_lookup() -> list[str]:
    """Get companies from knowledge_lookup table as fallback."""
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            """
            SELECT DISTINCT key_value 
            FROM knowledge_lookup 
            WHERE key_name ILIKE %s AND key_value IS NOT NULL
            ORDER BY key_value
            """,
            ("company%",),
        )
        rows = cur.fetchall()
        cur.close()
        conn.close()
        return [row[0] for row in rows if row[0]]
    except Exception as e:
        print(f"Error getting companies from knowledge_lookup: {e}")
        return []


def get_templates_info() -> dict[str, Any]:
    """Get all templates info from database (single source of truth)."""
    templates_db = get_all_templates_from_db()
    template_names = [t["name"] for t in templates_db]

    return {
        "total": len(template_names),
        "analyzed": len(templates_db),
        "templates": template_names,
        "analyzed_details": templates_db,
    }


# What a template summary needs to be useful to the model, and nothing else.
#
# `when_to_use` is not optional here: it is the field that actually
# distinguishes one template from another (see _useful/format_templates_display
# below), so trimming it would flatten the grouped template list back into a
# list of near-identical boilerplate purposes.
_SUMMARY_KEYS = (
    "name",
    "category",
    "document_type",
    "when_to_use",
    "purpose",
    "total_fields",
    "template_group",
)


def summarise_templates(info: dict[str, Any]) -> dict[str, Any]:
    """A template payload small enough to hand to the model.

    `analyzed_details` carries all 37 trained columns for every template,
    including `field_mapping` and the raw `fields` list. Measured on 15 real
    templates that is 94,040 characters — about 23,500 tokens — of which those
    two fields are the bulk. The model had to read all of it before writing a
    word, it was streamed to the browser as a wall of JSON, and it stayed in the
    conversation to be re-sent on every later turn.

    None of it is needed to CHOOSE a template. `field_mapping` is loaded from
    the database directly at fill time, and a single template's fields are
    available on demand through `get_template_data(name)`.

    Called at the quick_info boundary only, and only AFTER
    format_templates_display has run — the human-facing list is built from the
    full records, so trimming what the model receives cannot change it.
    """
    details = info.get("analyzed_details")
    if not isinstance(details, list):
        return info

    return {
        **info,
        "analyzed_details": [
            {k: t.get(k) for k in _SUMMARY_KEYS if t.get(k) not in (None, "")}
            for t in details
            if isinstance(t, dict)
        ],
    }


# Text the training pipeline emits when the model had nothing specific to say.
# Printing it once per template filled the answer with noise and told a lawyer
# nothing, so it is suppressed rather than repeated.
_FILLER_TEXT = {
    "legal document template",
    "when this type of legal document is required for company compliance",
    "legal document",
    "",
}


def _clean_template_name(name: str) -> str:
    return name.replace(".docx", "").replace(".doc", "").replace("_", " ").strip()


def _useful(text: Any) -> str:
    """Return the text only when it actually distinguishes this template."""
    cleaned = " ".join(str(text or "").split())
    return "" if cleaned.lower() in _FILLER_TEXT else cleaned


def format_templates_display(templates_info: dict) -> str:
    """Group templates by what they are FOR, one scannable line each.

    A flat numbered dump of 15 items with a repeated boilerplate purpose and an
    internal field-count is unreadable and tells a lawyer nothing about which
    document to choose. Grouping by category and showing when each is used
    turns the same data into something you can pick from.
    """
    details = templates_info.get("analyzed_details", [])
    all_templates = templates_info.get("templates", [])

    if not details:
        names = sorted(_clean_template_name(t) for t in all_templates)
        body = "\n".join(f"- {n}" for n in names)
        return (
            f"**{len(names)} templates available**\n\n{body}\n\n"
            "None are trained yet, so I cannot say what each is for — "
            "run Train Agent in the admin panel."
        )

    groups: dict[str, list[tuple[str, str]]] = {}
    for t in details:
        category = _useful(t.get("category")) or "Other"
        name = _clean_template_name(t.get("name", "Unknown"))
        # `when_to_use` is the field that actually distinguishes one template
        # from another; `purpose` is boilerplate in practice.
        hint = _useful(t.get("when_to_use")) or _useful(t.get("purpose"))
        groups.setdefault(category, []).append((name, hint))

    lines = [f"**{len(details)} templates**", ""]
    for category in sorted(groups):
        entries = sorted(groups[category])
        lines.append(f"**{category}** ({len(entries)})")
        for name, hint in entries:
            lines.append(f"- {name}{f' — {hint[0].lower()}{hint[1:]}' if hint else ''}")
        lines.append("")

    lines.append(
        "Tell me the task and the company — for example "
        '"appoint a director for City Holdings" — and I will pick the right one '
        "and ask only for what I do not already hold."
    )
    return "\n".join(lines)


_MAX_LISTED_COMPANIES = 30


def _plural(count: int, noun: str) -> str:
    return f"{count} {noun}" if count == 1 else f"{count} {noun}s"


def _company_detail(record: dict) -> str:
    """The one muted line that lets a lawyer tell two entries apart.

    Zero counts are omitted rather than printed — "0 directors" reads like a
    defect in the record when it usually just means the extract is thin.
    """
    parts = []
    reg = str(record.get("registration_number") or "").strip()
    if reg:
        parts.append(reg)

    directors = record.get("director_count") or 0
    if directors:
        parts.append(_plural(directors, "director"))

    members = record.get("shareholder_count") or 0
    corporate = record.get("corporate_member_count") or 0
    individuals = max(members - corporate, 0)
    if individuals:
        # Only qualify as "individual" when both kinds are present, otherwise
        # the distinction is noise.
        noun = "individual shareholder" if corporate else "shareholder"
        parts.append(_plural(individuals, noun))
    if corporate:
        parts.append(_plural(corporate, "corporate member"))

    # Distinguish "the record is empty" from "we never loaded counts at all"
    # (the knowledge_lookup fallback knows names only).
    if not members and not directors and "director_count" in record:
        parts.append("no officers or members on record")

    if record.get("is_test_data"):
        parts.append("test data")

    return " · ".join(parts)


def format_companies_display(companies_info: dict) -> str:
    """One scannable line per company: name plus the facts that identify it.

    A bare numbered list of names is unpickable — several client companies
    share a name stem, and a fixture looked exactly like a real client.
    """
    records = companies_info.get("records", [])
    names = companies_info.get("companies", [])
    total = companies_info.get("total", len(records or names))

    if not total:
        return (
            "**No companies on the register**\n\n"
            "Add one from the admin panel — a DICA extract upload or the manual "
            "form — and I can generate documents for it."
        )

    # The knowledge_lookup fallback path only ever yields names, so degrade to
    # a plain list rather than printing empty detail lines.
    if not records:
        records = [{"name": n} for n in names]

    lines = [f"**Companies on the register** ({total})", ""]
    for record in records[:_MAX_LISTED_COMPANIES]:
        detail = _company_detail(record)
        lines.append(f"- **{record.get('name', 'Unknown')}**{f' — {detail}' if detail else ''}")

    if total > _MAX_LISTED_COMPANIES:
        lines.append("")
        lines.append(f"{total - _MAX_LISTED_COMPANIES} more are on file — ask for one by name.")

    lines.append("")
    lines.append(
        "Name the company and the document you need and I will draft it from "
        "the register, asking only for what is not already held."
    )
    return "\n".join(lines)


def get_documents_info() -> dict[str, Any]:
    """Get all documents info from database."""
    stats = get_document_stats()

    return {
        "total": stats.get("total_documents", 0),
        "documents": stats.get("recent_documents", [])[:10],
        "by_company": stats.get("by_company", {}),
        "by_template": stats.get("by_template", {}),
        "recent": stats.get("recent_documents", [])[:5],
    }


def get_companies_info_from_db() -> dict[str, Any]:
    """Get companies info from database - tries companies table first, then knowledge_lookup."""
    # Try companies table first
    companies = get_companies_info()

    if companies.get("total", 0) == 0:
        # Fallback: read from knowledge_lookup
        knowledge_companies = get_companies_from_knowledge_lookup()
        if knowledge_companies:
            return {
                "total": len(knowledge_companies),
                "companies": knowledge_companies[:50],
                "source": "knowledge_lookup",
            }

    return companies


def create_fast_info_tool(documents_dir: str = "/documents"):
    """Create the fast info tool for quick answers."""

    def quick_info(info_type: str = "all") -> dict[str, Any]:
        """
        Get quick info without deep searching.

        info_type can be: templates, documents, companies, all
        """
        templates = get_templates_info()
        docs = get_documents_info()
        companies = get_companies_info_from_db()

        # `display` is built from the FULL records, then the raw payload is
        # summarised for the model. Order matters: swapping these two lines
        # would silently strip the template descriptions out of the answer.
        if info_type == "templates":
            display = format_templates_display(templates)
            return {
                "templates": summarise_templates(templates),
                "display": display,
            }
        elif info_type == "companies":
            return {
                "companies": companies,
                "display": format_companies_display(companies),
            }
        elif info_type == "documents":
            return docs
        else:
            display_templates = format_templates_display(templates)
            return {
                "templates": summarise_templates(templates),
                "display_templates": display_templates,
                "companies": companies,
                "display_companies": format_companies_display(companies),
                "documents": docs,
            }

    return {"quick_info": quick_info}
