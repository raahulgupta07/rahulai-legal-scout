"""
Unit tests — pure logic, no server, no LLM, no network.

The three tracker layers all talk to a running app, and layers 2 and 3 talk to
the model, so they are slow and (for 2 and 3) non-deterministic. This layer
covers the decision logic underneath them: placeholder normalisation, slot
classification, session scoping, the person guard, party coercion, and the
structural contracts that have silently broken the product before.

Every case here is deterministic. A failure is a real regression.

Run (inside the container, which has the dependencies):

    docker exec scout-api python3 /app/tests/test_units.py

Or after `docker cp tests/test_units.py scout-api:/app/tests/`.

Only a live DB connection is needed for the import to succeed (see BOOTSTRAP);
no test reads or writes application data.
"""

import json
import re
import sys
from pathlib import Path

# --- BOOTSTRAP -------------------------------------------------------------
# `import scout.tools.<x>` alone raises ImportError: scout/__init__ imports
# scout.agent, which reaches db -> app.model_config -> app/__init__ -> app.main
# -> scout.agent (partially initialised). Importing app.main FIRST establishes
# the same order uvicorn uses and breaks the cycle. This is why the suite runs
# in the container rather than on the host.
sys.path.insert(0, "/app")
import app.main  # noqa: F401,E402  — import for its side effect on module order

from scout.tools.field_aliases import (  # noqa: E402
    canonical_field,
    normalize_field,
    tokens_match,
)
from scout.tools.placeholders import (  # noqa: E402
    is_empty_placeholder,
    new_empty_counter,
    placeholder_name,
)
from scout.tools import ask_questions as aq  # noqa: E402
from scout.tools import fill_view as fv  # noqa: E402
from scout.tools import people_picker as pp  # noqa: E402
from scout.tools import repeat_regions as rr  # noqa: E402
from scout.tools import slot_resolver as sr  # noqa: E402

REPO = Path("/app")

_results = []


def check(case_id: str, name: str, passed: bool, detail: str = ""):
    _results.append((case_id, "PASS" if passed else "FAIL", name, detail))


def eq(case_id: str, name: str, got, want):
    check(case_id, name, got == want, f"got {got!r}, want {want!r}")


# ===========================================================================
# U1  Placeholder normalisation
#     Word writes non-breaking spaces INSIDE placeholder names in five of the
#     client's templates. A different string from the normal-space spelling, so
#     every alias and field_mapping written by hand missed and the field came
#     out blank.
# ===========================================================================
def test_placeholders():
    eq("U1a", "U+00A0 inside a placeholder folds to a normal space",
       placeholder_name(("individual\xa0shareholder_1_name", None, None)),
       "individual shareholder_1_name")
    eq("U1b", "zero-width space is stripped",
       placeholder_name(("director​_name", None, None)), "director_name")
    eq("U1c", "an ordinary name is untouched",
       placeholder_name(("meeting_date", None, None)), "meeting_date")
    eq("U1d", "surrounding whitespace is trimmed",
       placeholder_name(("  chairperson_name  ", None, None)), "chairperson_name")
    eq("U1e", "the second capture group is used when the first is empty",
       placeholder_name((None, "company_name", None)), "company_name")

    counter = new_empty_counter()
    first = placeholder_name((None, None, None), counter)
    second = placeholder_name((None, None, None), counter)
    check("U1f", "bare slots get distinct synthetic names",
          bool(first) and bool(second) and first != second, f"{first!r} then {second!r}")
    eq("U1g", "a bare slot with no counter stays empty",
       placeholder_name((None, None, None)), "")
    check("U1h", "is_empty_placeholder recognises a synthetic name",
          is_empty_placeholder(first), f"{first!r}")


