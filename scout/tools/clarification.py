"""
Clarification Helper Tools
==========================

Helps agent understand what templates and companies are available
for better clarifying questions.
"""

from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Turn-continuation instructions
# ---------------------------------------------------------------------------
# `agent_instruction` is addressed to the model and is never shown to the user
# (same contract as scout/tools/smart_doc.py). Two measured "silent stops" — a
# turn with zero content AND zero reasoning — happened immediately after these
# tools returned, so every branch below says what to do next in the SAME turn.
# Choices go through `ask_questions` as clickable options; the lettered
# a)/b)/c) prose menu is banned project-wide.
_COMPANY_RESOLVED = (
    "ACT NOW, IN THIS SAME TURN — ending your turn with no text is forbidden. "
    "The company is resolved; do not ask which company again. Name it in one sentence, "
    "then continue the user's request (find_matching_templates, then prepare_document)."
)



def list_available_templates(documents_dir: str = "/documents") -> dict[str, Any]:
    """
    List all available document templates.

    Returns:
        Dictionary with list of templates and their purposes
    """
    templates_dir = Path(documents_dir) / "legal" / "templates"

    if not templates_dir.exists():
        return {
            "available": False,
            "error": "Templates directory not found",
            "templates": [],
            "agent_instruction": (
                "ANSWER NOW, IN THIS SAME TURN — ending your turn with no text is forbidden. "
                "Tell the user no template library is available and an admin must upload templates "
                "under Admin → Registers → Templates."
            ),
        }

    templates = []
    for f in templates_dir.glob("*.docx"):
        name = f.stem
        templates.append(
            {
                "name": f.name,
                "display_name": name.replace("_", " ").title(),
                "path": str(f),
            }
        )

    return {
        "available": True,
        "templates": templates,
        "count": len(templates),
        "agent_instruction": (
            "ANSWER NOW, IN THIS SAME TURN — ending your turn with no text is forbidden. "
            "List these templates for the user by display_name. If they still have to choose one, "
            "offer them through ask_questions as clickable options, never as a lettered a)/b)/c) "
            "menu in prose."
        ),
    }


