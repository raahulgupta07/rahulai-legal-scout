"""
Built-in routine catalogue.

Each routine here is the workflow section of an EXISTING `legal_skills` body,
transcribed into steps. Nothing is invented: `director-resignation` below is the
five numbered lines under "## Workflow (Scout tools)" in the skill of the same
name (migration_014_seed_legal_skills.sql), expanded to one step per tool call
because "generate the chain: find -> prepare -> preview -> generate, letter
first" is nine calls, not one.

WHY PYTHON AND NOT SEED SQL
---------------------------
Migration 022 is pure DDL. The catalogue lives here and is UPSERTed into the
tables by `store.sync_catalog()`, the same shape as `_refresh_legal_skills()`
splicing skill metadata into the prompt at startup and on every CRUD write.

The alternative — seeding rows in the migration — is what was done for skill
bodies in migration 014, and migration 021 then had to rewrite six of those
bodies by regular expression because they named tools that did not exist. A row
seeded by a migration can only ever be corrected by another migration. A
catalogue in source is corrected by editing it, and the correction reaches every
install on the next sync.

TOOL NAMES
----------
Every `tool=` below is the name the LIVE REGISTRY uses, which is not always the
name the export dict or CLAUDE.md uses:

    preview_doc        the export key in smart_doc.py is "preview_document",
                       but the function is `def preview_doc` and _as_json uses
                       @wraps, so the name agno registers is preview_doc. Six
                       skill bodies got this wrong; migration 021 fixed them.

These are checked, not trusted: `model.validate(routine, known_tools=...)`
compares them against `scout.agent._registered_tool_names()`, and
`tests/tracker_routines.py` resolves the same set statically with `ast` so the
check runs with no agno installed.
"""

from __future__ import annotations

from scout.routines.model import (
    DONE_ALWAYS,
    DONE_MANUAL,
    Routine,
    RoutineInput,
    RoutineStep,
)


def _doc_chain(
    prefix: str,
    start_no: float,
    what: str,
    template_hint: str,
    extra_requires: list[str],
) -> list[RoutineStep]:
    """The find -> preview -> generate triple that produces one document.

    Written once rather than three times because the ORDER inside it is the
    load-bearing part. "Step 3: PREVIEW FIRST (Required!)" spent weeks not
    running because the prompt named `preview_document`, a tool that did not
    exist; the measured effect of repairing it was Layer 3 stalls going 7 -> 13
    across six case-runs, because a required step had started executing. A
    routine makes that ordering a row a test can read, instead of a sentence in
    a prompt that may or may not be obeyed.
    """
    requires = ["company_name", *list(extra_requires)]
    tpl_key = f"{prefix}_template"
    return [
        RoutineStep(
            key=f"find_{prefix}_template",
            no=start_no,
            title=f"Find the {what} template",
            tool="find_matching_templates",
            args={"query": template_hint},
            requires=list(requires),
            produces=[tpl_key],
            notes=(
                "Never hand-type a template name. The register is edited from "
                "the admin UI and a name that was right last month is a "
                "'Template not found' today."
            ),
        ),
        RoutineStep(
            key=f"preview_{prefix}",
            no=start_no + 1,
            title=f"Preview the {what} before anything is finalised",
            tool="preview_doc",
            args={"template_name": f"${tpl_key}", "company_name": "$company_name"},
            requires=[*requires, tpl_key],
            produces=[f"{prefix}_preview"],
        ),
        RoutineStep(
            key=f"generate_{prefix}",
            no=start_no + 2,
            title=f"Generate the {what}",
            tool="generate_document",
            args={"template_name": f"${tpl_key}", "company_name": "$company_name"},
            requires=[*requires, tpl_key, f"{prefix}_preview"],
            produces=[f"{prefix}_doc"],
        ),
    ]


