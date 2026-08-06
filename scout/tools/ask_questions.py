"""
Interactive Structured Questions (ask_questions)
===========================================

A universal in-chat human-in-the-loop question tool, built on Agno's native
pause/resume — the same mechanism the person pickers use.

`ask_questions` is a `@tool(requires_user_input=True, user_input_fields=["answers"])`
function. Agno pauses the run before executing it and emits a RunPausedEvent
carrying the tool's arguments, so the question payload travels to the frontend
inside `ToolExecution.tool_args["questions_json"]`. The frontend renders an
interactive question card, the user answers, then resumes the SAME run via
`POST /agents/{agent_id}/runs/{run_id}/continue` — which writes the user's
answers back into `tool_args["answers"]`.

This tool replaces the old prose a)/b)/c) "button" grammar for EVERY non-person
decision: template choices, yes/no approvals, and missing-field prompts. Person
selection stays with the dedicated pickers in people_picker.py.
"""

import json
import re
from typing import Any, Dict, List, Optional, Tuple

from agno.tools import tool

# Documented for the model in the docstring; also enforced in validation.
EXPECTED_SCHEMA = {
    "questions": [
        {
            "id": "string — stable key you will read the answer back by",
            "text": "string — the question shown to the user",
            "options": ["optional list of choices rendered as chips"],
            "multi_select": "optional bool — allow picking more than one option",
            "allow_other": "optional bool — offer a free-text 'Other…' entry",
        }
    ]
}


def _validate_questions(questions: Any) -> List[str]:
    """Return a list of human-readable problems; empty list means valid."""
    problems: List[str] = []
    if not isinstance(questions, list):
        return ["questions_json must be a JSON array of question objects"]
    if not (1 <= len(questions) <= 4):
        problems.append("provide between 1 and 4 questions")
    for i, q in enumerate(questions):
        if not isinstance(q, dict):
            problems.append(f"question {i} must be an object")
            continue
        if not str(q.get("id") or "").strip():
            problems.append(f"question {i} is missing a non-empty 'id'")
        if not str(q.get("text") or "").strip():
            problems.append(f"question {i} is missing a non-empty 'text'")
        opts = q.get("options")
        if opts is not None and not isinstance(opts, list):
            problems.append(f"question {i}: 'options' must be a list when present")
    return problems


# ---------------------------------------------------------------------------
# Person-shaped question guard
# ---------------------------------------------------------------------------
# A person is ALWAYS chosen from the People register through a picker card, and
# never typed. A typed name lets in someone who exists in no register, and it
# splits the name from the NRC / nationality / address that must travel with it.
#
# The system prompt says this, but prose alone does not hold. The same request
# ("shareholders meeting minutes for director appointment") produced a picker on
# one run and, on the very next, free-text `ask_questions` asking for the new
# director's full legal name and NRC. This guard is the enforcement.
#
# TIMING — agno pauses the run BEFORE executing a `requires_user_input=True`
# tool (models/base.py filters it out of the first execution pass; the entrypoint
# runs only on resume, agent/_tools.py case 4). So this body cannot stop the card
# from being drawn. What it does is refuse to hand a typed person value back to
# the model, and name the picker to call instead — so the wrong value never
# reaches a document and the model recovers inside the same turn. Preventing the
# card outright is the prompt rule's job, not this function's.

# U+00A0 and friends really do occur in this product's text (see
# placeholders.py) — spelled as escapes so they stay visible in source.
_WS_RE = re.compile("[\\s\u00a0\u2007\u202f]+")

