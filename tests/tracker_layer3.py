"""
Layer 3 — drive a WHOLE conversation to a generated document. SCRIPTED.

Layers 1 and 2 proved the data is right and that the agent asks instead of
guessing. Neither answers the tracker's other big complaint:

    "The system asked the information, but the provided information are not
     used in the exported document."

That needs someone to actually answer the questions and then read the .docx.
This file still does exactly that — catch each RunPaused, fill the answer into
the paused tool the way the browser does, resume the same run, download the
file, unzip `word/document.xml` and assert against its text. The only thing
that changed is what is on the other end: `scout.testing.ScriptedAgentRuntime`
instead of a paid model over HTTP.

WHY
---
CLAUDE.md: "Layer 2/3 failures move between cases run to run; do not treat one
as a regression until it reproduces." Every assertion in this file used to sit
downstream of a model, so a red run was never evidence on its own. It is now
deterministic — same bytes every run, no credentials, no container, no network.

WHAT IS UNDER TEST
------------------
Not the model. The assertion machinery, the pause/resume protocol and the
document read-back — the parts that decide whether a document counts as wrong.
The scripted document is NOT written by pasting the expected strings into a
file; that would be a test asserting nothing. `Document` fills a template
through `fill_template()`, which resolves each slot from what the run actually
RECORDED: the person genuinely chosen in each picker, the answer genuinely
submitted for each question.

So every case runs its golden script and then one or more MUTANTS, each
reproducing a specific historical defect:

  first_candidate  the corporate representative resolves to the member company's
                   FIRST DIRECTOR and the user's choice is discarded — the exact
                   bug E3 was written for. Flipped with a runtime flag, so the
                   assertions fire because the resolution is wrong, not because
                   the test was edited.
  wrong_register   the picker offers the wrong company's board, so the person the
                   case named is never on the list.
  a mutant template  the document itself is malformed — a value dropped, a party
                   rendered twice, a corporate row that should have been deleted.

A mutant that comes out PASS is reported as a failure of this suite: it means
the assertion it targets has stopped discriminating.

Real model behaviour still needs watching; that lives in `tracker_layer3_live.py`,
run on demand against a real stack.

Run:  python3 tests/tracker_layer3.py [case_id ...]
"""

import importlib.util
import io
import json
import os
import re
import sys
import zipfile

MAX_TURNS = 16

# ── loading the runtime ─────────────────────────────────────────────
# By PATH, not `from scout.testing import ...`. `scout/__init__.py` imports
# `scout.agent`, which imports `agno.tools.mcp.MCPTools`, which raises unless
# the `mcp` package is installed — it is not, on a dev laptop. Loading the one
# stdlib-only module directly keeps this suite runnable anywhere.
_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SPEC = importlib.util.spec_from_file_location(
    "scout_scripted_runtime",
    os.path.join(_REPO, "scout", "testing", "scripted_runtime.py"),
)
_RT = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_RT)

Ask, Complete, Document, Error = _RT.Ask, _RT.Complete, _RT.Document, _RT.Error
Pick, Text, ToolCall = _RT.Pick, _RT.Text, _RT.ToolCall
ScriptedAgentRuntime, candidate = _RT.ScriptedAgentRuntime, _RT.candidate


def _consume(resp):
    """Read one SSE stream into the bits we care about.

    Unchanged from the live suite. `resp` is now the runtime's stream object,
    which iterates byte lines exactly like the `urllib` response did, so this
    parser is exercised rather than bypassed.
    """
    tools, content, reasoning, paused_ev, error = [], [], [], None, None
    for raw in resp:
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            continue
        try:
            ev = json.loads(line[5:].strip(), strict=False)
        except (ValueError, TypeError):
            continue
        name = ev.get("event")
        if name == "ToolCallStarted":
            t = (ev.get("tool") or {}).get("tool_name") or ev.get("tool_name")
            if t:
                tools.append(t)
        elif name == "RunContent":
            if isinstance(ev.get("content"), str):
                content.append(ev["content"])
            # Captured so a silent stop can be told apart from a stall. This
            # model streams its thinking on `reasoning_content`, separate from
            # `content`, and a turn can produce plenty of the former and none of
            # the latter — which is what the "silent stop" actually is. Without
            # this the suite could only report "said nothing" and could not say
            # whether the agent was working or wedged.
            if isinstance(ev.get("reasoning_content"), str):
                reasoning.append(ev["reasoning_content"])
        elif name == "RunPaused":
            paused_ev = ev
        elif name in ("RunError", "RunCancelled"):
            error = str(ev.get("content") or name)[:200]
    return {
        "tools": tools,
        "content": "".join(content).strip(),
        "reasoning": "".join(reasoning).strip(),
        "paused": paused_ev,
        "error": error,
    }


def start(runtime, message, session_id, user_id):
    """`POST /agents/scout/runs`."""
    with runtime.start(message, session_id=session_id, user_id=user_id) as r:
        return _consume(r)