# ===========================================================================
# U2  Field aliases
# ===========================================================================
def test_field_aliases():
    eq("U2a", "spaces and case normalise", normalize_field("Company Name"), "company_name")
    eq("U2b", "normalising is idempotent", normalize_field("company_name"), "company_name")
    eq("U2c", "normalising folds U+00A0 too",
       normalize_field("individual\xa0shareholder_1_name"), "individual_shareholder_1_name")
    eq("U2d", "canonical_field maps a known alias", canonical_field("nrc"), "nrc_no")
    check("U2e", "tokens_match does not equate a numbered slot with the generic key",
          tokens_match("shareholder_1_name", "shareholder_name") is False, "")


# ===========================================================================
# U3  Slot kind classification
#     PICKER_SLOT_KINDS used to stamp every pick "signatory", and the patterns
#     only matched snake_case. A prose purpose fell through to the catch-all, so
#     a person chosen as the INCOMING director appeared on the NEXT document's
#     resignation line.
# ===========================================================================
def test_classify_kind():
    cases = [
        ("U3a", "select the new director to be appointed", "new_director"),
        ("U3b", "the director being appointed", "new_director"),
        ("U3c", "choose the resigning director", "resigning_director"),
        ("U3d", "the outgoing director", "resigning_director"),
        ("U3e", "who will chair the meeting", "chairperson"),
        ("U3f", "authorised person to represent the shareholder", "representative"),
        ("U3g", "persons present at the meeting", "attendee"),
        ("U3h", "the auditor for the year", "auditor"),
        ("U3i", "sign the AGM resolution", "signatory"),
    ]
    for cid, text, want in cases:
        eq(cid, f"prose purpose {text!r}", sr.classify_kind(text), want)

    eq("U3j", "an unrelated string classifies as unknown, not a guess",
       sr.classify_kind("the meeting date"), "")
    eq("U3k", "empty input classifies as unknown", sr.classify_kind(""), "")
    check("U3l", "resigning outranks the generic director pattern",
          sr.classify_kind("director resigning from the board") == "resigning_director", "")


# ===========================================================================
# U4  Session scope
#     A pick belongs to ONE conversation. Before session_id existed, any pick
#     for the same company within 30 minutes was reusable by any other chat.
# ===========================================================================
def test_session_scope():
    eq("U4a", "no scope bound by default", sr.current_session_scope(), "")

    with sr.session_scope("sess-A"):
        eq("U4b", "scope is visible inside the block", sr.current_session_scope(), "sess-A")
        with sr.session_scope("sess-B"):
            eq("U4c", "scopes nest", sr.current_session_scope(), "sess-B")
        eq("U4d", "the outer scope is restored", sr.current_session_scope(), "sess-A")
    eq("U4e", "scope is cleared on exit", sr.current_session_scope(), "")

    try:
        with sr.session_scope("sess-boom"):
            raise RuntimeError("generation blew up")
    except RuntimeError:
        pass
    eq("U4f", "scope is cleared even when the block raises", sr.current_session_scope(), "")

    with sr.session_scope(None):
        eq("U4g", "None scope reads as empty", sr.current_session_scope(), "")
    with sr.session_scope("  padded  "):
        eq("U4h", "scope is stripped", sr.current_session_scope(), "padded")

    # The read-back must refuse to answer with no conversation in scope: that is
    # the Fill-in view, which supplies its own values and must inherit nothing.
    slot = {"kind": "new_director", "of": "people_register"}
    eq("U4i", "picker log returns nothing when no session is in scope",
       sr._parties_from_picker_log("ANY COMPANY LIMITED", slot), [])