# Role words that name a HUMAN party on a Myanmar corporate document.
# Deliberately EXCLUDED because they routinely name an entity in DICA filings:
# "member" (corporate members are companies), "nominee", "officer", "party",
# "holder", "auditor" (may be a firm).
# The boundaries are (?<![a-z]) / (?![a-z]) rather than \b so that a question
# phrased with a raw placeholder key — "individual shareholder_1_name" — still
# matches; `_` is a word character, so \b would not fire there.
_ROLE_RE = re.compile(
    r"(?<![a-z])("
    r"directors?"
    r"|share\s?holders?"
    r"|signator(?:y|ies)|signers?"
    r"|chair(?:person|persons|man|men|woman|women)?"
    r"|appointees?"
    r"|representatives?"
    r"|attendees?"
    r"|secretar(?:y|ies)"
    r"|witness(?:es)?"
    r")(?![a-z])"
)

# "corporate shareholder", "group member" — the party is a COMPANY, so asking
# for its name is not a person question. `director` is deliberately NOT here:
# DICA directors are natural persons, and "the company director" is the ordinary
# way to say a human director of that company.
_ENTITY_ROLE_RE = re.compile(
    r"\b(?:corporate|company|companies|body\s+corporate|institutional|group|holding)\s+"
    r"(?:share\s?holders?|members?|entit(?:y|ies))(?![a-z])"
)

# Same underscore-tolerant boundaries as _ROLE_RE — "director_name" is a real
# thing the model asks for.
_NAME_RE = re.compile(r"(?<![a-z])(?:full[\s_]+)?(?:legal[\s_]+)?names?(?![a-z])")

# Attributes the register already holds for a person. `nationality` counts only
# alongside a role word; NRC / passport / father's name give a human away on
# their own (a company has none of them).
_ATTR_RE = re.compile(
    r"\bnrcs?\b|\bn\.\s?r\.\s?c\b|national\s+registration(?:\s+card)?\b"
    r"|\bpassports?\b|\bnationalit(?:y|ies)\b|\bfathers?'?\s*name\b"
)
_HARD_ID_RE = re.compile(
    r"\bnrcs?\b|\bn\.\s?r\.\s?c\b|national\s+registration(?:\s+card)?\b"
    r"|\bpassports?\b|\bfathers?'?\s*name\b"
)

_WHO_RE = re.compile(r"\bwho(?:m|se)?\b")

# Only used with "who", to separate "Who will sign the minutes?" (a person) from
# "Who can upload a template?" (a capability question).
_PERSON_VERB_RE = re.compile(
    r"\b(?:sign|signs|signed|signing|chair|chairs|chaired|chairing"
    r"|attend|attends|attended|attending|appoint|appoints|appointed|appointing"
    r"|resign|resigns|resigned|resigning|represent|represents|represented"
    r"|representing|witness|witnesses|witnessed|witnessing)\b"
)

# "…name of the NEW company", "template name", "name of the venue" — the thing
# being named is not a human, so a bare `name` ask must not trip the guard.
_NOT_A_PERSON_NAME_RE = re.compile(
    r"\b(?:new|proposed|incoming|target)\s+compan(?:y|ies)\b"
    r"|\b(?:compan(?:y|ies)|templates?|documents?|forms?|files?|reports?"
    r"|venues?|locations?|places?|addresses|offices?|banks?)(?:'s)?[\s_]+names?(?![a-z])"
    r"|\bnames?\s+of\s+the\s+(?:new\s+|proposed\s+)?"
    r"(?:compan(?:y|ies)|templates?|documents?|forms?|files?|reports?"
    r"|venues?|locations?|places?|offices?|banks?)\b"
    # "…name of the company SECRETARY" is a person, not the company — the
    # exemption must not swallow a role word sitting right after the noun.
    r"(?!\s+(?:secretar|directors?|share\s?holder|signator|signer|chair"
    r"|representative|appointee|attendee|witness))"
)