def answer_pause(runtime, paused, answers, session_id, user_id):
    """Resume a paused run.

    The whole ToolExecution is echoed back with only the target field given a
    value — dropping a field wipes it server-side, which is how the questions
    payload gets lost and the provider then rejects the dangling tool call.

    That is not just a comment any more. `ScriptedAgentRuntime.continue_run()`
    rebuilds the tool arguments from this payload the way the server does, and
    answers a resume that lost `questions_json` / `candidates_json` with a
    RunError. If this echo ever regresses to sending only the target field, the
    suite goes red instead of quietly accepting a payload production rejects.
    """
    run_id = paused["run_id"]
    agent_id = paused.get("agent_id") or "scout"
    payload = []
    for tool in paused.get("tools") or []:
        if not tool.get("requires_user_input"):
            continue
        schema = []
        for field in tool.get("user_input_schema") or []:
            f = dict(field)
            if f.get("name") in answers:
                f["value"] = answers[f["name"]]
            schema.append(f)
        echoed = dict(tool)
        echoed["user_input_schema"] = schema
        payload.append(echoed)

    with runtime.continue_run(run_id, agent_id, json.dumps(payload), session_id=session_id, user_id=user_id) as r:
        return _consume(r)


def decide(paused, plan):
    """Choose an answer for whatever the agent just asked.

    `plan` supplies the deliberate values a tester would type, so the assertion
    afterwards knows exactly what should appear in the document. Unchanged from
    the live suite, fallback warning and all.
    """
    described, answers = [], {}
    for tool in paused.get("tools") or []:
        if not tool.get("requires_user_input"):
            continue
        name = tool.get("tool_name") or ""
        args = tool.get("tool_args") or {}

        if name == "ask_questions":
            try:
                questions = json.loads(args.get("questions_json") or "[]", strict=False)
            except (ValueError, TypeError):
                questions = []
            picked = {}
            for q in questions:
                qid, text = q.get("id"), (q.get("text") or "")
                options = q.get("options") or []
                value = None
                for keyword, val in plan.get("answers", {}).items():
                    if keyword.lower() in text.lower():
                        value = val
                        break
                if value is None:
                    value = options[0] if options else plan.get("default_answer", "")
                picked[qid] = value
                described.append(f"{text.strip()} → {value}")
            answers["answers"] = json.dumps(picked)

        else:  # a person picker
            try:
                payload = json.loads(args.get("candidates_json") or "{}", strict=False)
            except (ValueError, TypeError):
                payload = {}
            candidates = payload.get("candidates") or []
            purpose = str(args.get("purpose") or "")
            chosen = None
            # `person_for` picks a DIFFERENT name per picker, matched on the
            # purpose text. A case that must distinguish two roles in one
            # conversation — the corporate representative and the signing
            # directors, say — cannot express that with a single `person`.
            want = plan.get("person")
            for needle, name in (plan.get("person_for") or {}).items():
                if needle.lower() in purpose.lower():
                    want = name
                    break
            if want:
                for c in candidates:
                    if want.lower() in str(c.get("name") or c.get("label") or "").lower():
                        chosen = c
                        break
            # ★ The harness's own first-candidate fallback is the same bug this
            # file exists to catch. If a case named a person and that person is
            # not on the list, silently taking candidates[0] can hand back
            # exactly the name the test is trying to prove absent, and the run
            # reads as a pass. Say so instead of hiding it.
            if chosen is None and candidates:
                chosen = candidates[0]
                if want:
                    described.append(
                        f"!! wanted {want!r} for {purpose or 'picker'} but it was not "
                        f"offered — harness fell back to {chosen.get('name') or chosen.get('label')!r}"
                    )
            if chosen is not None:
                answers["selected"] = json.dumps(chosen)
                described.append(f"{purpose or 'choose person'} → {chosen.get('name') or chosen.get('label')}")
    return answers, described


def docx_text(runtime, download_url):
    """Download the generated file and flatten `word/document.xml`.

    The runtime writes a real zip, so this is the same unzip-and-strip-tags path
    the live suite runs; only the transport is gone.
    """
    blob = runtime.download(download_url)
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        xml = z.read("word/document.xml").decode("utf-8", "replace")
    return re.sub(r"<[^>]+>", "", xml)


# ── registers ───────────────────────────────────────────────────────
# The boards the pickers offer. Transcribed from the case notes below, which is
# where the real distinctions live: who sits on which board is the whole point
# of E3, E4 and E5.

CITY_HOLDINGS_BOARD = ["MIN MIN", "SOE MOE THU", "WIN WIN TINT"]
CITY_MART_BOARD = ["KYAW THU SOE", "MIN MIN", "MYO MIN KYAW", "PHYOE MIN KYAW", "WIN WIN TINT"]
CM_FOODS_BOARD = ["MIN MIN", "SOE MOE THU", "WIN WIN TINT"]
COMMERCE_ACE_MEMBERS = ["WIN WIN TINT", "MIN MIN"]


def _cands(names):
    return [candidate(i + 1, n) for i, n in enumerate(names)]