# ---------------------------------------------------------------------------
# director-resignation
# ---------------------------------------------------------------------------
DIRECTOR_RESIGNATION = Routine(
    name="director-resignation",
    title="Director resignation chain",
    description=(
        "Resignation letter, the matching shareholders resolution and the "
        "matching meeting minutes, plus the register soft-end and the DICA "
        "Form C follow-up."
    ),
    skill="director-resignation",
    triggers=[
        "director resignation",
        "is resigning",
        "resign from the board",
        "step down from the board",
        "remove a director",
        "replace a director",
    ],
    inputs=[
        RoutineInput(
            key="company_name",
            label="Company",
            kind="company",
            source_hint="company",
        ),
        RoutineInput(
            key="resignation_variant",
            label="Resignation only, or resignation and new appointment?",
            kind="choice",
            source_hint="user",
            notes=(
                "The template set FORKS here — resignation-only and "
                "resignation-and-appointment are different resolutions and "
                "different minutes. The skill body says to ask; nothing today "
                "records the answer, so it is asked again per document."
            ),
        ),
        RoutineInput(
            key="resigning_director",
            label="Which sitting director is leaving",
            kind="person",
            source_hint="register",
        ),
        RoutineInput(
            key="effective_date",
            label="Effective date of resignation",
            kind="date",
            source_hint="user",
        ),
    ],
    steps=[
        RoutineStep(
            key="load_playbook",
            no=1,
            title="Load the director-resignation playbook",
            tool="load_skill",
            args={"name": "director-resignation"},
            produces=["playbook"],
            notes="The routine sequences the skill, it does not replace it. The "
            "body carries the legal reasoning, the gates and the wording; "
            "these rows carry only the order and the inputs.",
        ),
        RoutineStep(
            key="read_company",
            no=2,
            title="Read the company record",
            tool="get_company",
            args={"company_name": "$company_name"},
            requires=["company_name"],
            produces=["company"],
        ),
        RoutineStep(
            key="read_board",
            no=3,
            title="Read the current board",
            tool="get_directors",
            args={"company_name": "$company_name"},
            requires=["company_name"],
            produces=["board"],
        ),
        RoutineStep(
            key="choose_variant",
            no=4,
            title="Ask: resignation only, or resignation and appointment?",
            tool="ask_questions",
            requires=["board"],
            produces=["resignation_variant"],
        ),
        RoutineStep(
            key="offer_resigning_director",
            no=5,
            title="Offer the sitting directors as candidates",
            tool="lookup_director_candidates",
            args={"company_name": "$company_name"},
            requires=["board"],
            produces=["director_candidates"],
        ),
        RoutineStep(
            key="pick_resigning_director",
            no=6,
            title="User picks the resigning director",
            tool="choose_director",
            requires=["director_candidates"],
            produces=["resigning_director"],
            notes="Never guessed and never carried over from another "
            "conversation. A person picked in one chat reappearing "
            "unasked in another is the measured defect migration 017 "
            "exists to prevent.",
        ),
        RoutineStep(
            key="confirm_effective_date",
            no=7,
            title="Confirm the effective date",
            tool="ask_questions",
            requires=["resigning_director"],
            produces=["effective_date"],
        ),
        RoutineStep(
            key="board_floor_check",
            no=8,
            title="Flag if the resignation drops the board below its minimum",
            requires=["board", "resigning_director"],
            done_when=DONE_ALWAYS,
            notes="A resignation that breaches the constitutional or statutory "
            "minimum needs an appointment at the same time. Flagged for "
            "the user to verify — this routine asserts no day-count and no "
            "section number it has not confirmed.",
        ),
        *_doc_chain(
            "letter", 9, "resignation letter", "Director Resignation Letter", ["resigning_director", "effective_date"]
        ),
        *_doc_chain(
            "resolution",
            12,
            "shareholders resolution",
            "Shareholders Resolution In Writing - Director Resignation",
            ["resigning_director", "effective_date", "resignation_variant"],
        ),
        *_doc_chain(
            "minutes",
            15,
            "meeting minutes",
            "Shareholders Meeting Minutes - Director Resignation",
            ["resigning_director", "effective_date", "resignation_variant"],
        ),
        RoutineStep(
            key="register_soft_end",
            no=18,
            title="Record the cessation in the register (soft-end, never delete)",
            requires=["resigning_director", "effective_date"],
            done_when=DONE_MANUAL,
            notes="Confirm with the user before writing. History has to remain "
            "reconstructable for future filings and diligence, so the "
            "person is ended, not removed. This step is a human gate on "
            "purpose: the routine flags the update, it does not silently "
            "mutate the register.",
        ),
        RoutineStep(
            key="form_c_followup",
            no=19,
            title="Note the DICA officer-change filing as a follow-up",
            done_when=DONE_ALWAYS,
            notes="An officer change is notified to DICA. Verify the current "
            "form and window with DICA practice rather than quoting a "
            "day-count from memory — hardcoded citations are how Indian "
            "company law ended up in a Myanmar product (migration 018).",
        ),
    ],
)