def find_matching_templates(search_term: str, documents_dir: str = "/documents", setup_only: bool = False) -> dict[str, Any]:
    """
    Find templates matching a search term (fuzzy match).
    Returns multiple matches if found, or exact/near match if only one.

    Handles:
    - "AGM" -> "Annual General Meeting Minutes.docx"
    - "director consent" -> matches multiple director consent templates
    - Exact file names

    Args:
        search_term: what to match on
        setup_only: when True, only consider templates tagged for new-company
            setup (director/shareholder consent forms). Pass True whenever the
            task is setting up a brand-new company, so unrelated templates
            (meeting minutes, resolutions for existing companies) are hidden.

    Returns:
        Dictionary with matched templates, count, and whether clarification needed
    """
    # Read templates from DB (single source of truth)
    try:
        from scout.tools.template_analyzer import get_all_templates_from_db, NEW_COMPANY_SETUP_GROUP
        db_templates = get_all_templates_from_db()
        if setup_only:
            db_templates = [t for t in db_templates if (t.get("template_group") or "") == NEW_COMPANY_SETUP_GROUP]
        all_template_names = [t["name"] for t in db_templates]
    except Exception as e:
        import logging
        logging.getLogger("legalscout").warning(f"Template DB read failed: {e}")
        all_template_names = []

    if not all_template_names:
        return {
            "found": False,
            "matches": [],
            "clarification_needed": False,
            "error": "No templates in database. Upload templates from the Dashboard first.",
            # Told to the model, not shown to the user. This tool result is the
            # last thing read before the turn ends, and an empty turn here was
            # a measured silent stop.
            "agent_instruction": (
                "ANSWER NOW, IN THIS SAME TURN — ending your turn with no text is forbidden. "
                "Tell the user no templates are loaded yet and that an admin must upload them "
                "under Admin → Registers → Templates. Do not retry this tool."
            ),
        }

    search_lower = search_term.lower().strip()
    search_normalized = search_lower.replace(" ", "_")

    matches = []

    for template_name in all_template_names:
        name_lower = template_name.replace(".docx", "").lower()
        name_normalized = name_lower.replace("_", " ")

        if (
            search_lower in name_lower
            or search_normalized in name_normalized
            or name_lower in search_lower
            or any(word in name_lower for word in search_lower.split() if len(word) > 2)
        ):
            stem = template_name.replace(".docx", "")
            matches.append(
                {
                    "name": template_name,
                    "display_name": stem.replace("_", " ").title(),
                    "path": f"/documents/legal/templates/{template_name}",
                    "match_score": _calculate_match_score(search_lower, name_lower),
                }
            )

    matches.sort(key=lambda x: x["match_score"], reverse=True)

    if len(matches) == 0:
        return {
            "found": False,
            "matches": [],
            "clarification_needed": True,
            "suggestion": f"No templates found matching '{search_term}'. Available: "
            + ", ".join([n.replace(".docx", "").replace("_", " ").title() for n in all_template_names[:10]]),
            "agent_instruction": (
                f"ANSWER NOW, IN THIS SAME TURN — ending your turn with no text is forbidden. "
                f"Nothing matched '{search_term}'. Say that plainly, then name the closest templates "
                "from `suggestion` (or call list_templates() for the full set) and ask which one they "
                "want using ask_questions with those names as clickable options. Never write a "
                "lettered a)/b)/c) menu in prose."
            ),
        }
    elif len(matches) == 1:
        return {
            "found": True,
            "matches": matches,
            "clarification_needed": False,
            "selected_template": matches[0]["name"],
            "agent_instruction": (
                f"ACT NOW, IN THIS SAME TURN — ending your turn with no text is forbidden. "
                f"Exactly one template matched: '{matches[0]['display_name']}'. Do not ask which "
                "template. Say in one sentence which template you are using and why it fits the "
                "request, then call prepare_document(template_name, company_name) immediately with "
                f"template_name=\"{matches[0]['name']}\" (call check_company first if you do not "
                "have the company yet)."
            ),
        }
    else:
        # Use letter format for button-friendly selection (a, b, c, d, e)
        letters = ['a', 'b', 'c', 'd', 'e']
        options_text = []
        for i, m in enumerate(matches[:5]):
            options_text.append(f"{letters[i]}) {m['display_name']}")

        # Format message with options for button display
        message_lines = [f"Found {len(matches)} templates matching '{search_term}'. Which one?", ""]
        message_lines.extend(options_text)
        message_lines.append("")
        message_lines.append("What would you like to do?")

        top_names = [m["display_name"] for m in matches[:5]]

        return {
            "found": True,
            "matches": matches,
            "clarification_needed": True,
            "message": "\n".join(message_lines),
            "options": options_text,
            # `message`/`options` above are the legacy lettered grammar, kept only
            # because older sessions and callers read them. The model must not
            # relay them — the choice goes through ask_questions.
            "agent_instruction": (
                f"ASK NOW, IN THIS SAME TURN — ending your turn with no text is forbidden. "
                f"{len(matches)} templates matched. Call ask_questions with ONE question — "
                "\"Which template do you need?\" — and these options: "
                + "; ".join(top_names)
                + ". Ignore the `message` and `options` fields in this result: they are a legacy "
                "lettered a)/b)/c) menu and must never be written into your reply. After the user "
                "picks, call prepare_document with the chosen template."
            ),
        }


def _calculate_match_score(search: str, template_name: str) -> int:
    """Calculate how well a template matches the search term."""
    score = 0

    if search == template_name:
        return 100

    if template_name.startswith(search):
        score += 50

    if search in template_name:
        score += 30

    for word in search.split():
        if word in template_name and len(word) > 2:
            score += 10

    if template_name.startswith(search.split()[0] if search.split() else ""):
        score += 20

    return score


def list_available_companies(documents_dir: str = "/documents") -> dict[str, Any]:
    """
    List all companies from the companies DB table.

    Returns:
        Dictionary with list of companies and their details
    """
    try:
        from scout.tools.companies_db import get_all_companies
        db_companies = get_all_companies(limit=200)
        if db_companies:
            companies = []
            for c in db_companies:
                companies.append({
                    "company_name": c.get("name", ""),
                    "company_registration_number": c.get("registration_number", ""),
                    "registered_office": c.get("address", ""),
                    "directors": c.get("directors", ""),
                })
            return {
                "available": True,
                "companies": companies,
                "total": len(companies),
                "agent_instruction": (
                    "ANSWER NOW, IN THIS SAME TURN — ending your turn with no text is forbidden. "
                    "Show the user the company names. If they still have to choose one, offer them "
                    "through ask_questions as clickable options, never as a lettered a)/b)/c) menu "
                    "in prose."
                ),
            }
    except Exception as e:
        print(f"DB company lookup failed: {e}")

    return {
        "available": False,
        "error": "No companies found in database. Add companies from the admin panel.",
        "companies": [],
        "agent_instruction": (
            "ANSWER NOW, IN THIS SAME TURN — ending your turn with no text is forbidden. "
            "Tell the user no companies are registered yet and that an admin adds them under "
            "Admin → Registers → Companies (DICA PDF upload or manual entry)."
        ),
    }