CASES = [
    {
        "id": "E1",
        "prompt": "Prepare a shareholders meeting minutes for director appointment only for City Holdings",
        "company": "CITY HOLDINGS LIMITED",
        "person": "SOE MOE THU",
        "answers": {
            "meeting date": "2026-09-15",
            "pronoun": "he",
            "date": "2026-09-15",
            "auditor": "",
            "financial year": "",
        },
        "default_answer": "",
        # What must physically appear in the exported .docx.
        "expect_in_doc": ["SOE MOE THU", "CITY HOLDINGS LIMITED"],
        "script": [
            ToolCall("lookup_director_candidates", {"company_name": "CITY HOLDINGS LIMITED"}, result="ok"),
            Pick(
                "choose_director",
                "chair the meeting and sign the minutes",
                _cands(CITY_HOLDINGS_BOARD),
                company_name="CITY HOLDINGS LIMITED",
            ),
            Ask(
                [
                    {"id": "q_date", "text": "What is the meeting date?"},
                    {"id": "q_pronoun", "text": "Which pronoun should be used?", "options": ["he", "she", "they"]},
                ]
            ),
            Document(
                "{{company}}\n"
                "MINUTES OF SHAREHOLDERS MEETING\n"
                "Held on {{answer:meeting date}}\n"
                "Chaired by {{picked:chair}}, who signed these minutes.\n",
                filename="e1-minutes.docx",
            ),
            Complete("The minutes are ready."),
        ],
        "mutants": [
            # The tracker's literal complaint: it asked, the user answered, and
            # the answer never reached the document.
            (
                "answer-dropped",
                {
                    "template": "{{company}}\n"
                    "MINUTES OF SHAREHOLDERS MEETING\n"
                    "Held on {{answer:meeting date}}\n"
                    "Chaired by the chairman, who signed these minutes.\n"
                },
            ),
        ],
    },
    {
        "id": "E2",
        "prompt": "Prepare resignation letter of Daw Win Win Tint from City Holdings",
        "company": "CITY HOLDINGS LIMITED",
        "person": "WIN WIN TINT",
        "answers": {"date": "2026-09-20"},
        "default_answer": "",
        "expect_in_doc": ["WIN WIN TINT", "CITY HOLDINGS LIMITED"],
        # The golden script deliberately contains a SILENT STOP — a turn that
        # does tool work, streams reasoning and writes nothing to the user. The
        # browser recovers with a one-shot "continue" nudge and so does this
        # harness; without a case that reproduces it, that recovery path is dead
        # code and a regression in it reads as a product failure.
        "script": [
            ToolCall("lookup_register_candidates", {"search": "Win Win Tint"}, result="ok"),
            Text(reasoning="Found her. Next I need the effective date."),
            Complete(""),  # ← silent stop; harness nudges
            Pick(
                "choose_person_from_register",
                "the resigning director",
                _cands(CITY_HOLDINGS_BOARD),
                company_name="CITY HOLDINGS LIMITED",
            ),
            Ask([{"id": "q_date", "text": "What is the effective date of resignation?"}]),
            Document(
                "{{company}}\n"
                "LETTER OF RESIGNATION\n"
                "I, {{picked:resigning}}, resign as a director with effect from "
                "{{answer:date}}.\n",
                filename="e2-resignation.docx",
            ),
            Complete("The resignation letter is ready."),
        ],
        "mutants": [
            # A run that ends without ever producing a file. NO-DOC, not PASS.
            (
                "no-document",
                {
                    "script": [
                        ToolCall("lookup_register_candidates", {"search": "Win Win Tint"}, result="ok"),
                        Complete("I could not find that person on the register."),
                    ]
                },
            ),
        ],
    },
    {
        # The corporate-representative regression, end to end.
        #
        # CITY MART HOLDING COMPANY LIMITED has exactly one member: the CORPORATE
        # shareholder CITY HOLDINGS LIMITED. A consent given by that member is
        # signed by CITY HOLDINGS' own board, so somebody has to say WHICH of its
        # directors signs.
        #
        # Until 2026-08-06 nobody was asked. slot_resolver._corp_rep_resolvable
        # treated repeat_regions' last-resort fallback — the member's FIRST
        # DIRECTOR — as an already-answered question and suppressed the picker.
        # CITY HOLDINGS' directors[0] is MIN MIN, so MIN MIN signed, silently,
        # on all four Shareholders Resolution In Writing templates.
        #
        # The case therefore names a representative who is deliberately NOT the
        # first director, and asserts three separate things: that the question
        # was asked at all, that the chosen name is in the document, and that
        # MIN MIN is not. The last one is the real guard — a document naming the
        # right company and a confidently wrong signatory satisfies every
        # positive assertion while being exactly the defect.
        #
        # ⚠ Interpreting a MIN MIN hit: MIN MIN is a director of BOTH CITY MART
        # and CITY HOLDINGS, so presence is strong evidence but not proof of the
        # old bug. On a FAIL here, read the document and find WHICH slot the name
        # landed in before calling it a regression.
        "id": "E3",
        "prompt": (
            "Prepare a shareholders resolution in writing for director "
            "appointment for City Mart Holding Company Limited"
        ),
        "company": "CITY MART HOLDING COMPANY LIMITED",
        "person": "PHYOE MIN KYAW",
        "person_for": {"authoriz": "PHYOE MIN KYAW", "represent": "PHYOE MIN KYAW", "signator": "PHYOE MIN KYAW"},
        "answers": {"date": "2026-10-01", "new director": "AUNG KYAW MOE", "identification": "NRC", "pronoun": "he"},
        "default_answer": "",
        "expect_ask": ["authoriz|represent|signator"],
        "expect_in_doc": ["PHYOE MIN KYAW", "CITY HOLDINGS LIMITED"],
        "forbid_in_doc": ["MIN MIN"],
        # CITY MART has exactly ONE member. It signed twice for weeks — once
        # correctly through its representative, then again on the individual
        # line — and every other assertion in this case passed.
        "expect_count": {"CITY HOLDINGS LIMITED": 1},
        # …and the person on the representative line must be the person who was
        # CHOSEN. PHYOE MIN KYAW is also the appointed director here, so he is in
        # the document either way — which is exactly how two runs passed with
        # KYAW THU SOE (directors[0]) signing for the member.
        "expect_after": [{"marker": "represented by its authorized director", "value": "PHYOE MIN KYAW"}],
        # The offered board is CITY HOLDINGS', the corporate MEMBER's — not the
        # document company's. MIN MIN is deliberately first: he is what a
        # positional fallback reaches for, and what `first_candidate` mode
        # returns.
        "script": [
            ToolCall(
                "lookup_representative_candidates", {"corporate_shareholder_name": "CITY HOLDINGS LIMITED"}, result="ok"
            ),
            Pick(
                "choose_representative_director",
                "the authorized director to sign for the corporate member",
                _cands(["MIN MIN", "PHYOE MIN KYAW", "SOE MOE THU"]),
                company_name="CITY MART HOLDING COMPANY LIMITED",
            ),
            Ask(
                [
                    {"id": "q_date", "text": "What is the date of the resolution?"},
                    {"id": "q_pronoun", "text": "Which pronoun applies?", "options": ["he", "she"]},
                ]
            ),
            Document(
                "SHAREHOLDERS RESOLUTION IN WRITING\n"
                "{{company}}\n"
                "Dated {{answer:date}}\n"
                "Sole member: CITY HOLDINGS LIMITED, represented by its authorized "
                "director {{picked:authoriz}}.\n",
                filename="e3-resolution.docx",
            ),
            Complete("The resolution is ready."),
        ],
        "mutants": [
            # The historical bug itself: the choice is discarded and the member's
            # first director signs. Fires `forbid_in_doc` and `expect_after`
            # together, which is the pair that caught it.
            ("first-candidate", {"resolve_mode": "first_candidate"}),
            # The member signed twice — once through its representative, then
            # again on the individual line. Every positive assertion held;
            # nothing counted. This is what `expect_count` is for.
            (
                "signed-twice",
                {
                    "template": "SHAREHOLDERS RESOLUTION IN WRITING\n"
                    "{{company}}\n"
                    "Dated {{answer:date}}\n"
                    "Sole member: CITY HOLDINGS LIMITED, represented by its authorized "
                    "director {{picked:authoriz}}.\n"
                    "Signed: CITY HOLDINGS LIMITED\n"
                },
            ),
            # Nobody was asked at all — the picker never opened and the template
            # resolved the signatory itself. `expect_ask` is the only assertion
            # that sees this; the document alone can look fine.
            (
                "never-asked",
                {
                    "script": [
                        ToolCall("get_template", {"name": "Shareholders Resolution In Writing"}, result="ok"),
                        Ask([{"id": "q_date", "text": "What is the date of the resolution?"}]),
                        Document(
                            "SHAREHOLDERS RESOLUTION IN WRITING\n"
                            "{{company}}\n"
                            "Dated {{answer:date}}\n"
                            "Sole member: CITY HOLDINGS LIMITED, represented by its authorized "
                            "director MIN MIN.\n",
                            filename="e3-noask.docx",
                        ),
                        Complete("The resolution is ready."),
                    ]
                },
            ),
        ],
    },
    {
        # HARDEST. A corporate member TWO levels up, where the two boards are
        # genuinely different sets of people.
        #
        # CM FOODS' sole member is CITY MART HOLDING, a company, so CITY MART's
        # own board signs. CM FOODS' directors are MIN MIN, SOE MOE THU and
        # WIN WIN TINT; CITY MART's are KYAW THU SOE, MIN MIN, MYO MIN KYAW,
        # PHYOE MIN KYAW and WIN WIN TINT. SOE MOE THU therefore sits on the
        # DOCUMENT's board and NOT on the signing company's — he is exactly the
        # person the board guard exists to keep off that line, and he is the one
        # a positional fallback over the wrong company would reach for.
        #
        # KYAW THU SOE is the mirror: on CITY MART's board, NOT a CM FOODS
        # director. A guard that simply preferred "someone from this document's
        # company" would reject him wrongly, so the case asserts he IS accepted.
        "id": "E4",
        "prompt": (
            "Prepare a shareholders resolution in writing for director appointment for CM Foods Company Limited"
        ),
        "company": "CM FOODS COMPANY LIMITED",
        "person": "KYAW THU SOE",
        "person_for": {
            "authoriz": "KYAW THU SOE",
            "represent": "KYAW THU SOE",
            "signator": "KYAW THU SOE",
            "new director": "MYO MIN KYAW",
            "appoint": "MYO MIN KYAW",
        },
        "answers": {"date": "2026-11-05", "identification": "NRC", "pronoun": "he"},
        "default_answer": "",
        "expect_ask": ["authoriz|represent|signator"],
        "expect_in_doc": ["KYAW THU SOE", "CITY MART HOLDING COMPANY LIMITED"],
        # A CM FOODS director who is NOT on CITY MART's board. If he appears at
        # all in a document whose only signatory is CITY MART's representative,
        # the wrong register was consulted.
        "forbid_in_doc": ["SOE MOE THU"],
        "expect_count": {"CITY MART HOLDING COMPANY LIMITED": 1},
        "expect_after": [{"marker": "represented by its authorized director", "value": "KYAW THU SOE"}],
        "script": [
            ToolCall(
                "lookup_representative_candidates",
                {"corporate_shareholder_name": "CITY MART HOLDING COMPANY LIMITED"},
                result="ok",
            ),
            Pick(
                "choose_representative_director",
                "the authorized director signing for the corporate member",
                _cands(CITY_MART_BOARD),
                company_name="CM FOODS COMPANY LIMITED",
            ),
            Pick(
                "choose_person_from_register",
                "the new director to appoint",
                _cands(CITY_MART_BOARD),
                company_name="CM FOODS COMPANY LIMITED",
            ),
            Ask([{"id": "q_date", "text": "What is the date of the resolution?"}]),
            Document(
                "SHAREHOLDERS RESOLUTION IN WRITING\n"
                "{{company}}\n"
                "Dated {{answer:date}}\n"
                "Sole member: CITY MART HOLDING COMPANY LIMITED, represented by its "
                "authorized director {{picked:authoriz}}.\n"
                "RESOLVED that {{picked:appoint}} be appointed a director.\n",
                filename="e4-resolution.docx",
            ),
            Complete("The resolution is ready."),
        ],
        "mutants": [
            # The wrong register: the picker offers CM FOODS' OWN board, so
            # KYAW THU SOE — the person the case named — is not on the list at
            # all. Two guards must fire together: the harness must announce its
            # fallback rather than hide it, and SOE MOE THU (that board's first
            # entry) must be caught by `forbid_in_doc`.
            (
                "wrong-register",
                {
                    "script": [
                        ToolCall(
                            "lookup_representative_candidates",
                            {"corporate_shareholder_name": "CM FOODS COMPANY LIMITED"},
                            result="ok",
                        ),
                        Pick(
                            "choose_representative_director",
                            "the authorized director signing for the corporate member",
                            _cands(CM_FOODS_BOARD),
                            company_name="CM FOODS COMPANY LIMITED",
                        ),
                        Pick(
                            "choose_person_from_register",
                            "the new director to appoint",
                            _cands(CITY_MART_BOARD),
                            company_name="CM FOODS COMPANY LIMITED",
                        ),
                        Ask([{"id": "q_date", "text": "What is the date of the resolution?"}]),
                        Document(
                            "SHAREHOLDERS RESOLUTION IN WRITING\n"
                            "{{company}}\n"
                            "Dated {{answer:date}}\n"
                            "Sole member: CITY MART HOLDING COMPANY LIMITED, represented by its "
                            "authorized director {{picked:authoriz}}.\n"
                            "RESOLVED that {{picked:appoint}} be appointed a director.\n",
                            filename="e4-wrongreg.docx",
                        ),
                        Complete("The resolution is ready."),
                    ]
                },
            ),
        ],
    },
    {
        # The contrast that makes E3/E4 mean something. Two members, both
        # people, so the corporate row group must be DELETED outright — no
        # representative line at all. Without this, a bug that collapsed every
        # member list to a single corporate block would still pass E3 and E4.
        "id": "E5",
        "prompt": (
            "Prepare a shareholders resolution in writing for director appointment for Commerce Ace Company Limited"
        ),
        "company": "COMMERCE ACE COMPANY LIMITED",
        "person": "WIN WIN TINT",
        "person_for": {"new director": "MYO MIN KYAW", "appoint": "MYO MIN KYAW"},
        "answers": {"date": "2026-11-12", "identification": "NRC", "pronoun": "she"},
        "default_answer": "",
        "expect_in_doc": ["WIN WIN TINT", "MIN MIN", "COMMERCE ACE COMPANY LIMITED"],
        # Neither member is a company, so this template row must not survive.
        "forbid_in_doc": ["Represented by its authorized director"],
        "expect_count": {"WIN WIN TINT": 1, "MIN MIN": 1},
        "script": [
            ToolCall("lookup_attendee_candidates", {"company_name": "COMMERCE ACE COMPANY LIMITED"}, result="ok"),
            Pick(
                "choose_person_from_register",
                "the new director to appoint",
                _cands(CITY_MART_BOARD),
                company_name="COMMERCE ACE COMPANY LIMITED",
            ),
            Ask([{"id": "q_date", "text": "What is the date of the resolution?"}]),
            Document(
                "SHAREHOLDERS RESOLUTION IN WRITING\n"
                "{{company}}\n"
                "Dated {{answer:date}}\n"
                "Members: WIN WIN TINT and MIN MIN.\n"
                "RESOLVED that {{picked:appoint}} be appointed a director.\n",
                filename="e5-resolution.docx",
            ),
            Complete("The resolution is ready."),
        ],
        "mutants": [
            # Every member list collapsed to a corporate block: the row that
            # should have been deleted is rendered for a company with no
            # corporate member at all.
            (
                "corporate-row-survived",
                {
                    "template": "SHAREHOLDERS RESOLUTION IN WRITING\n"
                    "{{company}}\n"
                    "Dated {{answer:date}}\n"
                    "Members: WIN WIN TINT and MIN MIN.\n"
                    "Represented by its authorized director WIN WIN TINT.\n"
                    "RESOLVED that {{picked:appoint}} be appointed a director.\n"
                },
            ),
        ],
    },
]


