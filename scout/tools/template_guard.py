"""
Refuse to generate a template that CONTRADICTS what was asked for.
=================================================================

The worst defect this product has produced is not a missing field — it is the
wrong legal instrument. Measured on the client's own tracker, roughly two runs
in eleven:

    request:  "director consent form (non group member) for Win Win Tint"
    call:     generate_document(template_name="Individual Shareholder Consent Form.docx")

A Shareholder Consent is not a Director Consent. It consents to a different
thing, is signed by a different person, and filed for a different purpose. A
missing date is visible to whoever reads the draft; the wrong instrument, filled
correctly and looking exactly right, is not.

Why it happens is understood: 9 of 15 templates carry `ai_analyzed = FALSE`
while claiming `ai_trained = TRUE`, so `purpose`, `when_to_use` and `how_to_use`
are empty and matching falls back on FILENAMES. The filenames of the confusable
pairs differ by one or two words — Group vs Non-Group, Director vs Shareholder,
Resignation vs Appointment — so a near neighbour looks like a match.

This module does NOT try to pick the right template. It refuses the clearly
wrong one, which is a much smaller and far more reliable job:

  * it fires only when the request states a side EXPLICITLY and the chosen
    template states the OPPOSITE side explicitly;
  * silence on either side is never a contradiction, so an ambiguous request
    generates exactly as it does today;
  * it is pure text, so it costs nothing, cannot fail, and is testable offline
    with the client's own transcripts.

The guard is deliberately narrow. A wrong refusal costs one clarifying
question; a wrong generation costs a filing.
"""

from __future__ import annotations

import re

# Each axis is a distinction where confusing the two sides produces the wrong
# instrument rather than a cosmetic difference. `label` is what the user is
# told; it has to name the distinction in their words, not ours.
#
# Tokens are matched on WORD BOUNDARIES. "director" must not match inside
# "directors' resolution" by accident of substring — and, more importantly,
# "non group" must be tested before "group", which is why NON_GROUP owns the
# negated forms explicitly instead of relying on ordering.
DISCRIMINATORS: list[dict] = [
    {
        "axis": "role",
        "label": "a director consent and a shareholder consent are different instruments",
        "a": {"name": "director", "tokens": [r"director'?s?\s+consent", r"consent[^.]{0,30}\bdirector"]},
        "b": {"name": "shareholder", "tokens": [r"shareholder'?s?\s+consent", r"consent[^.]{0,30}\bshareholder"]},
    },
    {
        "axis": "membership",
        "label": "a group-member appointment and a non-group appointment are different forms",
        # NON-group first in intent: the negation is the distinguishing word.
        "a": {"name": "non-group", "tokens": [r"non[\s-]?group"]},
        "b": {"name": "group", "tokens": [r"(?<!non[\s-])\bgroup\s+member"]},
        "negates": True,
    },
    {
        "axis": "action",
        "label": "a resignation and an appointment are different events",
        "a": {"name": "resignation", "tokens": [r"\bresignation\b", r"\bresign(?:ing|s|ed)?\b"]},
        "b": {"name": "appointment", "tokens": [r"\bappointment\b", r"\bappoint(?:ing|s|ed)?\b"]},
    },
    {
        "axis": "party type",
        "label": "an individual shareholder and a corporate shareholder sign differently",
        "a": {"name": "individual", "tokens": [r"\bindividual\b"]},
        "b": {"name": "corporate", "tokens": [r"\bcorporate\b"]},
    },
]


def _hits(text: str, tokens: list[str]) -> bool:
    return any(re.search(t, text, re.IGNORECASE) for t in tokens)


def _side(text: str, spec: dict) -> str | None:
    """Which side of an axis this text asserts, or None if it does not say.

    Asserting BOTH is the same as saying nothing: "resignation and appointment"
    is a real request (there is a template for exactly that), and treating it as
    a contradiction would refuse a document the firm generates routinely.
    """
    a = _hits(text, spec["a"]["tokens"])
    b = _hits(text, spec["b"]["tokens"])
    if a == b:
        return None
    return spec["a"]["name"] if a else spec["b"]["name"]


def contradiction(request_text: str, template_name: str) -> dict | None:
    """Does `template_name` contradict `request_text`? None if it does not.

    Returns the axis, both sides and a sentence for the user. Only the FIRST
    contradiction is reported: one clear question beats a list, and the axes are
    ordered by how consequential confusing them is.
    """
    if not request_text or not template_name:
        return None

    # Strip the extension and separators so "Director_Consent_Form" reads the
    # same as "Director Consent Form".
    tpl = re.sub(r"\.docx?$", "", template_name, flags=re.IGNORECASE)
    tpl = re.sub(r"[_\-]+", " ", tpl)

    for spec in DISCRIMINATORS:
        asked = _side(request_text, spec)
        chosen = _side(tpl, spec)
        if asked and chosen and asked != chosen:
            return {
                "axis": spec["axis"],
                "requested": asked,
                "template": chosen,
                "message": (
                    f"You asked for the {asked} form, but "
                    f"{template_name} is the {chosen} one — {spec['label']}. "
                    "Confirm which you want before I generate it."
                ),
            }
    return None