def find_company_suggestions(partial_name: str, documents_dir: str = "/documents") -> dict[str, Any]:
    """
    Find companies that match a partial name (for clarification).

    Args:
        partial_name: Partial company name to search for

    Returns:
        Dictionary with matching company suggestions
    """
    data = list_available_companies(documents_dir)

    if not data.get("available"):
        return data

    partial_lower = partial_name.lower().strip()

    matches = []
    for company in data["companies"]:
        company_name = str(company.get("company_name", "")).lower()
        if partial_lower in company_name or company_name in partial_lower:
            matches.append(company)

    # Format with buttons if 2-5 matches
    if 2 <= len(matches) <= 5:
        letters = ['a', 'b', 'c', 'd', 'e']
        options_text = []
        message_lines = [f"Found {len(matches)} companies matching '{partial_name}'. Which one?", ""]

        for i, company in enumerate(matches[:5]):
            comp_name = company.get("company_name", "Unknown")
            options_text.append(f"{letters[i]}) {comp_name}")
            message_lines.append(f"{letters[i]}) {comp_name}")

        message_lines.append("")
        message_lines.append("What would you like to do?")

        return {
            "search_term": partial_name,
            "matches": matches,
            "count": len(matches),
            "suggestion": "\n".join(message_lines),
            "options": options_text,
            "show_buttons": True,
        }

    return {
        "search_term": partial_name,
        "matches": matches,
        "count": len(matches),
        "suggestion": f"Found {len(matches)} company(ies)" if matches else "No matches found",
    }