# ===========================================================================
# U5  Companion identifier — an NRC belongs to a person
#     `new_director_name` is a slot answered by a picker; training classifies
#     `new_director_identification_number` as user_input, so it was asked as free
#     text. The two halves of one person resolved from different sources and the
#     document went out reading "SOE MOE THU (... NRC/Passport number: )".
# ===========================================================================
def test_companion_identifier():
    ident = [
        ("U5a", "new_director_identification_number", "new_director"),
        ("U5b", "new_director_nrc", "new_director"),
        ("U5c", "director_passport_no", "director"),
        ("U5d", "resigning_director_nrc_passport_no", "resigning_director"),
        ("U5e", "shareholder_1_id_number", "shareholder_1"),
        ("U5f", "individual\xa0shareholder_1_nrc", "individual shareholder_1"),
    ]
    for cid, ph, want in ident:
        eq(cid, f"identifier role of {ph!r}", sr._role_prefix(ph, sr._IDENTIFIER_ATTR_RE), want)

    # Numbers that belong to a COMPANY must never be treated as a person's.
    for cid, ph in [
        ("U5g", "company_registration_number"),
        ("U5h", "certificate_of_incorporation_number"),
        ("U5i", "share_certificate_number"),
        ("U5j", "registration_number"),
        ("U5k", "meeting_date"),
    ]:
        eq(cid, f"{ph!r} is not a person identifier",
           sr._role_prefix(ph, sr._IDENTIFIER_ATTR_RE), "")

    mapping = {
        "new_director_name": {"source": "slot",
                              "slot": {"of": "people_register", "kind": "new_director", "multi": False}},
        "new_director_identification_number": {"source": "user_input", "slot": None},
    }
    person = {"name": "SOE MOE THU", "identifier": "12/SAKHANA(N)021426", "party_type": "individual"}

    eq("U5l", "the NRC comes from the person the name slot resolved to",
       sr.companion_identifier("new_director_identification_number", mapping,
                               {"new_director_name": person}),
       "12/SAKHANA(N)021426")
    eq("U5m", "no resolved person means the field is still asked",
       sr.companion_identifier("new_director_identification_number", mapping, {}), None)
    eq("U5n", "a person with no identifier on file does not fabricate one",
       sr.companion_identifier("new_director_identification_number", mapping,
                               {"new_director_name": {"name": "NO NRC PERSON"}}), None)
    eq("U5o", "a non-identifier placeholder is left alone",
       sr.companion_identifier("meeting_date", mapping, {"new_director_name": person}), None)
    eq("U5p", "a company registration number is not answered from a person",
       sr.companion_identifier("company_registration_number", mapping,
                               {"new_director_name": person}), None)


# ===========================================================================
# U6  Party coercion — whatever a picker or the model hands back
# ===========================================================================
def test_party_coercion():
    eq("U6a", "a dict becomes one party",
       sr._coerce_parties({"name": "A B", "identifier": "X1"}),
       [{"name": "A B", "identifier": "X1", "party_type": "individual", "representative": ""}])
    eq("U6b", "a list of names becomes many parties",
       [p["name"] for p in sr._coerce_parties(["A", "B"])], ["A", "B"])
    eq("U6c", "TBD is not a person", sr._coerce_parties("TBD"), [])
    eq("U6d", "empty input yields no parties", sr._coerce_parties(""), [])
    eq("U6e", "None yields no parties", sr._coerce_parties(None), [])
    eq("U6f", "a JSON string is parsed",
       [p["name"] for p in sr._coerce_parties('[{"name": "C D"}]')], ["C D"])
    eq("U6g", "an unanswered picker payload yields no parties",
       sr._coerce_parties({"candidates": [{"name": "X"}]}), [])
    eq("U6h", "nrc_passport_no is accepted as the identifier",
       sr._coerce_parties({"name": "E F", "nrc_passport_no": "9/ABC(N)1"})[0]["identifier"], "9/ABC(N)1")

    eq("U6i", "slot_of returns None for a non-slot entry", sr.slot_of({"source": "user_input"}), None)
    eq("U6j", "slot_of returns the descriptor for a slot entry",
       sr.slot_of({"source": "slot", "slot": {"kind": "signatory"}}), {"kind": "signatory"})
    eq("U6k", "a slot entry with no kind is not a slot",
       sr.slot_of({"source": "slot", "slot": {}}), None)


