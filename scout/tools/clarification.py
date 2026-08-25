"""
Clarification Helper Tools
==========================

Helps agent understand what templates and companies are available
for better clarifying questions.
"""

from __future__ import annotations

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


# ---------------------------------------------------------------------------
# Word-level matching
# ---------------------------------------------------------------------------
# The match predicate below admits a template when ANY word of the search
# appears in its name. Measured against the 15-template register, the bare
# `len(word) > 2` rule let "and", "for", "new" and "non" act as evidence:
# searching "Director and Shareholder Consent Form" matched 13 of 15 templates,
# because "and" is a substring of "Resignation and Appointment". Structural
# words carry no information about which document is wanted, so they are not
# evidence.
_STOPWORDS = frozenset({
    "and", "for", "the", "of", "to", "in", "on", "at", "by", "with", "from",
    "new", "non", "its", "use", "using", "only", "please", "prepare", "create",
    "make", "need", "want", "a", "an", "is", "are", "this", "that",
})


def _significant_words(search: str) -> list[str]:
    """The words of a search that actually say which document is wanted."""
    return [w for w in search.lower().split() if len(w) > 2 and w not in _STOPWORDS]


# ---------------------------------------------------------------------------
# Template -> skill routing
# ---------------------------------------------------------------------------
# MEASURED (2026-08-25, scout:1.2.37, 3 runs per prompt):
#
#     "what documents are required to set up a company?"   load_skill 3/3
#     "prepare resignation letter of ... from City Holdings" load_skill 3/3
#     "director consent form ... to appoint in a new company" load_skill 1/3
#     "appoint Win Win Tint both as a shareholder and director" load_skill 0/3
#
# All 15 templates are already named in a skill body, and `new-company-setup`
# carries the exact answer the last prompt needed — the full consent set and who
# signs each. It never loaded. Skills are PULL: agent.py tells the model to call
# load_skill when a request matches a description, and on that request the model
# decided not to, three times out of three. It went to find_matching_templates
# and offered near neighbours chosen off filenames instead.
#
# Writing more skills does not fix that; it adds more things that may not load.
# So the playbook rides along with the match — the model cannot skip a payload it
# is already holding, and there is no second call to forget.
#
# Flag-gated: LEGAL_SCOUT_SKILL_ROUTING, default OFF, so this can be measured
# against the current behaviour rather than assumed better.

SKILL_ROUTING_ENV = "LEGAL_SCOUT_SKILL_ROUTING"
_FLAG_TRUE = frozenset({"1", "true", "yes", "on"})


def skill_routing_enabled() -> bool:
    import os
    return str(os.getenv(SKILL_ROUTING_ENV, "")).strip().lower() in _FLAG_TRUE


# Ordered, most specific first — "resignation and appointment" must not be
# claimed by the plain "appointment" rule. A template that matches nothing routes
# to no skill rather than to a plausible wrong one: an unrelated playbook is
# worse than none, because the model follows it.
_SKILL_RULES = (
    ("new_company_setup_group", "new-company-setup"),
    ("resignation and", "director-resignation"),
    ("resignation", "director-resignation"),
    ("annual general meeting", "agm-meeting-chain"),
    ("appointment", "director-appointment"),
)


def skill_for_template(name: str, template_group: str | None = None) -> str | None:
    """Which playbook governs this template, or None when nothing does."""
    if (template_group or "") == "new_company_setup":
        return "new-company-setup"
    low = str(name or "").lower()
    for key, skill in _SKILL_RULES:
        if key == "new_company_setup_group":
            continue
        if key in low:
            return skill
    return None


def _load_skill_body(skill_name: str) -> str:
    """The playbook body, or "" when it is missing or disabled.

    Never raises: a routing lookup that fails must degrade to today's behaviour,
    not take down template matching.
    """
    try:
        from db.connection import get_db_conn
        conn = get_db_conn()
        try:
            cur = conn.cursor()
            cur.execute(
                "SELECT body FROM legal_skills WHERE name = %s AND enabled = TRUE",
                (skill_name,),
            )
            row = cur.fetchone()
            cur.close()
            return (row[0] or "") if row else ""
        finally:
            conn.close()
    except Exception as e:
        import logging
        logging.getLogger("legalscout").warning(f"skill routing lookup failed: {e}")
        return ""