def create_clarification_tool(documents_dir: str = "/documents"):
    """Create the clarification helper tool for the agent."""

    def get_clarification_info() -> dict[str, Any]:
        """
        Get information to help clarify user requests.

        Returns:
            Available templates and companies for clarification
        """
        templates = list_available_templates(documents_dir)
        companies = list_available_companies(documents_dir)

        return {
            "templates": templates.get("templates", []),
            "companies": companies.get("companies", []),
            "message": "Use this information to ask clarifying questions when needed.",
            "agent_instruction": (
                "ACT NOW, IN THIS SAME TURN — ending your turn with no text is forbidden. "
                "Use these lists to resolve the request yourself if you can; otherwise ask the one "
                "question you still need via ask_questions, with the template or company names as "
                "clickable options. Never write a lettered a)/b)/c) menu in prose."
            ),
        }

    def check_company(company_name: str) -> dict[str, Any]:
        """
        Check if a company exists and get details.

        Args:
            company_name: Name of the company to check (can be number like "1", "2", or "first", "second")

        Returns:
            Company details or suggestions for clarification
        """
        # Handle number selection (e.g., "1", "2", "3")
        if company_name.strip().isdigit():
            company_num = int(company_name.strip())
            all_companies = list_available_companies(documents_dir)
            companies = all_companies.get("companies", [])
            if 0 < company_num <= len(companies):
                company = companies[company_num - 1]
                return {
                    "found": True,
                    "company": company.get("company_name"),
                    "registration_no": company.get("registration_number"),
                    "data": company,
                    "agent_instruction": _COMPANY_RESOLVED,
                }
            return {
                "found": False,
                "error": f"Invalid selection. Please choose 1-{len(companies)}",
                "available_companies": [c.get("company_name") for c in companies[:20]],  # Show more companies
                "total_count": len(companies),
                "agent_instruction": (
                    "ASK NOW, IN THIS SAME TURN — ending your turn with no text is forbidden. "
                    "That position does not exist. Re-offer the companies in `available_companies` "
                    "through ask_questions as clickable options, never as a lettered a)/b)/c) menu "
                    "in prose."
                ),
            }

        # Handle "first", "second", etc.
        selection_map = {"first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5}
        if company_name.lower().strip() in selection_map:
            company_num = selection_map[company_name.lower().strip()]
            all_companies = list_available_companies(documents_dir)
            companies = all_companies.get("companies", [])
            if 0 < company_num <= len(companies):
                company = companies[company_num - 1]
                return {
                    "found": True,
                    "company": company.get("company_name"),
                    "registration_no": company.get("registration_number"),
                    "data": company,
                    "agent_instruction": _COMPANY_RESOLVED,
                }

        suggestions = find_company_suggestions(company_name, documents_dir)

        if suggestions["count"] == 0:
            all_companies = list_available_companies(documents_dir)
            return {
                "found": False,
                "message": f"Company '{company_name}' not found",
                "suggestions": "Did you mean one of these? "
                + ", ".join([c.get("company_name", "") for c in all_companies.get("companies", [])[:5]]),
                "agent_instruction": (
                    f"ANSWER NOW, IN THIS SAME TURN — ending your turn with no text is forbidden. "
                    f"No company matches '{company_name}'. Say so plainly, then offer the names in "
                    "`suggestions` (or call list_companies() for the full register) through "
                    "ask_questions as clickable options. Never write a lettered a)/b)/c) menu in "
                    "prose, and never invent a company."
                ),
            }
        elif suggestions["count"] == 1:
            return {
                "found": True,
                "company": suggestions["matches"][0],
                "agent_instruction": _COMPANY_RESOLVED,
            }
        else:
            # Format with buttons if 2-5 matches
            if 2 <= suggestions["count"] <= 5:
                letters = ['a', 'b', 'c', 'd', 'e']
                options_text = []
                message_lines = [f"Found {suggestions['count']} companies matching '{company_name}'. Which one?", ""]

                for i, company in enumerate(suggestions["matches"][:5]):
                    comp_name = company.get("company_name", "Unknown")
                    options_text.append(f"{letters[i]}) {comp_name}")
                    message_lines.append(f"{letters[i]}) {comp_name}")

                message_lines.append("")
                message_lines.append("What would you like to do?")

                return {
                    "found": False,
                    "multiple_matches": True,
                    "message": "\n".join(message_lines),
                    "matches": suggestions["matches"],
                    "options": options_text,
                    "show_buttons": True,
                    # `message`/`options` are the legacy lettered grammar, kept for
                    # older callers. The model must not relay them.
                    "agent_instruction": (
                        f"ASK NOW, IN THIS SAME TURN — ending your turn with no text is forbidden. "
                        f"{suggestions['count']} companies matched. Call ask_questions with ONE "
                        "question — \"Which company do you mean?\" — and these options: "
                        + "; ".join(
                            str(c.get("company_name", "Unknown"))
                            for c in suggestions["matches"][:5]
                        )
                        + ". Ignore the `message` and `options` fields here: they are a legacy "
                        "lettered a)/b)/c) menu and must never appear in your reply."
                    ),
                }

            return {
                "found": False,
                "multiple_matches": True,
                "message": f"Found {suggestions['count']} companies matching '{company_name}'",
                "matches": suggestions["matches"],
                "suggestion": "Please clarify which company you mean: "
                + ", ".join([c.get("company_name", "") for c in suggestions["matches"]]),
                "agent_instruction": (
                    f"ASK NOW, IN THIS SAME TURN — ending your turn with no text is forbidden. "
                    f"{suggestions['count']} companies matched — too many to list. Ask the user to "
                    "narrow the name, or call ask_questions with the closest few company names as "
                    "clickable options. Never write a lettered a)/b)/c) menu in prose."
                ),
            }

    def list_new_company_setup_templates() -> dict[str, Any]:
        """
        List ONLY the templates used to set up a brand-new company
        (director/shareholder consent forms). Call this when the user is
        setting up a new company, so you offer just the setup documents
        instead of every template in the system.
        """
        try:
            from scout.tools.template_analyzer import get_templates_by_group, NEW_COMPANY_SETUP_GROUP
            group = get_templates_by_group(NEW_COMPANY_SETUP_GROUP)
        except Exception as e:
            import logging
            logging.getLogger("legalscout").warning(f"Setup-template read failed: {e}")
            group = []
        templates = [
            {
                "name": t["name"],
                "display_name": t["name"].replace(".docx", "").replace("_", " ").title(),
                "path": f"/documents/legal/templates/{t['name']}",
            }
            for t in group
        ]
        return {
            "available": bool(templates),
            "templates": templates,
            "count": len(templates),
            "message": (
                "These are the new-company setup templates. Offer these to the user via a picker card."
                if templates
                else "No templates are tagged for new-company setup yet."
            ),
            "agent_instruction": (
                (
                    "ASK NOW, IN THIS SAME TURN — ending your turn with no text is forbidden. "
                    "Call ask_questions with ONE question — \"Which setup document do you need?\" — "
                    "and these options: "
                    + "; ".join(t["display_name"] for t in templates[:5])
                    + ". Never write a lettered a)/b)/c) menu in prose. After the user picks, call "
                    "prepare_document with the chosen template."
                )
                if templates
                else (
                    "ANSWER NOW, IN THIS SAME TURN — ending your turn with no text is forbidden. "
                    "Tell the user no setup templates are tagged yet and that an admin tags them "
                    "with the Setup toggle under Admin → Registers → Templates. Offer to call "
                    "list_templates() instead."
                )
            ),
        }

    return {
        "get_clarification_info": get_clarification_info,
        "check_company": check_company,
        "list_templates": lambda: list_available_templates(documents_dir),
        "list_companies": lambda: list_available_companies(documents_dir),
        "find_matching_templates": find_matching_templates,
        "list_new_company_setup_templates": list_new_company_setup_templates,
    }