# ===========================================================================
# U7  Person guard — a human is chosen from the register, never typed
# ===========================================================================
def test_person_guard():
    must_block = [
        ("U7a", "What is the full legal name of the new director being appointed?"),
        ("U7b", "What is the NRC or Passport number of the new director?"),
        ("U7c", "Who will sign the minutes?"),
        ("U7d", "What is the name of the resigning director?"),
        ("U7e", "Please provide the chairperson name"),
        ("U7f", "What is the shareholder name?"),
        ("U7g", "What is the passport number of the signatory?"),
    ]
    for cid, q in must_block:
        role = aq._person_role(q)
        check(cid, f"blocked: {q}", role is not None, f"role={role!r}")
        if role is not None:
            check(cid + "-p", "the blocked question names a real picker pair",
                  role in aq._PICKER_FOR_ROLE, f"role={role!r}")

    must_allow = [
        ("U7h", "What is the proposed name of the new company?"),
        ("U7i", "What is the primary business sector for the new company?"),
        ("U7j", "What is the meeting date?"),
        ("U7k", "What is the financial year end date?"),
        ("U7l", "What is the chairperson pronoun?"),
        ("U7m", "Generate Director Resignation Letter for CITY HOLDINGS LIMITED now?"),
        ("U7n", "Which company is this shareholder consent form being prepared for?"),
        ("U7o", "What is the capital subscription amount?"),
        ("U7p", "How many shares will be subscribed?"),
        ("U7q", "What is the company name?"),
        ("U7r", "What is the template name?"),
        ("U7s", "What is the registered office address?"),
    ]
    for cid, q in must_allow:
        role = aq._person_role(q)
        check(cid, f"allowed: {q}", role is None, f"role={role!r}")

    # A batch with both kinds must not be thrown away wholesale.
    questions = [
        {"id": "q0", "text": "What is the meeting date?"},
        {"id": "q1", "text": "What is the name of the new director?"},
        {"id": "q2", "text": "What is the financial year end date?"},
    ]
    allowed, blocked = aq._split_person_questions(questions)
    eq("U7t", "mixed batch keeps the legitimate questions", allowed, ["q0", "q2"])
    eq("U7u", "mixed batch blocks only the person question",
       [b["id"] for b in blocked], ["q1"])
    check("U7v", "a blocked question names the tools to call instead",
          bool(blocked) and len(blocked[0].get("call_instead") or []) == 2,
          str(blocked[0].get("call_instead") if blocked else None))

    # A question offering options is a constrained pick, not free text.
    with_options = [{"id": "q0", "text": "Which director should sign?",
                     "options": ["A", "B"]}]
    allowed_o, blocked_o = aq._split_person_questions(with_options)
    eq("U7w", "an option-bearing question is left alone", (allowed_o, blocked_o), (["q0"], []))

    eq("U7x", "answers for blocked questions are dropped",
       aq._filter_answers({"q0": "2026-09-15", "q1": "Typed Name"}, questions, ["q0", "q2"]),
       {"q0": "2026-09-15"})
    eq("U7y", "id-keyed answer lists are filtered the same way",
       aq._filter_answers([{"id": "q0", "answer": "x"}, {"id": "q1", "answer": "y"}],
                          questions, ["q0", "q2"]),
       [{"id": "q0", "answer": "x"}])
    eq("U7z", "an unrecognised answer shape passes through untouched",
       aq._filter_answers("just a string", questions, ["q0"]), "just a string")