def attach_playbook(result: dict, template_name: str, template_group: str | None = None) -> dict:
    """Ride the governing playbook along with a template match.

    No-op when the flag is off, when no skill governs the template, or when the
    body cannot be read — in every one of those cases the result is exactly what
    it was before.
    """
    if not skill_routing_enabled():
        return result
    skill = skill_for_template(template_name, template_group)
    if not skill:
        return result
    body = _load_skill_body(skill)
    if not body:
        return result
    result["skill"] = skill
    result["playbook"] = body
    result["agent_instruction"] = (
        f"FOLLOW THE PLAYBOOK IN `playbook` NOW — it is the firm's own procedure for "
        f"'{skill}' and it governs this document. Do not call load_skill; you are "
        "already holding the body. It names the exact templates, who signs each, and "
        "the order they are signed in. Where it conflicts with your own legal "
        "knowledge, the playbook wins.\n\n"
    ) + str(result.get("agent_instruction") or "")
    return result


def _coverage(search: str, template_name: str) -> float:
    """Fraction of the search's significant words present in a template name.

    1.0 means the template name accounts for everything the user named. Less
    than that means the user asked for something the name does not cover — a
    request for a "Director and Shareholder Consent Form" scores 2/3 against
    every template in a register that holds director consents and shareholder
    consents but no combined form.
    """
    words = _significant_words(search)
    if not words:
        return 1.0
    name = template_name.lower()
    return sum(1 for w in words if w in name) / len(words)



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
        group_of = {t["name"]: (t.get("template_group") or "") for t in db_templates}
    except Exception as e:
        import logging
        logging.getLogger("legalscout").warning(f"Template DB read failed: {e}")
        all_template_names = []
        group_of = {}

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
            or any(word in name_lower for word in _significant_words(search_lower))
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

    # Does ANY match account for everything the user named?
    #
    # `len(matches) == 0` is the only branch below that reports absence, and it
    # is unreachable for any request phrased in this domain's vocabulary — one
    # shared word like "consent" admits four templates. So a document that does
    # not exist comes back as a picker of near neighbours, and the user takes
    # one for the thing they asked for. Measured: "Director and Shareholder
    # Consent Form" (a combined form the register does not hold) offered the
    # two director consents and the individual shareholder consent, with no
    # word said about the gap. Coverage is what separates the two cases —
    # "Share Transfer Agreement" and this request are both absent, but only one
    # of them shares vocabulary with what IS on the shelf.
    _by_cov = sorted(matches, key=lambda m: _coverage(search_lower, m["name"]), reverse=True)
    best_coverage = _coverage(search_lower, _by_cov[0]["name"]) if _by_cov else 0.0
    partial_only = bool(matches) and best_coverage < 1.0
    unmatched_words = []
    if partial_only:
        # Relative to the BEST single template, not to the union of all of them.
        # The union always covers everything — that is the whole point: the
        # register holds "director consent" and "shareholder consent" as two
        # separate documents, so every word of "director and shareholder
        # consent form" appears somewhere while no one file holds them together.
        best_name = _by_cov[0]["name"].lower()
        unmatched_words = [w for w in _significant_words(search_lower) if w not in best_name]

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
    elif len(matches) == 1 and partial_only:
        # One near neighbour is the most dangerous shape of all: the branch
        # below tells the model to stop asking and generate.
        return {
            "found": False,
            "partial_match": True,
            "matches": _slim(matches),
            "clarification_needed": True,
            "coverage": round(best_coverage, 2),
            "unmatched_words": unmatched_words,
            "agent_instruction": (
                "ANSWER IN THIS SAME TURN — ending your turn with no text is forbidden. "
                f"'{matches[0]['display_name']}' is the closest name in the register, but it "
                "does not cover the whole request"
                + (
                    " — nothing on the shelf accounts for "
                    + ", ".join(f'"{w}"' for w in unmatched_words)
                    if unmatched_words else ""
                )
                + ". Say plainly that the exact document asked for is not available, then ask "
                "with ask_questions whether they want that nearest template instead. Do NOT call "
                "prepare_document until they say yes."
            ),
        }
    elif len(matches) == 1:
        return attach_playbook({
            "found": True,
            "matches": _slim(matches),
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
        }, matches[0]["name"], group_of.get(matches[0]["name"]))
    else:
        # A dominant match is not a choice.
        #
        # Measured: searching "Corporate Shareholder Consent - Directors
        # Resolution" returns 12 matches — the loose word-overlap predicate above
        # lets any template sharing one word of three letters through — and the
        # correct one scores 150 against a runner-up of 20. Handing the model
        # twelve options and telling it to ask produced, on a measured run, a
        # fully-formed set of ANNUAL GENERAL MEETING MINUTES for a request that
        # named a shareholder consent. Asking a question the evidence already
        # answers is how the wrong document gets written.
        #
        # So when the top score both clears an absolute floor AND doubles the
        # runner-up, treat it as decided. A genuine ambiguity — "Director Consent
        # Form" matching the Group and Non-Group variants, which score alike —
        # does not clear the ratio and still goes to the user.
        top, runner_up = matches[0], matches[1]
        DOMINANT_FLOOR = 50          # at least a prefix or full-substring hit
        DOMINANT_RATIO = 2.0
        # A partial match is never dominant. Scoring highest among near
        # neighbours says nothing when none of them is the requested document.
        if not partial_only and top["match_score"] >= DOMINANT_FLOOR and (
            runner_up["match_score"] <= 0
            or top["match_score"] >= runner_up["match_score"] * DOMINANT_RATIO
        ):
            return attach_playbook({
                "found": True,
                "matches": _slim(matches),
                "clarification_needed": False,
                "selected_template": top["name"],
                "dominant_match": {
                    "score": top["match_score"],
                    "runner_up_score": runner_up["match_score"],
                },
                "agent_instruction": (
                    f"ACT NOW, IN THIS SAME TURN — ending your turn with no text is forbidden. "
                    f"'{top['display_name']}' matches the request far better than anything else "
                    f"(score {top['match_score']} against {runner_up['match_score']}). Do NOT ask "
                    "which template and do NOT choose a different one. Say in one sentence which "
                    "template you are using, then call prepare_document immediately with "
                    f"template_name=\"{top['name']}\"."
                ),
            }, top["name"], group_of.get(top["name"]))

        top_names = [m["display_name"] for m in matches[:5]]

        # Which playbook governs the shortlist.
        #
        # First cut required unanimity across every match. Measured, that almost
        # never held — the loose predicate drags in a Resignation Letter on the
        # word "director" — so a plain "director consent form" request attached
        # nothing 2 runs in 3 even though its leading candidates were all setup
        # consents. Unanimity across a shortlist this noisy is the wrong bar.
        #
        # So: the majority skill of the SHOWN options (the five the user is
        # actually offered), falling back to the leader's. The tail of the match
        # list does not get a vote — it is not on the card. A shortlist with no
        # majority and a leader governed by nothing attaches nothing.
        _shown = matches[:5]
        _votes = {}
        for _m in _shown:
            _sk = skill_for_template(_m["name"], group_of.get(_m["name"]))
            if _sk:
                _votes[_sk] = _votes.get(_sk, 0) + 1
        _shared_skill = None
        if _votes:
            _best = max(_votes.values())
            _top_skills = [k for k, v in _votes.items() if v == _best]
            if len(_top_skills) == 1:
                _shared_skill = _top_skills[0]
            else:
                _shared_skill = skill_for_template(
                    matches[0]["name"], group_of.get(matches[0]["name"])
                )
        _lead = matches[0]["name"] if _shared_skill else None
        # The leader may be governed by a different skill than the majority; the
        # attach call reads the name, so hand it a template the majority governs.
        if _shared_skill:
            for _m in _shown:
                if skill_for_template(_m["name"], group_of.get(_m["name"])) == _shared_skill:
                    _lead = _m["name"]
                    break

        if partial_only:
            missing = ", ".join(f'"{w}"' for w in unmatched_words) or "part of what you asked for"
            gap_instruction = (
                "ANSWER AND ASK IN THIS SAME TURN — ending your turn with no text is forbidden. "
                "NO TEMPLATE IN THE REGISTER MATCHES THE WHOLE REQUEST. The nearest names cover "
                f"only part of it; nothing on the shelf accounts for {missing}. Say that FIRST, "
                "in plain words — that the exact document asked for is not available — and only "
                "then offer the nearest ones. Do NOT present a near neighbour as if it were the "
                "requested document, and do NOT quietly proceed with one: the user takes the "
                "option you offer for the thing they named, and the wrong document gets written. "
                "After saying it, call ask_questions with ONE question — \"We don't have that "
                "exact template. Would you like one of these instead?\" — and these options: "
                + "; ".join(top_names)
                + ". If the user needs the exact document, tell them an admin can upload it under "
                "Admin → Registers → Templates. Never write a lettered a)/b)/c) menu in prose."
            )
            out = {
                "found": False,
                "partial_match": True,
                "matches": _slim(matches),
                "clarification_needed": True,
                "coverage": round(best_coverage, 2),
                "unmatched_words": unmatched_words,
                "agent_instruction": gap_instruction,
            }
            return attach_playbook(out, _lead, group_of.get(_lead)) if _lead else out

        out = {
            "found": True,
            "matches": _slim(matches),
            "clarification_needed": True,
            # The legacy lettered `message`/`options` fields are GONE. They were
            # 705 characters per call of a menu the instruction below explicitly
            # forbids relaying, and nothing reads them: not the chat UI
            # (toolDisplay.ts:461 reads name/display_name/selected_template/
            # error/suggestion/clarification_needed) and not the model, which is
            # told to ignore them. Stored results from older sessions keep their
            # copy; only new results are slimmer.
            "agent_instruction": (
                f"ASK NOW, IN THIS SAME TURN — ending your turn with no text is forbidden. "
                "The card is NOT your text. Write one sentence of reply BEFORE you call "
                "ask_questions, and check the options below against the document the user "
                "actually named first: if none of them IS that document, that sentence must say "
                "so plainly — \"we don't have a combined X and Y form\" — and add that an admin "
                "can upload it under Admin → Registers → Templates. A picker that silently offers "
                "near neighbours is how the user takes one for the thing they asked for. "
                f"{len(matches)} templates matched. Then call ask_questions with ONE question — "
                "\"Which template do you need?\" — and these options: "
                + "; ".join(top_names)
                + ". Ignore the `message` and `options` fields in this result: they are a legacy "
                "lettered a)/b)/c) menu and must never be written into your reply. After the user "
                "picks, call prepare_document with the chosen template."
            ),
        }
        return attach_playbook(out, _lead, group_of.get(_lead)) if _lead else out