CASES.append(
    {
        # ★ Not a product case — a case about the HARNESS, on the harness's own
        # main path.
        #
        # `run_case` finds the generated file by regex over the reply, and every
        # other case here is separated from its link by a newline the runtime
        # supplies. That made the extraction pattern untested: the suite passed with
        # an unanchored regex simply because no fixture ever put a word against the
        # URL. It is not hypothetical — the first run of this suite ERRORed all five
        # goldens on "no scripted document at '…e1-minutes.docxThe'", and every
        # mutant then "failed" for that reason instead of its own.
        #
        # `trailing=""` reproduces exactly that shape. The case is otherwise an
        # ordinary conversation, so it exercises the real path: RunPaused -> resume
        # -> link extraction -> download -> unzip -> assert. If the anchor is ever
        # removed from the regex, this goes NO-DOC or ERROR and says so.
        "id": "E6",
        "prompt": "Prepare a resignation letter for Golden Lotus Holdings",
        "company": "GOLDEN LOTUS HOLDINGS LIMITED",
        "person": "FICTIONAL PARTY TWO",
        "answers": {"date": "2026-12-01"},
        "default_answer": "",
        "expect_in_doc": ["FICTIONAL PARTY TWO", "GOLDEN LOTUS HOLDINGS LIMITED"],
        "script": [
            ToolCall("lookup_register_candidates", {"search": "resigning director"}, result="ok"),
            Pick(
                "choose_person_from_register",
                "the resigning director",
                _cands(["FICTIONAL PARTY ONE", "FICTIONAL PARTY TWO"]),
                company_name="GOLDEN LOTUS HOLDINGS LIMITED",
            ),
            Ask([{"id": "q_date", "text": "What is the effective date of resignation?"}]),
            Document(
                "{{company}}\n"
                "LETTER OF RESIGNATION\n"
                "I, {{picked:resigning}}, resign with effect from {{answer:date}}.\n",
                filename="e6-resignation.docx",
                trailing="",  # ← the next chunk lands FLUSH against the URL
            ),
            Complete("The resignation letter is ready."),
        ],
        "mutants": [
            # Same flush link, but the document drops the chosen person. Proves E6
            # still asserts on CONTENT and is not merely a link-extraction probe
            # that would pass on any document at all.
            (
                "answer-dropped",
                {
                    "template": "{{company}}\n"
                    "LETTER OF RESIGNATION\n"
                    "I, the undersigned, resign with effect from {{answer:date}}.\n"
                },
            ),
        ],
    }
)