# Which picker pair answers each role. Both tools of every pair are registered
# in scout/agent.py `_tools_to_add`.
_PICKER_FOR_ROLE: Dict[str, Tuple[str, str]] = {
    "representative": ("lookup_representative_candidates", "choose_representative_director"),
    "attendee": ("lookup_attendee_candidates", "choose_attendees"),
    "shareholder": ("lookup_attendee_candidates", "choose_attendees"),
    "director": ("lookup_director_candidates", "choose_director"),
    "chair": ("lookup_director_candidates", "choose_director"),
    "appointee": ("lookup_director_candidates", "choose_director"),
    "signatory": ("lookup_director_candidates", "choose_director"),
    "secretary": ("lookup_director_candidates", "choose_director"),
    "witness": ("lookup_register_candidates", "choose_person_from_register"),
    "register": ("lookup_register_candidates", "choose_person_from_register"),
}


def _role_key(word: str) -> str:
    """Collapse a matched role word to a key in _PICKER_FOR_ROLE."""
    w = word.replace(" ", "")
    for prefix, key in (
        ("representative", "representative"),
        ("attendee", "attendee"),
        ("shareholder", "shareholder"),
        ("director", "director"),
        ("chair", "chair"),
        ("appointee", "appointee"),
        ("signator", "signatory"),
        ("signer", "signatory"),
        ("secretar", "secretary"),
        ("witness", "witness"),
    ):
        if w.startswith(prefix):
            return key
    return "register"


def _person_role(text: str) -> Optional[str]:
    """Role key if this question asks the user to TYPE a person, else None.

    Conservative by construction — a miss costs a prompt-only enforcement, a
    false positive breaks a verified flow (template choice, yes/no approval).
    """
    t = _WS_RE.sub(" ", str(text or "")).strip().lower()
    if not t:
        return None

    entity_spans = [m.span() for m in _ENTITY_ROLE_RE.finditer(t)]
    role_hits = [
        m
        for m in _ROLE_RE.finditer(t)
        if not any(s <= m.start() and m.end() <= e for s, e in entity_spans)
    ]

    if role_hits:
        key = _role_key(role_hits[0].group(1))
        # "who" or a register-held attribute settles it outright.
        if _WHO_RE.search(t) or _ATTR_RE.search(t):
            return key
        # A bare "name" ask counts unless the thing being named is not a human.
        if _NAME_RE.search(t) and not _NOT_A_PERSON_NAME_RE.search(t):
            return key
        return None

    # No human role named. Two things still give a person away on their own.
    if _HARD_ID_RE.search(t) and not _NOT_A_PERSON_NAME_RE.search(t):
        return "register"
    if _WHO_RE.search(t) and _PERSON_VERB_RE.search(t):
        return "register"
    return None


def _question_id(q: Any, index: int) -> str:
    if isinstance(q, dict):
        qid = str(q.get("id") or "").strip()
        if qid:
            return qid
    return f"q{index}"


def _split_person_questions(questions: Any) -> Tuple[List[str], List[Dict[str, Any]]]:
    """Partition the batch into allowed question ids and blocked descriptors.

    Only FREE-TEXT questions are inspected. A question carrying `options` is
    already a constrained pick rendered as chips, and blocking those would break
    the verified template-choice and yes/no-approval flows for no gain — the
    measured defect is free text. Person-shaped questions that do carry options
    are left to the system prompt's rule.
    """
    allowed: List[str] = []
    blocked: List[Dict[str, Any]] = []
    if not isinstance(questions, list):
        return allowed, blocked

    for i, q in enumerate(questions):
        qid = _question_id(q, i)
        text = q.get("text") if isinstance(q, dict) else str(q)
        has_options = bool(isinstance(q, dict) and q.get("options"))
        role = None if has_options else _person_role(text or "")
        if role is None:
            allowed.append(qid)
            continue
        lookup_tool, picker_tool = _PICKER_FOR_ROLE[role]
        blocked.append(
            {
                "id": qid,
                "question": text,
                "reason": (
                    "This asks the user to TYPE a person. People are chosen from the "
                    "register through a picker card, never typed — a typed name may "
                    "exist in no register and arrives without its NRC."
                ),
                "call_instead": [lookup_tool, picker_tool],
            }
        )
    return allowed, blocked