# ===========================================================================
# U8  Picker payload — how a paused tool learns its conversation
#     A requires_user_input tool CANNOT take run_context: agno builds its
#     user_input_schema from every signature parameter, the frontend echoes the
#     whole schema back on resume, and the injected copy collides with it
#     ("got multiple values for keyword argument 'run_context'"). The lookup
#     tools, which never pause, carry the session in their payload instead.
# ===========================================================================
def test_picker_payload():
    payload = pp._payload(picker="choose_director", candidates=[], session="sess-42")
    eq("U8a", "the lookup payload carries the session", payload.get("session"), "sess-42")
    eq("U8b", "the picker reads the session back out",
       pp._session_from_payload(json.dumps(payload)), "sess-42")
    eq("U8c", "a dict payload works as well as a JSON string",
       pp._session_from_payload(payload), "sess-42")
    eq("U8d", "malformed JSON yields no session rather than raising",
       pp._session_from_payload("{not json"), "")
    eq("U8e", "an absent session field yields empty",
       pp._session_from_payload('{"candidates": []}'), "")
    eq("U8f", "None yields empty", pp._session_from_payload(None), "")
    eq("U8g", "a non-object payload yields empty", pp._session_from_payload("[1,2,3]"), "")

    eq("U8h", "a prose purpose is recorded under the role it names",
       pp._classify_purpose("select the new director to be appointed"), "new_director")

    cand = pp._candidate(person_id=7, name="A B", identifier="1/AB(N)2")
    eq("U8i", "a candidate keeps its identifier so the NRC travels with the pick",
       cand["identifier"], "1/AB(N)2")
    eq("U8j", "a candidate is individual unless told otherwise", cand["party_type"], "individual")


# ===========================================================================
# U9  Repeat regions — grow/shrink party blocks to the real count
# ===========================================================================
def test_repeat_regions():
    eq("U9a", "'name' is checked before 'share' so shareholder_1_name is a name",
       rr._tail_attr("shareholder_1_name"), "name")
    eq("U9b", "an NRC tail is an nrc", rr._tail_attr("shareholder_1_nrc"), "nrc")
    eq("U9c", "a passport tail is an nrc", rr._tail_attr("director_passport"), "nrc")
    eq("U9d", "a percentage tail", rr._tail_attr("shareholder_1_percentage"), "percentage")
    eq("U9e", "a space-delimited share count is shares",
       rr._tail_attr("number of shares"), "shares")
    eq("U9f", "'shareholder' alone is not a share count",
       rr._tail_attr("shareholder_1"), "name")
    # KNOWN GAP, asserted so a fix is noticed rather than silently changing
    # behaviour: `\bshares?\b` needs a non-word delimiter and `_` is a word
    # character, so the underscore spelling falls through to the "name"
    # fallback. `number_of_shares` is a real placeholder in a real template. It
    # only misrenders if it sits INSIDE a repeat region — standalone it never
    # reaches _tail_attr — which has not been confirmed either way.
    eq("U9e2", "KNOWN GAP: the underscore spelling is not recognised as shares",
       rr._tail_attr("number_of_shares"), "name")

    # Real DICA data spells the corporate type "Company", not "corporate".
    eq("U9g", "type 'Company' is corporate", rr._is_corporate({"type": "Company"}), True)
    eq("U9h", "type 'corporate' is corporate", rr._is_corporate({"type": "corporate"}), True)
    eq("U9i", "type 'Individual' is not corporate",
       rr._is_corporate({"type": "Individual"}), False)
    eq("U9j", "an unlabelled company name falls back to the name heuristic",
       rr._is_corporate({"name": "PAHTAMA GROUP CO., LTD"}), True)
    eq("U9k", "an unlabelled person name is not corporate",
       rr._is_corporate({"name": "SOE MOE THU"}), False)
    eq("U9l", "an explicit individual label beats a company-looking name",
       rr._is_corporate({"type": "individual", "name": "LIMITED HOLDINGS"}), False)


# ===========================================================================
# U10 Fill-in view labels
# ===========================================================================
def test_fill_view():
    eq("U10a", "a synthetic repeat-region token reads as a party",
       fv._blank_label("__rr_1__"), "Party 1")
    eq("U10b", "the party number is preserved", fv._blank_label("__rr_12__"), "Party 12")
    eq("U10c", "an ordinary key is titlecased",
       fv._blank_label("meeting_date"), "Meeting Date")


