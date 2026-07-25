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
from typing import Any, List

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


@tool(requires_user_input=True, user_input_fields=["answers"])
def ask_questions(questions_json: str, answers: str = "") -> str:
    """Ask the user one to four structured questions in an interactive chat card.

    Use this for EVERY non-person decision: template choices, yes/no approvals,
    and missing fields. NEVER write lettered a)/b)/c) options in prose — options
    become clickable chips on the card. The run pauses; the user answers in the
    interactive card; you never fill `answers` yourself (Agno fills it on resume).

    Person selection is the ONE exception — choose people with the dedicated
    picker tools (lookup_* / choose_*), not with ask_questions.

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

    # Normalise whatever the card sent back. `answers` is empty only if the run
    # reaches here without the user having answered — mirror the pickers and ask
    # for it again via the card rather than falling back to a prose question.
    try:
        parsed_answers = json.loads(answers) if isinstance(answers, str) and answers.strip() else answers
    except (ValueError, TypeError):
        parsed_answers = answers

    if parsed_answers in (None, "", [], {}):
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

    return json.dumps(
        {
            "status": "answered",
            "answers": parsed_answers,
            "instruction": (
                "The user has answered. Use these answers verbatim as authoritative "
                "values and continue the task now. Do not re-ask, do not restate the "
                "options, and do not present a), b), c) lists in prose."
            ),
        }
    )


ask_questions_tools = {
    "ask_questions": ask_questions,
}