def _filter_answers(parsed: Any, questions: Any, allowed_ids: List[str]) -> Any:
    """Keep only the answers belonging to questions the guard allowed.

    The card has sent answers back in three shapes over the life of this tool:
    a dict keyed by question id, a list of {id, answer} objects, and a bare
    positional list. Anything else is passed through untouched — dropping an
    answer we cannot identify would cost the user a re-ask for no safety gain.
    """
    keep = set(allowed_ids)

    if isinstance(parsed, dict):
        return {k: v for k, v in parsed.items() if str(k) in keep}

    if isinstance(parsed, list):
        if all(isinstance(a, dict) and a.get("id") is not None for a in parsed):
            return [a for a in parsed if str(a.get("id")) in keep]
        if isinstance(questions, list) and len(parsed) == len(questions):
            return [
                a
                for i, (a, q) in enumerate(zip(parsed, questions))
                if _question_id(q, i) in keep
            ]

    return parsed


def _blocked_instruction(blocked: List[Dict[str, Any]]) -> str:
    calls = []
    for b in blocked:
        lookup_tool, picker_tool = b["call_instead"]
        calls.append(f"{lookup_tool}(...) then {picker_tool}(...)")
    unique_calls = list(dict.fromkeys(calls))
    return (
        "REFUSED — you asked for a person as free text. Do NOT re-ask these as "
        "questions and do NOT use any value the user typed for them. In THIS SAME "
        "turn call: " + "; ".join(unique_calls) + ". Pass the lookup tool's JSON "
        "straight into the picker's candidates_json and never fill `selected` "
        "yourself. If the person is not among the candidates, use "
        "lookup_register_candidates(company_name=...) then "
        "choose_person_from_register(...). After the picker confirms, continue the "
        "task and finish the turn with a short sentence to the user."
    )