def _build_runtime(case, overrides):
    """One runtime per run. `overrides` is how a mutant is expressed.

    Only three things can be overridden, and none of them is an assertion:
      script        a different conversation
      template      a different document, same conversation
      resolve_mode  the same conversation and template, resolved the buggy way
    """
    script = list(overrides.get("script") or case["script"])
    template = overrides.get("template")
    if template is not None:
        # `trailing` is carried through deliberately. E6's whole point is the
        # link arriving flush against the next chunk; rebuilding the Document
        # without it would quietly restore the newline and the mutant would stop
        # testing the shape the case exists for.
        script = [
            Document(template, filename=t.filename, tool_name=t.tool_name, trailing=t.trailing)
            if isinstance(t, Document)
            else t
            for t in script
        ]
    return ScriptedAgentRuntime(
        script,
        company=case["company"],
        resolve_mode=overrides.get("resolve_mode", "chosen"),
    )


def run_case(case, variant="golden", overrides=None):
    session = f"E2E {case['id']} — {variant}"
    runtime = _build_runtime(case, overrides or {})
    print(f"\n{'-' * 76}\n[{case['id']}/{variant}] {case['prompt'][:70]}", flush=True)

    result = start(runtime, case["prompt"], session, 1)
    transcript = []
    nudges = 0

    for _turn in range(MAX_TURNS):
        if result["error"]:
            return {"status": "ERROR", "detail": result["error"], "session": session}

        if result["paused"]:
            answers, described = decide(result["paused"], case)
            if not answers:
                break
            for d in described:
                print(f"  answered: {d}", flush=True)
                transcript.append(d)
            result = answer_pause(runtime, result["paused"], answers, session, 1)
            continue

        # Silent stop: the agent did tool work then ended the turn with nothing
        # to say. The browser handles this with a one-shot "continue" nudge, so
        # the harness has to as well or it reports a false failure.
        if not result["content"] and result["tools"] and nudges < 5:
            nudges += 1
            rz = result.get("reasoning") or ""
            print(
                f"  (silent stop {nudges} — content 0 chars, reasoning {len(rz)} chars, "
                f"after {result['tools'][-1] if result['tools'] else '?'}) "
                + (f"thought: {rz[:110].replace(chr(10), ' ')}…" if rz else "NO reasoning either — genuinely wedged"),
                flush=True,
            )
            result = start(runtime, "continue", session, 1)
            continue

        break

    body = result["content"]
    # Both alternatives anchor on `.docx`. `content` is the concatenation of
    # every RunContent chunk, so a link arriving flush against the next chunk
    # ("…e1-minutes.docxThe minutes are ready.") must not have the following
    # word swallowed into the path — that yields a path nothing can download and
    # the case reports ERROR for a reason that has nothing to do with the
    # product.
    #
    # ★ Unlike the live suite, the first alternative here is NOT dead: the
    # scripted runtime emits exactly `/api/documents/download/…`
    # (scripted_runtime.py:561), so this is the file where the greedy version
    # can actually fire. It did, on the very first run of this suite: all five
    # goldens ERRORed with "no scripted document at '…e1-minutes.docxThe'".
    #
    # The anchor is pinned by case E6, which puts a word flush against the link
    # on purpose. A comment alone would not survive the next fixture.
    m = re.search(r"(/api/documents/download/[^\s)\"']+?\.docx|/documents/[^\s)\"']+?\.docx)", body)
    if not m:
        return {
            "status": "NO-DOC",
            "detail": f"no download link; reply={body[:120]!r}",
            "session": session,
            "answered": transcript,
        }

    try:
        text = docx_text(runtime, m.group(1))
    except Exception as e:
        return {"status": "ERROR", "detail": f"could not read docx: {e}", "session": session, "answered": transcript}

    missing = [v for v in case["expect_in_doc"] if v.lower() not in text.lower()]

    # A name that must NOT be in the document. Presence alone is not proof of
    # correctness when the failure mode is substituting a plausible person: the
    # old corporate-representative path resolved to the member company's FIRST
    # DIRECTOR without asking, and a document containing the right company and a
    # confidently wrong signatory passes every positive assertion there is.
    forbidden = [v for v in case.get("forbid_in_doc", []) if v.lower() in text.lower()]

    # A party may appear only as many times as it is entitled to sign. E3 passed
    # while its document was WRONG: a company with one corporate member rendered
    # two signature blocks — the member through its representative, then again on
    # the individual line — because the signature table was never expanded and
    # both slots fell through to the flat per-company fill. Every positive
    # assertion held; nothing counted.
    overcounted = []
    for needle, want in (case.get("expect_count") or {}).items():
        got = text.lower().count(needle.lower())
        if got != want:
            overcounted.append(f"{needle!r} x{got} (want {want})")

    # A name has to be on the RIGHT LINE, not merely somewhere in the document.
    # E3 passed twice with the wrong person on the representative line, because
    # the person it names is also the appointed director and so appears anyway.
    # `expect_after` pins a value to the text that follows a marker.
    misplaced = []
    for spec in case.get("expect_after") or []:
        marker, value = spec["marker"].lower(), spec["value"].lower()
        window = spec.get("within", 160)
        low = text.lower()
        at = low.find(marker)
        if at < 0:
            misplaced.append(f"marker {spec['marker']!r} not in document")
        elif value not in low[at + len(marker) : at + len(marker) + window]:
            near = text[at + len(marker) : at + len(marker) + window]
            near = " ".join(near.split())[:60]
            misplaced.append(f"{spec['value']!r} not after {spec['marker']!r} (found: {near!r})")

    # Some questions must actually be PUT to the user. If the agent stops asking
    # and starts assuming again, the document can still come out looking fine.
    # An entry may list alternatives as "a|b|c": the model's WORDING varies run to
    # run ("authorized director" / "signatory" / "representative") while the
    # question being asked is the same one, and pinning one spelling fails the
    # case for a reason that has nothing to do with the product.
    joined = " | ".join(transcript).lower()
    unasked = [v for v in case.get("expect_ask", []) if not any(alt in joined for alt in v.lower().split("|"))]

    # The harness announcing its own fallback means the person the case named was
    # never offered — the run proves nothing about who gets chosen.
    fell_back = [t for t in transcript if t.startswith("!!")]

    problems = []
    if missing:
        problems.append(f"missing from document: {missing}")
    if forbidden:
        problems.append(f"FORBIDDEN name present in document: {forbidden}")
    if overcounted:
        problems.append(f"wrong number of occurrences: {overcounted}")
    if misplaced:
        problems.append(f"right name, wrong line: {misplaced}")
    if unasked:
        problems.append(f"never asked about: {unasked}")
    if fell_back:
        problems.append(f"harness fallback fired: {fell_back}")

    return {
        "status": "PASS" if not problems else "FAIL",
        "detail": ("all answers present in the .docx" if not problems else " · ".join(problems))
        + f" · {nudges} silent stop(s) had to be nudged",
        "session": session,
        "answered": transcript,
        "file": m.group(1),
        "nudges": nudges,
    }