# ===========================================================================
# U11 Structural contracts
#     Each of these has broken the product silently at least once.
# ===========================================================================
def test_structural_contracts():
    picker_src = (REPO / "scout/tools/people_picker.py").read_text()
    aq_src = (REPO / "scout/tools/ask_questions.py").read_text()
    agent_src = (REPO / "scout/agent.py").read_text()

    # A paused tool must not declare run_context — see the U8 comment.
    offenders = []
    for src, label in ((picker_src, "people_picker"), (aq_src, "ask_questions")):
        for m in re.finditer(r"@tool\([^)]*requires_user_input[^)]*\)\s*\ndef (\w+)\(([^)]*)\)",
                             src, re.S):
            if "run_context" in m.group(2):
                offenders.append(f"{label}.{m.group(1)}")
    eq("U11a", "no paused tool declares run_context", offenders, [])

    # The lettered a)/b)/c) menu is the one interaction the client rejected.
    lettered = [i + 1 for i, line in enumerate(agent_src.split("\n")) if line[:3] in ("a) ", "b) ", "c) ")]
    eq("U11b", "the system prompt contains no lettered menus", lettered, [])

    # agno reserves these names; using one hijacks the HITL resume path and the
    # provider rejects the dangling tool call with a 400.
    reserved = [n for n in ("def ask_user(", "def get_user_input(") if n in aq_src]
    eq("U11c", "no tool uses an agno-reserved name", reserved, [])

    # A tool the prompt names but that is not registered fails silently: the
    # model follows the instruction, finds nothing, and ends the turn empty.
    mismatches = getattr(__import__("scout.agent", fromlist=["_PROMPT_TOOL_MISMATCHES"]),
                         "_PROMPT_TOOL_MISMATCHES", None)
    eq("U11d", "every tool named in the prompt is registered", mismatches or [], [])

    # The picker read-back is only safe because it is scoped three ways.
    resolver_src = (REPO / "scout/tools/slot_resolver.py").read_text()
    # Slice to the END OF THE SQL STRING, not a fixed character count: the
    # comment block below the query discusses `session_id = ''` in prose, and a
    # fixed window that happened to reach it would make U11h flip on an edit to
    # a comment.
    _start = resolver_src.find("SELECT selection FROM party_selections")
    query = resolver_src[_start:resolver_src.find('"""', _start)]
    for cid, needle, why in [
        ("U11e", "session_id = %s", "scoped to the conversation"),
        ("U11f", "slot_kind = %s", "scoped to the role"),
        ("U11g", "LOWER(company_name) = LOWER(%s)", "scoped to the company"),
    ]:
        check(cid, f"picker read-back is {why}", needle in query, "")
    check("U11h", "the read-back tolerates no unscoped legacy rows",
          "slot_kind = ''" not in query and "session_id = ''" not in query, "")

    # Every caller of an AgentOS route must be able to find the JWT.
    #
    # `useStore().authToken` is a playground leftover: it is not in the store's
    # `partialize`, so it is '' on every page load. While /agents, /teams and
    # /sessions were public that was invisible — they answered with no header.
    # Putting them behind the JWT turned it into "Failed to fetch agents:
    # Unauthorized" on load, and would have 401'd the chat POST too. The real
    # token lives in localStorage under `ls_token`. None of the API-level test
    # layers can catch this: they all authenticate properly, because they are
    # clients rather than browsers.
    ui = REPO.parent / "agent-ui/src" if (REPO.parent / "agent-ui/src").exists() else None
    ui = ui or (REPO / "agent-ui/src")
    for cid, rel, fn_label in [
        ("U11i", "api/os.ts", "os.ts header builders"),
        ("U11j", "hooks/useAIStreamHandler.tsx", "the streaming chat POST"),
    ]:
        path = ui / rel
        if not path.exists():
            check(cid, f"{fn_label} falls back to the stored JWT", True,
                  "SKIPPED — frontend sources not present in this image")
            continue
        src = path.read_text()
        builds_bearer = "Bearer ${" in src
        # Match the CALL, not the bare word: both files explain `ls_token` in a
        # comment, so `"ls_token" in src` passes even with the fallback deleted.
        reads_token = re.search(r"localStorage\.getItem\(\s*['\"]ls_token['\"]\s*\)", src) is not None
        check(cid, f"{fn_label} falls back to the stored JWT",
              (not builds_bearer) or reads_token,
              "builds an Authorization header but never reads localStorage.ls_token")

    # The silent-stop nudge must not decide "did tool work" from the final chunk.
    #
    # RunPaused carries a `tools` array; RunCompleted does NOT carry the key at
    # all — verified against the live stream, where `'tools' in ev` was False
    # while ToolCallStarted had already reported ask_questions and preview_doc.
    # Reading `chunk.tools` there made `didToolWork` permanently false, so the
    # nudge never fired in the browser and neither did the out-of-retries
    # message that shares the guard: the user got a blank bubble that looked
    # exactly like a finished answer. tracker_layer3 could not catch it — the
    # harness counts ToolCallStarted across the stream, so it nudged correctly
    # and reported PASS while the real UI hung.
    handler = ui / "hooks/useAIStreamHandler.tsx"
    if not handler.exists():
        check("U11k", "the silent-stop nudge counts tools from the stream", True,
              "SKIPPED — frontend sources not present in this image")
    else:
        src = handler.read_text()
        m = re.search(r"const\s+didToolWork\s*=(.+?)\n\s*const\s", src, re.S)
        expr = m.group(1) if m else ""
        counts_stream = "toolsThisRunRef.current" in expr
        # A ref that is never incremented is the same bug wearing a new name.
        increments = re.search(r"toolsThisRunRef\.current\s*\+=\s*1", src) is not None
        resets = len(re.findall(r"toolsThisRunRef\.current\s*=\s*0", src))
        check("U11k", "the silent-stop nudge counts tools from the stream",
              bool(m) and counts_stream and increments and resets >= 2,
              f"didToolWork={expr.strip()[:60]!r} increments={increments} resets={resets}")

        # An empty turn after a document tool must be closed from the tool
        # result, not by buying a second inference.
        #
        # Measured over ten Layer 3 case-runs: generate_document ended the turn
        # with zero characters of content EVERY time it was the last tool. The
        # recovery was a synthetic "continue", which re-runs inference over the
        # whole re-injected history to obtain a sentence the tool result already
        # contains in its `message` field. Rendering that instead removes the
        # round trip; the nudge stays as the fallback when the result cannot be
        # read (pre-JSON Python-repr sessions).
        builds = re.search(r"const\s+buildClosingFromTool\s*=", src) is not None
        captured = "closingFromToolRef.current = closing" in src
        # The nudge and the out-of-retries branch must BOTH stand down when a
        # closing sentence exists, or the user gets the tool's sentence AND a
        # duplicate run.
        guards = len(re.findall(r"!closeFromTool\s*&&", src))
        renders = re.search(r"if\s*\(closeFromTool\)\s*\{\s*//[^\n]*\n\s*updatedContent\s*=\s*closeFromTool", src) is not None
        cleared = len(re.findall(r"closingFromToolRef\.current\s*=\s*''", src))
        check("U11l", "an empty turn is closed from the document tool result",
              builds and captured and guards >= 2 and renders and cleared >= 2,
              f"builder={builds} captured={captured} guards={guards} "
              f"renders={renders} resets={cleared}")

    # No foreign-jurisdiction statute may be cited by this product.
    #
    # app/main.py:_get_legal_refs_from_name() hardcoded Indian company law —
    # "Companies Act 2013 - Section 152", "SEBI (LODR) Regulations 2015" — and
    # picked between them by substring match on the template FILENAME. It was
    # used whenever AI analysis fell back, which was every time: on 2026-08-06
    # all 15 templates in the database held exactly those strings. A Myanmar law
    # firm was being told its AGM minutes were governed by India's securities
    # regulator. The same code block set jurisdiction = "Myanmar".
    #
    # Matching is on the statute NAMES, not the year alone: "2013" appears in
    # ordinary dates and would make this fire on anything.
    FOREIGN_STATUTES = [
        "Companies Act 2013",
        "Companies Act, 2013",
        "SEBI",
        "Companies (Management and Administration) Rules",
        "DIN Application",
    ]
    # Judge code, not commentary. A docstring naming "SEBI (LODR) Regulations
    # 2015" to explain why it was deleted is documentation; the same text in a
    # returned list is a citation shown to a lawyer. A line-based scan cannot
    # tell those apart and fails on its own fix, so Python is read through `ast`
    # and every docstring is skipped, while data files are scanned by line with
    # their comment syntax honoured.
    import ast as _ast

    def _docstring_nodes(tree):
        out = set()
        for node in _ast.walk(tree):
            if not isinstance(node, (_ast.Module, _ast.FunctionDef,
                                     _ast.AsyncFunctionDef, _ast.ClassDef)):
                continue
            body = getattr(node, "body", None) or []
            if (body and isinstance(body[0], _ast.Expr)
                    and isinstance(body[0].value, _ast.Constant)
                    and isinstance(body[0].value.value, str)):
                out.add(id(body[0].value))
        return out

    roots = [p for p in (REPO / "app", REPO / "scout", REPO / "db") if p.exists()]
    hits = []
    for root in roots:
        for path in root.rglob("*"):
            if path.suffix not in (".py", ".sql", ".json") or not path.is_file():
                continue
            try:
                text = path.read_text(errors="replace")
            except OSError:
                continue
            if path.suffix == ".py":
                try:
                    tree = _ast.parse(text)
                except SyntaxError:
                    continue
                skip = _docstring_nodes(tree)
                for node in _ast.walk(tree):
                    if (not isinstance(node, _ast.Constant)
                            or not isinstance(node.value, str)
                            or id(node) in skip):
                        continue
                    for statute in FOREIGN_STATUTES:
                        if statute in node.value:
                            hits.append(
                                f"{path.relative_to(REPO)}:{node.lineno} "
                                f"{node.value[:60]!r}"
                            )
                continue
            # .sql / .json — the migration that removes these has to name them.
            if path.name.startswith("migration_018"):
                continue
            for lineno, line in enumerate(text.splitlines(), 1):
                stripped = line.strip()
                if stripped.startswith("--"):
                    continue
                for statute in FOREIGN_STATUTES:
                    if statute in line:
                        hits.append(f"{path.relative_to(REPO)}:{lineno} {stripped[:60]}")
    check("U12", "no foreign-jurisdiction statute is cited as Myanmar law",
          not hits, "; ".join(hits[:4]) if hits else "")


def main():
    for fn in (
        test_placeholders,
        test_field_aliases,
        test_classify_kind,
        test_session_scope,
        test_companion_identifier,
        test_party_coercion,
        test_person_guard,
        test_picker_payload,
        test_repeat_regions,
        test_fill_view,
        test_structural_contracts,
    ):
        try:
            fn()
        except Exception as e:  # noqa: BLE001 — a crashing group is a failure, not a stop
            check(fn.__name__, f"{fn.__name__} raised", False, f"{type(e).__name__}: {e}")

    width = max(len(r[2]) for r in _results)
    print(f"\n{'ID':<8} {'RESULT':<8} {'CASE':<{width}}  DETAIL")
    print("-" * (26 + width + 40))
    failed = 0
    for cid, result, name, detail in _results:
        if result == "FAIL":
            failed += 1
            print(f"{cid:<8} {result:<8} {name:<{width}}  {detail}")
        else:
            print(f"{cid:<8} {result:<8} {name:<{width}}")

    total = len(_results)
    print(f"\nSUMMARY: PASS={total - failed}" + (f" · FAIL={failed}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