@tool(requires_user_input=True, user_input_fields=["answers"])
def ask_questions(questions_json: str, answers: str = "") -> str:
    """Ask the user one to four structured questions in an interactive chat card.

    Use this for EVERY non-person decision: template choices, yes/no approvals,
    and missing fields. NEVER write lettered a)/b)/c) options in prose — options
    become clickable chips on the card. The run pauses; the user answers in the
    interactive card; you never fill `answers` yourself (Agno fills it on resume).

    Person selection is the ONE exception, and it is ENFORCED, not advisory. A
    question that asks the user to type a person — the name, NRC, passport,
    nationality or father's name of a director, shareholder, signatory,
    chairperson, appointee, representative, attendee, secretary or witness — is
    REFUSED and returns "status": "wrong_tool" naming the picker to call
    instead. Choose people with the picker tools (lookup_* / choose_*).

    Use ask_questions for everything that is NOT a person: dates, pronouns,
    locations, amounts and fees, share counts, yes/no approvals, which template
    to use, and the name of a NEW entity not yet in any register (for example
    the proposed name of a company being incorporated).

    `questions_json` is a JSON array (1-4 items) of question objects:
        {
          "id":           stable key you read the answer back by (required),
          "text":         the question shown to the user (required),
          "options":      list of choices rendered as chips (optional),
          "multi_select": true to allow more than one choice (optional),
          "allow_other":  true to offer a free-text "Other…" entry (optional)
        }
    Omit "options" for a free-text answer. Give "options" (usually with
    "allow_other": true) when the choices are enumerable.

    Example (a) — single-pick template choice with options:
        ask_questions(questions_json='['
            '{"id": "template", "text": "Which template?",'
            ' "options": ["AGM Minutes", "Director Consent", "Shareholder Resolution"]}'
        ']')

    Example (b) — yes/no approval (exactly two options):
        ask_questions(questions_json='['
            '{"id": "approve", "text": "Generate AGM Minutes for City Holdings now?",'
            ' "options": ["Yes, generate it", "No, change the data first"]}'
        ']')

    Example (c) — mixed missing fields (free-text date + options for location):
        ask_questions(questions_json='['
            '{"id": "meeting_date", "text": "Meeting date?", "allow_other": true},'
            '{"id": "meeting_location", "text": "Meeting location?",'
            ' "options": ["Registered office", "Head office"], "allow_other": true}'
        ']')

    Args:
        questions_json: JSON array of 1-4 question objects (schema above).
        answers: Filled in by the user from the chat card. Never set this yourself.

    Returns:
        A JSON string. On resume it carries "status": "answered" plus the user's
        answers, which you must use verbatim as authoritative values.
    """
    # Validate the model-authored question payload first.
    try:
        questions = json.loads(questions_json) if isinstance(questions_json, str) else questions_json
    except (ValueError, TypeError) as e:
        return json.dumps(
            {
                "status": "error",
                "message": f"questions_json is not valid JSON: {e}",
                "expected_schema": EXPECTED_SCHEMA,
            }
        )

    problems = _validate_questions(questions)
    if problems:
        return json.dumps(
            {
                "status": "error",
                "message": "questions_json is invalid: " + "; ".join(problems),
                "expected_schema": EXPECTED_SCHEMA,
            }
        )

    # Refuse person-shaped questions BEFORE the answers are read back, so a
    # typed name can never be handed to the model as an authoritative value.
    allowed_ids, blocked = _split_person_questions(questions)

    if blocked and not allowed_ids:
        return json.dumps(
            {
                "status": "wrong_tool",
                "blocked": blocked,
                "instruction": _blocked_instruction(blocked),
            }
        )

    # Normalise whatever the card sent back. `answers` is empty only if the run
    # reaches here without the user having answered — mirror the pickers and ask
    # for it again via the card rather than falling back to a prose question.
    try:
        parsed_answers = json.loads(answers) if isinstance(answers, str) and answers.strip() else answers
    except (ValueError, TypeError):
        parsed_answers = answers

    if parsed_answers in (None, "", [], {}):
        if blocked:
            # Mixed batch, nothing answered yet: keep the legitimate questions
            # alive instead of losing them with the refused ones.
            return json.dumps(
                {
                    "status": "wrong_tool",
                    "blocked": blocked,
                    "ask_again": allowed_ids,
                    "instruction": (
                        _blocked_instruction(blocked)
                        + " Then call ask_questions again with ONLY these question ids: "
                        + ", ".join(allowed_ids)
                        + "."
                    ),
                }
            )
        return json.dumps(
            {
                "status": "no_answer",
                "instruction": (
                    "The user has not answered yet. Call ask_questions again so the "
                    "question is shown as an interactive card. NEVER ask as plain "
                    "text and NEVER offer a), b), c) options in prose."
                ),
            }
        )

    continue_instruction = (
        "The user has answered. Use these answers verbatim as authoritative "
        "values and CONTINUE THE TASK IN THIS SAME TURN: make the next "
        "required tool call (prepare/preview/lookup/picker), then finish the "
        "turn with one or two sentences telling the user what you just did and "
        "what happens next. Ending your turn with empty output — or with tool "
        "calls and no text — is forbidden. Do not re-ask, do not restate the "
        "options, and do not present a), b), c) lists in prose."
    )

    if blocked:
        # Mixed batch, answered: hand back the legitimate answers (so the user is
        # never asked those twice) and refuse only the person-shaped ones.
        kept = _filter_answers(parsed_answers, questions, allowed_ids)
        return json.dumps(
            {
                "status": "answered_with_blocked",
                "answers": kept,
                "blocked": blocked,
                "instruction": (
                    "Use the values in `answers` verbatim — those questions were "
                    "legitimate and are settled; do NOT ask them again. "
                    + _blocked_instruction(blocked)
                ),
            }
        )

    return json.dumps(
        {
            "status": "answered",
            "answers": parsed_answers,
            "instruction": continue_instruction,
        }
    )


ask_questions_tools = {
    "ask_questions": ask_questions,
}