def protocol_checks():
    """Branches no case script reaches. Each returns (name, want_status, thunk)."""

    def failed_run():
        rt = ScriptedAgentRuntime(
            [ToolCall("get_template", {}, result="ok"), Error("provider rejected the dangling tool call")],
            company="CITY HOLDINGS LIMITED",
        )
        return _consume(rt.start("probe", session_id="protocol", user_id=1))["error"]

    def dropped_field():
        """A resume that echoes back ONLY the answered field.

        This is the mistake `answer_pause`'s docstring warns about. The server
        wipes the fields that did not come back and the provider then rejects the
        dangling tool call, so the correct outcome is a RunError — not a run that
        carries on with an empty questions payload.
        """
        rt = ScriptedAgentRuntime(
            [Ask([{"id": "q1", "text": "What is the meeting date?"}]), Complete("done")],
            company="CITY HOLDINGS LIMITED",
        )
        paused = _consume(rt.start("probe", session_id="protocol", user_id=1))["paused"]
        stripped = [
            {
                "tool_name": "ask_questions",
                "requires_user_input": True,
                "user_input_schema": [{"name": "answers", "value": '{"q1": "x"}'}],
            }
        ]
        out = _consume(rt.continue_run(paused["run_id"], "scout", json.dumps(stripped)))
        return out["error"]

    return [
        ("failed-run", "provider rejected the dangling tool call", failed_run),
        ("dropped-field", "dangling tool call: questions_json was dropped from the resume payload", dropped_field),
    ]