# ---------------------------------------------------------------------------
# director-appointment
# ---------------------------------------------------------------------------
DIRECTOR_APPOINTMENT = Routine(
    name="director-appointment",
    title="Director appointment chain",
    description=(
        "Consent form (group vs non-group), shareholders resolution and "
        "minutes for bringing a new director onto the board."
    ),
    skill="director-appointment",
    triggers=[
        "appoint a director",
        "add a director",
        "new director",
        "onto the board",
        "director appointment",
    ],
    inputs=[
        RoutineInput(
            key="company_name",
            label="Company",
            kind="company",
            source_hint="company",
        ),
        RoutineInput(
            key="consent_variant",
            label="Group member appointment, or non-group?",
            kind="choice",
            source_hint="user",
            notes="The skill body is explicit: if unsure, ask — never default silently.",
        ),
        RoutineInput(
            key="incoming_director",
            label="The incoming director",
            kind="person",
            source_hint="register",
        ),
        RoutineInput(
            key="effective_date",
            label="Effective date of appointment",
            kind="date",
            source_hint="user",
        ),
    ],
    steps=[
        RoutineStep(
            key="load_playbook",
            no=1,
            title="Load the director-appointment playbook",
            tool="load_skill",
            args={"name": "director-appointment"},
            produces=["playbook"],
        ),
        RoutineStep(
            key="read_company",
            no=2,
            title="Read the company record",
            tool="get_company",
            args={"company_name": "$company_name"},
            requires=["company_name"],
            produces=["company"],
        ),
        RoutineStep(
            key="choose_variant",
            no=3,
            title="Ask: group member appointment or non-group?",
            tool="ask_questions",
            requires=["company"],
            produces=["consent_variant"],
        ),
        RoutineStep(
            key="offer_incoming_director",
            no=4,
            title="Offer register candidates for the incoming director",
            tool="lookup_register_candidates",
            args={"company_name": "$company_name"},
            requires=["company"],
            produces=["register_candidates"],
        ),
        RoutineStep(
            key="pick_incoming_director",
            no=5,
            title="User picks the incoming director",
            tool="choose_person_from_register",
            requires=["register_candidates"],
            produces=["incoming_director"],
        ),
        RoutineStep(
            key="confirm_effective_date",
            no=6,
            title="Confirm the effective date",
            tool="ask_questions",
            requires=["incoming_director"],
            produces=["effective_date"],
        ),
        *_doc_chain(
            "consent", 7, "director consent form", "Director Consent Form", ["incoming_director", "consent_variant"]
        ),
        *_doc_chain(
            "resolution",
            10,
            "shareholders resolution",
            "Shareholders Resolution In Writing - Director Appointment",
            ["incoming_director", "effective_date"],
        ),
        *_doc_chain(
            "minutes",
            13,
            "meeting minutes",
            "Shareholders Meeting Minutes - Director Appointment",
            ["incoming_director", "effective_date"],
        ),
        RoutineStep(
            key="form_c_followup",
            no=16,
            title="Note the DICA officer-change filing as a follow-up",
            done_when=DONE_ALWAYS,
        ),
    ],
)