def _slim(matches: list[dict]) -> list[dict]:
    """The fields a caller actually reads, and nothing else.

    MEASURED (2026-08-25, one live turn): this tool returned 9,160 characters,
    of which `matches` was 3,015 — a full filesystem path and an internal match
    score for each of 13 candidates. The model addresses templates by NAME
    (`prepare_document(template_name=...)`) and has no use for either. The chat
    UI reads only `name`, `display_name`, `selected_template`, `error`,
    `suggestion` and `clarification_needed`
    (agent-ui/.../toolDisplay.ts:461). The score still drives ranking and the
    dominant-match test; it just stops riding along in the payload.
    """
    return [{"name": m["name"], "display_name": m["display_name"]} for m in matches]


def _calculate_match_score(search: str, template_name: str) -> int:
    """Calculate how well a template matches the search term."""
    score = 0

    if search == template_name:
        return 100

    if template_name.startswith(search):
        score += 50

    if search in template_name:
        score += 30

    for word in _significant_words(search):
        if word in template_name:
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
                    "If the user asked WHICH documents are needed (an informational question, no "
                    "single document requested yet), answer in prose listing every template below, "
                    "then offer to prepare one. Otherwise call ask_questions with ONE question — "
                    "\"Which setup document do you need?\" — and these options: "
                    + "; ".join(t["display_name"] for t in templates[:5])
                    + ". Never write a lettered a)/b)/c) menu in prose. After the user picks, call "
                    "prepare_document with the chosen template. "
                    "NAME RULE: whenever you name a template — in a picker, in prose, anywhere — "
                    "reproduce it character for character from this list, including word order and "
                    "hyphens: "
                    + "; ".join(t["name"] for t in templates)
                    + ". Never paraphrase, reorder or shorten a template name; the user copies the "
                    "name back to you and a reworded one will not resolve."
                )
                if templates
                else (
                    "ANSWER NOW, IN THIS SAME TURN — ending your turn with no text is forbidden. "
                    "No template is tagged for new-company setup, so you have NO list to answer "
                    "from. Do NOT name templates from your own legal knowledge — every name you "
                    "write must have come back from a tool in this conversation, or the user will "
                    "ask for a document that does not exist. Call list_templates() now and answer "
                    "from what it returns, and mention that an admin can tag the setup ones with "
                    "the Setup toggle under Admin → Registers → Templates."
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