def main():
    # Optional case-id filter: `python3 tests/tracker_layer3.py E3`.
    wanted = {a.upper() for a in sys.argv[1:] if not a.startswith("-")}
    cases = [c for c in CASES if not wanted or c["id"].upper() in wanted]
    if wanted and not cases:
        sys.exit(f"No case matched {sorted(wanted)}; have {[c['id'] for c in CASES]}")

    rows = []
    failures = 0
    for case in cases:
        runs = [("golden", "PASS", {})]
        for name, overrides in case.get("mutants", []):
            # A mutant must not come out PASS. Which non-PASS status it lands on
            # is recorded but not pinned: NO-DOC and FAIL are both "this run did
            # not prove the product correct", and pinning the exact one would
            # make the check brittle for no gain.
            runs.append((name, "not-PASS", overrides))

        for variant, want, overrides in runs:
            try:
                out = run_case(case, variant, overrides)
            except Exception as e:
                out = {"status": "ERROR", "detail": f"{type(e).__name__}: {e}"[:140], "session": "-"}
            ok = (out["status"] == "PASS") if want == "PASS" else (out["status"] != "PASS")
            if not ok:
                failures += 1
            rows.append((f"{case['id']}/{variant}", out["status"], want, ok, out["detail"]))
            print(
                f"  -> {out['status']} (want {want}) {'OK' if ok else '<<< SUITE FAILURE'}: {out['detail'][:110]}",
                flush=True,
            )

    if not wanted:
        print(f"\n{'-' * 76}\nprotocol checks", flush=True)
        for name, want_text, thunk in protocol_checks():
            got = thunk()
            ok = got == want_text
            if not ok:
                failures += 1
            rows.append((name, "ok" if ok else "BAD", want_text[:28], ok, str(got)[:90]))
            print(f"  {name:<14} {'OK' if ok else '<<< SUITE FAILURE'}: {got!r}", flush=True)

    print(f"\n\n{'CASE':<28} {'GOT':<8} {'WANT':<10} {'':<4} DETAIL")
    print("-" * 110)
    for name, status, want, ok, detail in rows:
        print(f"{name:<28} {status:<8} {want[:10]:<10} {'ok' if ok else 'BAD':<4} {detail[:56]}")

    print(f"\nSUMMARY: {len(rows)} checks · {failures} unexpected")
    if failures:
        print(
            "A mutant that came out PASS means the assertion it targets no longer "
            "discriminates — treat it as a broken gate, not a flake."
        )
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