# ---------------------------------------------------------------------------
# agm-meeting-chain
# ---------------------------------------------------------------------------
AGM_MEETING_CHAIN = Routine(
    name="agm-meeting-chain",
    title="Annual General Meeting document chain",
    description=(
        "Notice of calling, notice to shareholders, minutes and the written "
        "resolution — drafted in order so they agree with each other."
    ),
    skill="agm-meeting-chain",
    triggers=[
        "run the agm",
        "prepare the agm",
        "call an agm",
        "annual general meeting",
        "agm minutes",
        "agm documents",
    ],
    inputs=[
        RoutineInput(
            key="company_name",
            label="Company",
            kind="company",
            source_hint="company",
        ),
        RoutineInput(key="meeting_date", label="Meeting date", kind="date", source_hint="user"),
        RoutineInput(key="meeting_time", label="Meeting time", kind="text", source_hint="user"),
        RoutineInput(
            key="financial_year_end",
            label="Financial year end being reported on",
            kind="date",
            source_hint="company",
        ),
        RoutineInput(
            key="auditor_name",
            label="Auditor",
            kind="text",
            required=False,
            source_hint="company",
            notes="Unknown stays an explicit TBD. Never invent an auditor.",
        ),
    ],
    steps=[
        RoutineStep(
            key="load_playbook",
            no=1,
            title="Load the agm-meeting-chain playbook",
            tool="load_skill",
            args={"name": "agm-meeting-chain"},
            produces=["playbook"],
        ),
        RoutineStep(
            key="read_company",
            no=2,
            title="Read the company record",
            tool="get_company",
            args={"company_name": "$company_name"},
            requires=["company_name"],
            produces=["company"],
            notes="The registered office is the meeting-location default. Never put a person's address there.",
        ),
        RoutineStep(
            key="read_shareholders",
            no=3,
            title="Read the members",
            tool="get_shareholders",
            args={"company_name": "$company_name"},
            requires=["company_name"],
            produces=["members"],
        ),
        RoutineStep(
            key="confirm_meeting_details",
            no=4,
            title="Confirm meeting date, time, financial year end and auditor",
            tool="ask_questions",
            requires=["company"],
            produces=["meeting_date", "meeting_time", "financial_year_end"],
            notes="Asked ONCE for the whole chain. Today each template's fill "
            "recomputes its own missing fields from the company record "
            "alone, which is why new-company setup asks for the meeting "
            "date once per template.",
        ),
        RoutineStep(
            key="notice_checklist",
            no=5,
            title="Walk the notice-period and quorum checklist, surface any gap",
            requires=["members", "meeting_date"],
            done_when=DONE_MANUAL,
            notes="If the minutes would record a meeting that was not quorate, "
            "stop and flag it — do not produce minutes that imply a valid "
            "AGM occurred.",
        ),
        *_doc_chain(
            "calling", 6, "notice of calling", "Notice of Calling for Annual General Meeting", ["meeting_date"]
        ),
        *_doc_chain(
            "notice",
            9,
            "notice to shareholders",
            "Notice of Annual General Meeting to Shareholders",
            ["meeting_date", "members"],
        ),
        *_doc_chain(
            "minutes",
            12,
            "AGM minutes",
            "Annual General Meeting Minutes",
            ["meeting_date", "meeting_time", "members", "financial_year_end"],
        ),
        *_doc_chain(
            "resolution",
            15,
            "shareholders resolution in writing",
            "Shareholders Resolution In Writing for Annual General Meeting",
            ["meeting_date", "members"],
        ),
        RoutineStep(
            key="annual_return_followup",
            no=18,
            title="Note the DICA annual return as a follow-up",
            done_when=DONE_ALWAYS,
        ),
    ],
)


CATALOG: list[Routine] = [
    AGM_MEETING_CHAIN,
    DIRECTOR_APPOINTMENT,
    DIRECTOR_RESIGNATION,
]


def by_name() -> dict[str, Routine]:
    return {r.name: r for r in CATALOG}


def get(name: str) -> Routine:
    """Look a routine up by name. Raises KeyError for an unknown name."""
    return by_name()[name]
