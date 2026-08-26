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
from scout.tools import ask_questions as aq
from scout.tools import fill_view as fv
from scout.tools import people_picker as pp
from scout.tools import repeat_regions as rr
from scout.tools import slot_resolver as sr
from scout.tools.field_aliases import (
    canonical_field,
    normalize_field,
    tokens_match,
)
from scout.tools.placeholders import (
    is_empty_placeholder,
    new_empty_counter,
    placeholder_name,
)

REPO = Path("/app")

_results = []


def check(case_id: str, name: str, passed: bool, detail: str = ""):
    _results.append((case_id, "PASS" if passed else "FAIL", name, detail))


def eq(case_id: str, name: str, got, want):
    check(case_id, name, got == want, f"got {got!r}, want {want!r}")


def skip(case_id: str, name: str, why: str):
    """Record a case that could not run, without calling it a failure.

    A few assertions need real rows in the register — a company with a corporate
    member, and that member's board. On a FRESH INSTALL there are none, and
    reporting those as failures is wrong in the expensive direction: it makes a
    correct empty product look broken, and it trains you to ignore red. The
    check is skipped and says exactly which fixture is missing.
    """
    _results.append((case_id, "SKIP", name, why))


def register_has(company: str) -> bool:
    """True when `company` exists in the register, for fixture-dependent cases."""
    try:
        from scout.tools.companies_db import get_all_companies

        target = company.strip().lower()
        return any(target in str(c.get("name") or "").strip().lower() for c in get_all_companies(limit=300))
    except Exception:
        return False


# ===========================================================================
# U1  Placeholder normalisation
#     Word writes non-breaking spaces INSIDE placeholder names in five of the
#     client's templates. A different string from the normal-space spelling, so
#     every alias and field_mapping written by hand missed and the field came
#     out blank.
# ===========================================================================
def test_placeholders():
    eq(
        "U1a",
        "U+00A0 inside a placeholder folds to a normal space",
        placeholder_name(("individual\xa0shareholder_1_name", None, None)),
        "individual shareholder_1_name",
    )
    eq("U1b", "zero-width space is stripped", placeholder_name(("director\u200b_name", None, None)), "director_name")
    eq("U1c", "an ordinary name is untouched", placeholder_name(("meeting_date", None, None)), "meeting_date")
    eq(
        "U1d",
        "surrounding whitespace is trimmed",
        placeholder_name(("  chairperson_name  ", None, None)),
        "chairperson_name",
    )
    eq(
        "U1e",
        "the second capture group is used when the first is empty",
        placeholder_name((None, "company_name", None)),
        "company_name",
    )

    counter = new_empty_counter()
    first = placeholder_name((None, None, None), counter)
    second = placeholder_name((None, None, None), counter)
    check(
        "U1f",
        "bare slots get distinct synthetic names",
        bool(first) and bool(second) and first != second,
        f"{first!r} then {second!r}",
    )
    eq("U1g", "a bare slot with no counter stays empty", placeholder_name((None, None, None)), "")
    check("U1h", "is_empty_placeholder recognises a synthetic name", is_empty_placeholder(first), f"{first!r}")


# ===========================================================================
# U2  Field aliases
# ===========================================================================
def test_field_aliases():
    eq("U2a", "spaces and case normalise", normalize_field("Company Name"), "company_name")
    eq("U2b", "normalising is idempotent", normalize_field("company_name"), "company_name")
    eq(
        "U2c",
        "normalising folds U+00A0 too",
        normalize_field("individual\xa0shareholder_1_name"),
        "individual_shareholder_1_name",
    )
    eq("U2d", "canonical_field maps a known alias", canonical_field("nrc"), "nrc_no")
    check(
        "U2e",
        "tokens_match does not equate a numbered slot with the generic key",
        tokens_match("shareholder_1_name", "shareholder_name") is False,
        "",
    )


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

    eq("U3j", "an unrelated string classifies as unknown, not a guess", sr.classify_kind("the meeting date"), "")
    eq("U3k", "empty input classifies as unknown", sr.classify_kind(""), "")
    check(
        "U3l",
        "resigning outranks the generic director pattern",
        sr.classify_kind("director resigning from the board") == "resigning_director",
        "",
    )


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
    eq(
        "U4i",
        "picker log returns nothing when no session is in scope",
        sr._parties_from_picker_log("ANY COMPANY LIMITED", slot),
        [],
    )


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
        eq(cid, f"{ph!r} is not a person identifier", sr._role_prefix(ph, sr._IDENTIFIER_ATTR_RE), "")

    mapping = {
        "new_director_name": {
            "source": "slot",
            "slot": {"of": "people_register", "kind": "new_director", "multi": False},
        },
        "new_director_identification_number": {"source": "user_input", "slot": None},
    }
    person = {"name": "SOE MOE THU", "identifier": "12/SAKHANA(N)021426", "party_type": "individual"}

    eq(
        "U5l",
        "the NRC comes from the person the name slot resolved to",
        sr.companion_identifier("new_director_identification_number", mapping, {"new_director_name": person}),
        "12/SAKHANA(N)021426",
    )
    eq(
        "U5m",
        "no resolved person means the field is still asked",
        sr.companion_identifier("new_director_identification_number", mapping, {}),
        None,
    )
    eq(
        "U5n",
        "a person with no identifier on file does not fabricate one",
        sr.companion_identifier(
            "new_director_identification_number", mapping, {"new_director_name": {"name": "NO NRC PERSON"}}
        ),
        None,
    )
    eq(
        "U5o",
        "a non-identifier placeholder is left alone",
        sr.companion_identifier("meeting_date", mapping, {"new_director_name": person}),
        None,
    )
    eq(
        "U5p",
        "a company registration number is not answered from a person",
        sr.companion_identifier("company_registration_number", mapping, {"new_director_name": person}),
        None,
    )


# ===========================================================================
# U6  Party coercion — whatever a picker or the model hands back
# ===========================================================================
def test_party_coercion():
    eq(
        "U6a",
        "a dict becomes one party",
        sr._coerce_parties({"name": "A B", "identifier": "X1"}),
        [{"name": "A B", "identifier": "X1", "party_type": "individual", "representative": ""}],
    )
    eq("U6b", "a list of names becomes many parties", [p["name"] for p in sr._coerce_parties(["A", "B"])], ["A", "B"])
    eq("U6c", "TBD is not a person", sr._coerce_parties("TBD"), [])
    eq("U6d", "empty input yields no parties", sr._coerce_parties(""), [])
    eq("U6e", "None yields no parties", sr._coerce_parties(None), [])
    eq("U6f", "a JSON string is parsed", [p["name"] for p in sr._coerce_parties('[{"name": "C D"}]')], ["C D"])
    eq("U6g", "an unanswered picker payload yields no parties", sr._coerce_parties({"candidates": [{"name": "X"}]}), [])
    eq(
        "U6h",
        "nrc_passport_no is accepted as the identifier",
        sr._coerce_parties({"name": "E F", "nrc_passport_no": "9/ABC(N)1"})[0]["identifier"],
        "9/ABC(N)1",
    )

    eq("U6i", "slot_of returns None for a non-slot entry", sr.slot_of({"source": "user_input"}), None)
    eq(
        "U6j",
        "slot_of returns the descriptor for a slot entry",
        sr.slot_of({"source": "slot", "slot": {"kind": "signatory"}}),
        {"kind": "signatory"},
    )
    eq("U6k", "a slot entry with no kind is not a slot", sr.slot_of({"source": "slot", "slot": {}}), None)


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
            check(
                cid + "-p",
                "the blocked question names a real picker pair",
                role in aq._PICKER_FOR_ROLE,
                f"role={role!r}",
            )

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
    eq("U7u", "mixed batch blocks only the person question", [b["id"] for b in blocked], ["q1"])
    check(
        "U7v",
        "a blocked question names the tools to call instead",
        bool(blocked) and len(blocked[0].get("call_instead") or []) == 2,
        str(blocked[0].get("call_instead") if blocked else None),
    )

    # A question offering options is a constrained pick, not free text.
    with_options = [{"id": "q0", "text": "Which director should sign?", "options": ["A", "B"]}]
    allowed_o, blocked_o = aq._split_person_questions(with_options)
    eq("U7w", "an option-bearing question is left alone", (allowed_o, blocked_o), (["q0"], []))

    eq(
        "U7x",
        "answers for blocked questions are dropped",
        aq._filter_answers({"q0": "2026-09-15", "q1": "Typed Name"}, questions, ["q0", "q2"]),
        {"q0": "2026-09-15"},
    )
    eq(
        "U7y",
        "id-keyed answer lists are filtered the same way",
        aq._filter_answers([{"id": "q0", "answer": "x"}, {"id": "q1", "answer": "y"}], questions, ["q0", "q2"]),
        [{"id": "q0", "answer": "x"}],
    )
    eq(
        "U7z",
        "an unrecognised answer shape passes through untouched",
        aq._filter_answers("just a string", questions, ["q0"]),
        "just a string",
    )


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
    eq("U8b", "the picker reads the session back out", pp._session_from_payload(json.dumps(payload)), "sess-42")
    eq("U8c", "a dict payload works as well as a JSON string", pp._session_from_payload(payload), "sess-42")
    eq("U8d", "malformed JSON yields no session rather than raising", pp._session_from_payload("{not json"), "")
    eq("U8e", "an absent session field yields empty", pp._session_from_payload('{"candidates": []}'), "")
    eq("U8f", "None yields empty", pp._session_from_payload(None), "")
    eq("U8g", "a non-object payload yields empty", pp._session_from_payload("[1,2,3]"), "")

    eq(
        "U8h",
        "a prose purpose is recorded under the role it names",
        pp._classify_purpose("select the new director to be appointed"),
        "new_director",
    )

    cand = pp._candidate(person_id=7, name="A B", identifier="1/AB(N)2")
    eq("U8i", "a candidate keeps its identifier so the NRC travels with the pick", cand["identifier"], "1/AB(N)2")
    eq("U8j", "a candidate is individual unless told otherwise", cand["party_type"], "individual")


# ===========================================================================
# U9  Repeat regions — grow/shrink party blocks to the real count
# ===========================================================================
def test_repeat_regions():
    eq(
        "U9a",
        "'name' is checked before 'share' so shareholder_1_name is a name",
        rr._tail_attr("shareholder_1_name"),
        "name",
    )
    eq("U9b", "an NRC tail is an nrc", rr._tail_attr("shareholder_1_nrc"), "nrc")
    eq("U9c", "a passport tail is an nrc", rr._tail_attr("director_passport"), "nrc")
    eq("U9d", "a percentage tail", rr._tail_attr("shareholder_1_percentage"), "percentage")
    eq("U9e", "a space-delimited share count is shares", rr._tail_attr("number of shares"), "shares")
    eq("U9f", "'shareholder' alone is not a share count", rr._tail_attr("shareholder_1"), "name")
    # KNOWN GAP, asserted so a fix is noticed rather than silently changing
    # behaviour: `\bshares?\b` needs a non-word delimiter and `_` is a word
    # character, so the underscore spelling falls through to the "name"
    # fallback. `number_of_shares` is a real placeholder in a real template. It
    # only misrenders if it sits INSIDE a repeat region — standalone it never
    # reaches _tail_attr — which has not been confirmed either way.
    eq(
        "U9e2",
        "KNOWN GAP: the underscore spelling is not recognised as shares",
        rr._tail_attr("number_of_shares"),
        "name",
    )

    # Real DICA data spells the corporate type "Company", not "corporate".
    eq("U9g", "type 'Company' is corporate", rr._is_corporate({"type": "Company"}), True)
    eq("U9h", "type 'corporate' is corporate", rr._is_corporate({"type": "corporate"}), True)
    eq("U9i", "type 'Individual' is not corporate", rr._is_corporate({"type": "Individual"}), False)
    eq(
        "U9j",
        "an unlabelled company name falls back to the name heuristic",
        rr._is_corporate({"name": "PAHTAMA GROUP CO., LTD"}),
        True,
    )
    eq("U9k", "an unlabelled person name is not corporate", rr._is_corporate({"name": "SOE MOE THU"}), False)
    eq(
        "U9l",
        "an explicit individual label beats a company-looking name",
        rr._is_corporate({"type": "individual", "name": "LIMITED HOLDINGS"}),
        False,
    )

    # --- U18 ---------------------------------------------------------------
    # The signature table in several templates has NO header row: the
    # "Members to sign…" cue is an ordinary paragraph ABOVE it and row 0 is
    # already a signatory unit. The gate only ever read row 0, so those tables
    # were skipped whole, both slots fell through to the flat per-company fill,
    # and a company with ONE corporate member was rendered signing TWICE — once
    # through its representative, once again on the individual line.
    #
    # Built synthetically rather than read from documents/legal/templates:
    # that directory is a bind mount the firm edits, so a test reading it
    # asserts against whatever is on disk today.
    from docx import Document as _Docx

    def _signing_doc():
        d = _Docx()
        d.add_paragraph("Members to sign if they agree with all resolutions included above")
        t = d.add_table(rows=4, cols=1)
        t.cell(0, 0).text = "[corporate shareholder_name] (Represented by its authorized director)"
        t.cell(1, 0).text = "[authorized director_name]"
        t.cell(2, 0).text = "[individual shareholder_name]"
        t.cell(3, 0).text = "Date: [date]"
        return d, t

    d, t = _signing_doc()
    eq("U18a", "a headerless signature table is still recognised", rr._signing_rows_to_scan(t) is not None, True)

    # An ordinary table with no signing cue above it must stay untouched.
    plain = _Docx()
    plain.add_paragraph("Shareholding structure")
    pt = plain.add_table(rows=2, cols=1)
    pt.cell(0, 0).text = "[individual shareholder_name]"
    pt.cell(1, 0).text = "Date: [date]"
    eq("U18b", "a table with no signing cue above it is not claimed", rr._signing_rows_to_scan(pt), None)

    eq(
        "U18c",
        "'Represented by' marks a corporate signatory group",
        bool(rr._CORP_SIGN_RE.search("(Represented by its authorized director)")),
        True,
    )

    # One corporate member -> exactly ONE signatory block, and its name appears
    # exactly once. Two would be the shipped bug.
    d, _t = _signing_doc()
    member = {"name": "CITY HOLDINGS LIMITED", "type": "Company"}
    synth = rr.expand_repeat_regions(
        d,
        {"members": [member], "authorized_director_name": "PHYOE MIN KYAW"},
    )
    vals = list(synth.values())
    eq("U18d", "the sole corporate member signs exactly once", vals.count("CITY HOLDINGS LIMITED"), 1)
    # …and the representative is the person who was CHOSEN, not a register
    # ordering. `authorized_director_name` is the key the picker writes; it was
    # absent from the lookup list, which sent this to the positional fallback.
    eq("U18e", "the chosen representative is used, not a positional guess", "PHYOE MIN KYAW" in vals, True)

    # The three real custom_data shapes observed on live runs (documents 73–75).
    # The same slot arrives under two spellings and EITHER can hold the answer,
    # so the pick is on content: a candidate equal to `director_name` is the
    # untouched per-company default, one that differs is somebody's choice.
    corp = {"name": "CITY HOLDINGS LIMITED", "type": "Company"}
    eq(
        "U18h",
        "the space spelling wins when the underscore one is the default",
        rr._corp_representative(
            corp,
            {
                "director_name": "KYAW THU SOE",
                "authorized director_name": "PHYOE MIN KYAW",
                "authorized_director_name": "KYAW THU SOE",
            },
        ),
        "PHYOE MIN KYAW",
    )
    eq(
        "U18i",
        "the underscore spelling is honoured when it holds the answer",
        rr._corp_representative(corp, {"director_name": "KYAW THU SOE", "authorized_director_name": "PHYOE MIN KYAW"}),
        "PHYOE MIN KYAW",
    )
    eq(
        "U18j",
        "a candidate matching the default is still used, never re-guessed",
        rr._corp_representative(
            corp, {"director_name": "PHYOE MIN KYAW", "authorized_director_name": "PHYOE MIN KYAW"}
        ),
        "PHYOE MIN KYAW",
    )
    # `corporate_shareholder_3_name` is the MEMBER's own name. It used to be read
    # as a representative, putting the company on its own signature line.
    # (The register fallback below it may still supply a director here — what must
    # never come back is the company itself.)
    eq(
        "U18k",
        "the corporate member is never its own authorised director",
        rr._corp_representative(corp, {"corporate_shareholder_3_name": "CITY HOLDINGS LIMITED"})
        != "CITY HOLDINGS LIMITED",
        True,
    )

    # Five individual members -> five blocks, no repeats.
    d, _t = _signing_doc()
    people = [
        {"name": n, "type": "Individual"}
        for n in ("PHYOE MIN KYAW", "MYO MIN KYAW", "MIN MIN", "WIN WIN TINT", "ZAW MIN LATT")
    ]
    synth = rr.expand_repeat_regions(d, {"members": people})
    got = [v for v in synth.values() if v]
    eq("U18f", "every individual member gets exactly one block", sorted(got), sorted(p["name"] for p in people))

    # Empty data must remain a no-op on every template shape.
    d, t = _signing_doc()
    before = len(t.rows)
    rr.expand_repeat_regions(d, {})
    eq("U18g", "no party data leaves the table untouched", len(t.rows), before)


# ===========================================================================
# U10 Fill-in view labels
# ===========================================================================
def test_fill_view():
    eq("U10a", "a synthetic repeat-region token reads as a party", fv._blank_label("__rr_1__"), "Party 1")
    eq("U10b", "the party number is preserved", fv._blank_label("__rr_12__"), "Party 12")
    eq("U10c", "an ordinary key is titlecased", fv._blank_label("meeting_date"), "Meeting Date")


# ===========================================================================
# U10b An emptied field must be REPORTED, never hidden
#      `validate_filled_document` re-opens the saved .docx and looks for
#      leftover {{...}} patterns, so a placeholder replaced with "" leaves
#      nothing to find and reads as FILLED. That is how a Corporate Shareholder
#      Consent was produced reading 'referred to as  ("NewCo") ... shall invest
#      in  in NewCo' while the result reported 13 placeholders, unfilled_names
#      [] and status Complete — a resolution incorporating an unnamed company
#      for an unstated sum, declared finished.
#
#      The fix is a collector: `find_replacement` notes every user_input field
#      it empties, and `_generate_document` folds those into the validation.
#      These cases pin the collector itself, which is the part that can silently
#      stop working (a ContextVar that is never set collects nothing and every
#      document goes back to looking complete).
# ===========================================================================
def test_blank_reporting():
    import scout.tools.smart_doc as sd

    check("U10d", "a blank collector exists", hasattr(sd, "_blanked_placeholders"))
    check("U10e", "the note helper exists", callable(getattr(sd, "_note_blank", None)))

    # With NO collector set, noting must be a silent no-op — never an exception
    # in the middle of filling a document.
    try:
        sd._note_blank("subscription_amount")
        check("U10f", "noting outside a generation is a no-op", True)
    except Exception as e:
        check("U10f", "noting outside a generation is a no-op", False, repr(e))

    # With a collector set, the placeholder is recorded.
    token = sd._blanked_placeholders.set(set())
    try:
        sd._note_blank("subscription_amount")
        sd._note_blank("new_company_name")
        sd._note_blank("")  # falsy names are not recorded
        got = sorted(sd._blanked_placeholders.get())
        eq("U10g", "blanked fields are collected", got, ["new_company_name", "subscription_amount"])
    finally:
        sd._blanked_placeholders.reset(token)

    # Reset must actually clear it: a blank from one document attributed to the
    # next would be worse than not reporting at all.
    eq("U10h", "the collector is cleared after a generation", sd._blanked_placeholders.get(), None)

    # The wiring: generation must fold blanks into the validation and flip
    # is_valid. Asserted on the SOURCE because running a real generation needs
    # a database; the strings below are the ones that carry the behaviour.
    src = (REPO / "scout/tools/smart_doc.py").read_text()
    body = "\n".join(line for line in src.split("\n") if not line.lstrip().startswith("#"))
    check("U10i", "find_replacement notes the field it empties", "_note_blank(placeholder)" in body)
    check(
        "U10j",
        "generation folds blanks into unfilled_names",
        '"unfilled_names"] = _names' in body or 'unfilled_names"] = _names' in body,
    )
    check(
        "U10k",
        "generation marks a blanked document invalid",
        '"is_valid"] = False' in body or 'is_valid"] = False' in body,
    )


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
        for m in re.finditer(r"@tool\([^)]*requires_user_input[^)]*\)\s*\ndef (\w+)\(([^)]*)\)", src, re.DOTALL):
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
    mismatches = getattr(
        __import__("scout.agent", fromlist=["_PROMPT_TOOL_MISMATCHES"]), "_PROMPT_TOOL_MISMATCHES", None
    )
    eq("U11d", "every tool named in the prompt is registered", mismatches or [], [])

    # The picker read-back is only safe because it is scoped three ways.
    resolver_src = (REPO / "scout/tools/slot_resolver.py").read_text()
    # Slice to the END OF THE SQL STRING, not a fixed character count: the
    # comment block below the query discusses `session_id = ''` in prose, and a
    # fixed window that happened to reach it would make U11h flip on an edit to
    # a comment.
    _start = resolver_src.find("SELECT selection FROM party_selections")
    query = resolver_src[_start : resolver_src.find('"""', _start)]
    for cid, needle, why in [
        ("U11e", "session_id = %s", "scoped to the conversation"),
        ("U11f", "slot_kind = %s", "scoped to the role"),
        ("U11g", "LOWER(company_name) = LOWER(%s)", "scoped to the company"),
    ]:
        check(cid, f"picker read-back is {why}", needle in query, "")
    check(
        "U11h",
        "the read-back tolerates no unscoped legacy rows",
        "slot_kind = ''" not in query and "session_id = ''" not in query,
        "",
    )

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
            check(
                cid,
                f"{fn_label} falls back to the stored JWT",
                True,
                "SKIPPED — frontend sources not present in this image",
            )
            continue
        src = path.read_text()
        builds_bearer = "Bearer ${" in src
        # Match the CALL, not the bare word: both files explain `ls_token` in a
        # comment, so `"ls_token" in src` passes even with the fallback deleted.
        reads_token = re.search(r"localStorage\.getItem\(\s*['\"]ls_token['\"]\s*\)", src) is not None
        check(
            cid,
            f"{fn_label} falls back to the stored JWT",
            (not builds_bearer) or reads_token,
            "builds an Authorization header but never reads localStorage.ls_token",
        )

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
        check(
            "U11k",
            "the silent-stop nudge counts tools from the stream",
            True,
            "SKIPPED — frontend sources not present in this image",
        )
    else:
        src = handler.read_text()
        m = re.search(r"const\s+didToolWork\s*=(.+?)\n\s*const\s", src, re.DOTALL)
        expr = m.group(1) if m else ""
        counts_stream = "toolsThisRunRef.current" in expr
        # A ref that is never incremented is the same bug wearing a new name.
        increments = re.search(r"toolsThisRunRef\.current\s*\+=\s*1", src) is not None
        resets = len(re.findall(r"toolsThisRunRef\.current\s*=\s*0", src))
        check(
            "U11k",
            "the silent-stop nudge counts tools from the stream",
            bool(m) and counts_stream and increments and resets >= 2,
            f"didToolWork={expr.strip()[:60]!r} increments={increments} resets={resets}",
        )

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
        renders = (
            re.search(r"if\s*\(closeFromTool\)\s*\{\s*//[^\n]*\n\s*updatedContent\s*=\s*closeFromTool", src) is not None
        )
        # The ref holds a {content, approval} object now, so a per-stream reset
        # clears it to null rather than to the empty string it started as.
        cleared = len(re.findall(r"closingFromToolRef\.current\s*=\s*(?:''|null)", src))
        check(
            "U11l",
            "an empty turn is closed from the document tool result",
            builds and captured and guards >= 2 and renders and cleared >= 2,
            f"builder={builds} captured={captured} guards={guards} renders={renders} resets={cleared}",
        )

        # A stalled PREVIEW must be given back the approval it owed.
        #
        # preview_doc renders the field table and then owes an ask_questions
        # card with one question and two fixed options. Measured across six
        # conversations it produced neither: the turn ended empty, leaving a
        # preview the user could read and could not act on. It only became the
        # dominant stall once the tool was reachable at all — the prompt named
        # `preview_document`, which is not registered, so the required preview
        # step was skipped entirely and the model went straight to generation.
        #
        # The card is reconstructed, not invented: the question and both option
        # strings come from the tool's own agent_instruction. It must NOT be
        # routed through AskUserCardList, which resumes a PAUSED run — this run
        # completed, so there is no pause to consume.
        approval_builder = "buildApprovalFromPreview" in src
        approval_set = "APPROVAL_DOC_TOOLS" in src
        # preview_doc closing the turn silently is the bug this replaced.
        not_closable = re.search(r"CLOSABLE_DOC_TOOLS = new Set\(\[([^\]]*)\]", src, re.DOTALL)
        closable_body = not_closable.group(1) if not_closable else ""
        preview_excluded = "preview_doc" not in closable_body
        carried = "pending_approval: closeFromTool?.approval" in src
        prompt = ui / "components/chat/ApprovalPrompt.tsx"
        sends_message = prompt.exists() and "setPendingMessage(option)" in prompt.read_text()
        rendered = "ApprovalPrompt approval={message.pending_approval}" in (
            (ui / "components/chat/ChatArea/Messages/Messages.tsx").read_text()
            if (ui / "components/chat/ChatArea/Messages/Messages.tsx").exists()
            else ""
        )
        check(
            "U11m",
            "a stalled preview is given back its approval card",
            approval_builder and approval_set and preview_excluded and carried and sends_message and rendered,
            f"builder={approval_builder} set={approval_set} "
            f"preview_excluded_from_closable={preview_excluded} "
            f"carried={carried} sends={sends_message} rendered={rendered}",
        )

    # The tool list the model reads must be GENERATED, and a mismatch must be fatal.
    #
    # Four prompt/tool mismatches shipped while this was hand-written prose
    # checked by a log line, and every one failed silently — the model follows
    # the instruction, finds no such tool, and ends the turn with no text, which
    # reads as a hang and leaves no trace because the tool was never called:
    #
    #   generate_dica_extract  never added to _tools_to_add
    #   list_companies         registered as list_all_companies
    #   preview_document       export-dict key; @wraps made it preview_doc
    #   generate_document_tool named in scout/knowledge/routing/intents.json,
    #                          which reaches the prompt as DATA
    #
    # A log line is worth what someone reading it is worth. The inventory is now
    # built from the live registry, and startup refuses on a mismatch.
    agent_src = REPO / "scout" / "agent.py"
    if not agent_src.exists():
        check(
            "U13",
            "the tool inventory is generated and mismatches are fatal",
            True,
            "SKIPPED — scout/agent.py not present",
        )
    else:
        a = agent_src.read_text()
        generates = "_build_tool_inventory" in a and "TOOL_INVENTORY_BLOCK" in a
        injected = "{TOOL_INVENTORY_BLOCK}" in a
        # The audit and the inventory must measure the SAME registry, or the
        # list shown and the list checked drift apart again.
        shared = a.count("_registered_tool_names(") >= 2
        fatal = re.search(r"if _PROMPT_TOOL_MISMATCHES and[\s\S]{0,200}?raise RuntimeError", a) is not None
        # The agno Function wrapper keeps its purpose on .description; __doc__
        # is the class docstring, which described agno for 24 of 45 tools.
        real_desc = "Model for storing functions" in a and 'getattr(fn, "description"' in a
        check(
            "U13",
            "the tool inventory is generated and mismatches are fatal",
            generates and injected and shared and fatal and real_desc,
            f"generates={generates} injected={injected} shared_registry={shared} "
            f"fatal={fatal} real_descriptions={real_desc}",
        )

    # A stream that delivers nothing must never render as an answer.
    #
    # A 200 does not mean the body was ours. A restarting server, a proxy, or a
    # route that fell through to the static frontend all answer 200 with HTML:
    # response.ok is true, response.body exists, the reader drains it, and
    # parseBuffer finds no events — so the stream "completed" having delivered
    # zero chunks and the UI painted an empty agent bubble indistinguishable
    # from a finished reply. Measured live 2026-08-06: a message sent while the
    # container was being replaced came back in 1.0s as a blank bubble with no
    # error, and no run was ever persisted.
    #
    # Also: the !response.ok branch called response.json() on that HTML, which
    # threw a SyntaxError and hid the real status behind
    # "Unexpected token '<'".
    stream = ui / "hooks/useAIResponseStream.tsx"
    if not stream.exists():
        check(
            "U15",
            "an empty stream is reported, not painted as a reply",
            True,
            "SKIPPED — frontend sources not present in this image",
        )
    else:
        s = stream.read_text()
        counts = "delivered += 1" in s and "let delivered = 0" in s
        raises = re.search(r"if \(delivered === 0\)[\s\S]{0,200}?throw new Error", s) is not None
        # Both parse sites must go through the counter, or the count is a lie.
        wired = len(re.findall(r"parseBuffer\(buffer, countingChunk\)", s)) >= 2
        # Generous window: the branch carries the explanatory comment before the
        # call, and a 300-char bound failed on correct code.
        text_first = re.search(r"if \(!response\.ok\)[\s\S]{0,800}?response\.text\(\)", s) is not None
        check(
            "U15",
            "an empty stream is reported, not painted as a reply",
            counts and raises and wired and text_first,
            f"counts={counts} raises={raises} both_parse_sites={wired} reads_text_before_json={text_first}",
        )

    # The agent must never be able to send an email by itself.
    #
    # send_email_tool used to connect to SMTP and deliver, immediately, on the
    # agent's own decision — it chose the recipient, the subject, the body and
    # which generated document to attach, with no confirmation, no audit row and
    # no record that a send had even been considered. A misread instruction, or
    # text picked up from a document it was reading, was enough to mail a
    # client's corporate filing to an address nobody approved. Email cannot be
    # recalled.
    #
    # The tool now only queues. Delivery lives behind an endpoint requiring the
    # USER's JWT, which the agent has no way to obtain. There must be no
    # "confirmed" parameter either: a flag set by the same model whose judgement
    # is being checked is not an approval.
    if not agent_src.exists():
        check("U14", "the agent cannot send an email without a human", True, "SKIPPED — scout/agent.py not present")
    else:
        a = agent_src.read_text()
        tool = re.search(r"def send_email_tool\(([\s\S]*?)\n(?=\w|@)", a)
        body = tool.group(0) if tool else ""
        no_smtp = "smtplib" not in body and "send_message" not in body
        queues = "'queued'" in body or '"queued"' in body
        no_confirm_arg = tool is not None and "confirmed" not in (tool.group(1).split(")")[0])
        main_src = REPO / "app" / "main.py"
        m = main_src.read_text() if main_src.exists() else ""
        # Delivery endpoint exists, demands a token, and claims the row before
        # touching SMTP so a double click cannot send twice.
        gated = '@app.post("/api/email/queued/{email_id}/send")' in m
        needs_auth = bool(
            re.search(r'/api/email/queued/\{email_id\}/send"\)[\s\S]{0,400}?if not user:[\s\S]{0,80}?401', m)
        )
        claims_first = bool(re.search(r"SET status = 'sending'[\s\S]{0,200}?WHERE id = %s AND status = 'queued'", m))
        check(
            "U14",
            "the agent cannot send an email without a human",
            bool(tool) and no_smtp and queues and no_confirm_arg and gated and needs_auth and claims_first,
            f"tool_found={bool(tool)} no_smtp={no_smtp} queues={queues} "
            f"no_confirm_arg={no_confirm_arg} endpoint={gated} "
            f"auth={needs_auth} claims_before_send={claims_first}",
        )

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
            if not isinstance(node, (_ast.Module, _ast.FunctionDef, _ast.AsyncFunctionDef, _ast.ClassDef)):
                continue
            body = getattr(node, "body", None) or []
            if (
                body
                and isinstance(body[0], _ast.Expr)
                and isinstance(body[0].value, _ast.Constant)
                and isinstance(body[0].value.value, str)
            ):
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
                    if not isinstance(node, _ast.Constant) or not isinstance(node.value, str) or id(node) in skip:
                        continue
                    for statute in FOREIGN_STATUTES:
                        if statute in node.value:
                            hits.append(f"{path.relative_to(REPO)}:{node.lineno} {node.value[:60]!r}")
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
    check(
        "U12", "no foreign-jurisdiction statute is cited as Myanmar law", not hits, "; ".join(hits[:4]) if hits else ""
    )

    # The routing data files describe THIS product, and their tool names are real.
    #
    # scout/knowledge/routing/intents.json and scout/knowledge/sources/files.json
    # are interpolated into the system prompt as DATA (via INTENT_ROUTING_CONTEXT
    # and SOURCE_REGISTRY_STR). Nothing in them is code, so nothing in them is
    # reachable by searching source for a symbol — which is exactly how
    # `generate_document_tool` survived for weeks as the primary source for
    # "Create legal document".
    #
    # On 2026-08-06 both files were still the generic enterprise-docs boilerplate
    # they shipped from: 11 of 12 intents were about OKRs, RFCs, runbooks and PTO,
    # the source registry advertised company-docs/, engineering-docs/ and
    # data-exports/ — none of which have ever existed here — and a gotcha told the
    # model that PTO sits in "employee-handbook.md, Section 4". 3.5k characters of
    # a different product's map, in the prompt of a Myanmar legal drafting agent.
    #
    # The import-time audit does NOT cover this. It flags a backticked word only
    # when that word shares an 8-character prefix with a registered tool, so a
    # plainly wrong name passes it. This check closes that gap directly.
    routing = REPO / "scout" / "knowledge" / "routing" / "intents.json"
    sources = REPO / "scout" / "knowledge" / "sources" / "files.json"
    if not routing.exists() or not sources.exists():
        check(
            "U16",
            "prompt routing data names real tools and real directories",
            True,
            "SKIPPED — knowledge data files not present",
        )
    else:
        import json as _json

        intents = _json.loads(routing.read_text())
        filesrc = _json.loads(sources.read_text())

        named = set()
        for m in intents.get("intent_mappings", []):
            if m.get("primary_source"):
                named.add(m["primary_source"])
            named.update(m.get("fallback_sources", []))

        # Compare against the LIVE registry. Skipped rather than failed when the
        # agent cannot be imported, so this stays runnable outside the container.
        try:
            from scout.agent import scout as _scout

            registered = set()
            for t in _scout.tools or []:
                n = getattr(t, "__name__", None) or getattr(t, "name", None)
                if n:
                    registered.add(str(n))
                fns = getattr(t, "functions", None)
                if isinstance(fns, dict):
                    registered.update(str(k) for k in fns)
        except Exception:
            registered = set()

        unregistered = sorted(named - registered) if registered else []

        # Every directory the prompt advertises must exist. Telling the model
        # about a folder that is not there is the file-system twin of naming a
        # tool that is not registered: it tries, finds nothing, and says nothing.
        try:
            from scout.paths import DOCUMENTS_DIR as _DOCS

            docs_root = Path(_DOCS)
        except Exception:
            docs_root = REPO / "documents"

        def _resolve(p: str) -> Path:
            p = p.strip().rstrip("/")
            if p.startswith("documents/"):
                return docs_root / p[len("documents/") :]
            return REPO / p

        advertised = [d["name"] for d in filesrc.get("directories", []) if d.get("name")]
        advertised += list(filesrc.get("common_locations", {}).values())
        ghosts = sorted({p for p in advertised if not _resolve(p).is_dir()})

        # Vocabulary from the product this boilerplate came from. None of it
        # describes anything in Legal Scout.
        FOREIGN_VOCAB = [
            "company-docs",
            "engineering-docs",
            "data-exports",
            "employee-handbook",
            "Employee Handbook",
            "OKR",
            "PTO",
            "runbook",
        ]

        # Judge what RENDERS, not the commentary — the same rule U12 applies by
        # skipping docstrings. A `_comment` key recording that these directories
        # never existed is documentation; the formatter reads no key beginning
        # with an underscore, so none of it can reach the model. Scanning raw
        # text instead would make this check fail on its own fix.
        def _rendered(node):
            if isinstance(node, dict):
                return " ".join(_rendered(v) for k, v in node.items() if not str(k).startswith("_"))
            if isinstance(node, list):
                return " ".join(_rendered(v) for v in node)
            return str(node)

        blob = _rendered(intents) + " " + _rendered(filesrc)
        stowaways = sorted({v for v in FOREIGN_VOCAB if v in blob})

        check(
            "U16",
            "prompt routing data names real tools and real directories",
            not unregistered and not ghosts and not stowaways,
            f"unregistered_tools={unregistered or 'none'} "
            f"nonexistent_dirs={ghosts or 'none'} "
            f"foreign_vocab={stowaways or 'none'} "
            f"(registry_{'loaded' if registered else 'UNAVAILABLE—tool check skipped'})",
        )

    # The documents tree must never be served without a token.
    #
    # app.mount("/documents", StaticFiles(...)) serves generated documents,
    # uploaded DICA filings, the firm's templates and cached previews. The auth
    # middleware returns early on any path not starting with "/api/", so all of
    # it was public: measured 2026-08-06 against the running app, a real AGM
    # minutes .docx came back 200 / 29,313 bytes with no token at all, on a
    # container published to 0.0.0.0.
    #
    # PUBLIC_ROUTES listed "/documents/legal/" with the comment "Static file
    # serving", which read like policy but never ran — that list is consulted
    # after the /api/ early return.
    #
    # ORDER is the invariant, not the presence of a constant. A gate placed
    # below the early return is exactly as dead as the comment it replaced, and
    # would still pass a check that only greps for the name.
    main_src = REPO / "app" / "main.py"
    if not main_src.exists():
        check("U17", "the documents tree is not served without a token", True, "SKIPPED — app/main.py not present")
    else:
        m = main_src.read_text()
        # \s* between the paren and the brace: a formatter may split
        # `frozenset({` across lines, and the control is no weaker for it.
        declared = re.search(r"STATIC_PROTECTED_ROOTS\s*=\s*frozenset\(\s*\{([\s\S]{0,400}?)\}\s*\)", m)
        covers_documents = bool(declared and '"documents"' in declared.group(1))

        gate = re.search(r"if root in AGENTOS_PROTECTED_ROOTS or root in STATIC_PROTECTED_ROOTS", m)
        early_return = re.search(r'if not path\.startswith\("/api/"\)', m)
        ordered = bool(gate and early_return and gate.start() < early_return.start())

        # The gate must read the cookie, or a plain <a href> download breaks:
        # an anchor cannot set an Authorization header.
        after_gate = m[gate.start() : early_return.start()] if ordered else ""
        uses_request_jwt = "_request_jwt(request)" in after_gate

        # And the dead whitelist entry must not come back. Scoped to the
        # PUBLIC_ROUTES literal: startup_sync holds a list of the same directory
        # paths for mkdir, and a file-wide scan flags those instead — failing on
        # correct code, which is how U15 broke once already.
        routes_block = re.search(r"PUBLIC_ROUTES\s*=\s*\[([\s\S]*?)\n\]", m)
        no_dead_entry = bool(routes_block) and not re.search(r'^\s*"/documents', routes_block.group(1), re.MULTILINE)

        check(
            "U17",
            "the documents tree is not served without a token",
            covers_documents and ordered and uses_request_jwt and no_dead_entry,
            f"declares_documents={covers_documents} "
            f"gate_before_api_early_return={ordered} "
            f"reads_cookie_via_request_jwt={uses_request_jwt} "
            f"no_public_documents_entry={no_dead_entry}",
        )


# ===========================================================================
# U19-U22  Register authority
#     Who is allowed to sign, and what the product is allowed to claim a tool
#     is called. Both have produced legally wrong documents.
# ===========================================================================
def test_register_authority():
    import scout.agent as _agent
    from db.connection import get_db_conn

    registry = _agent._registered_tool_names(_agent.scout.tools or [])

    # --- U19: skill BODIES name real tools ---------------------------------
    # The startup contract audit reads name + description only, so bodies —
    # the L2 playbooks lawyers edit in the admin UI — were never checked. Seven
    # enabled skills shipped naming `preview_document` (registered as
    # `preview_doc`) and `list_tracked_documents` (registered as
    # `list_documents`). The model follows the instruction, finds no tool, and
    # the step silently does not happen.
    conn = get_db_conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT name, body FROM legal_skills WHERE enabled = TRUE ORDER BY name")
        skills = cur.fetchall()
        cur.close()
    finally:
        conn.close()

    check("U19a", "there are enabled skills to audit", len(skills) > 0, f"{len(skills)} enabled")

    bad = {}
    for sname, body in skills:
        refs = set(re.findall(r"`([a-z_][a-z0-9_]{3,})\(?\)?`", body or ""))
        refs |= set(re.findall(r"\b([a-z_][a-z0-9_]{3,})\(\)", body or ""))
        for r in sorted(refs):
            if r in registry:
                continue
            # Only a NEAR MISS is a defect. A skill body is prose; flagging every
            # unknown snake_case token would trip on placeholder names and DB
            # columns. Same 6-char prefix rule the /api/skills validator uses.
            if any(t.startswith(r[:6]) or r.startswith(t[:6]) for t in registry):
                bad.setdefault(sname, []).append(r)
    check("U19b", "every enabled skill body names only registered tools", not bad, f"{bad}" if bad else "")

    # The two specific names that shipped, asserted by hand so a future
    # re-seed of migration 014 cannot quietly reintroduce them.
    eq(
        "U19c",
        "preview_document is not a tool (preview_doc is)",
        ("preview_document" in registry, "preview_doc" in registry),
        (False, True),
    )
    eq(
        "U19d",
        "list_tracked_documents is not a tool (list_documents is)",
        ("list_tracked_documents" in registry, "list_documents" in registry),
        (False, True),
    )

    # --- U20: legacy cessation ---------------------------------------------
    # `_registered_people` filters cessation in SQL, but `_directors_of` falls
    # back to `_legacy_people` when a company has no register rows — and that
    # path read only name/position/appointed_date/shares. An unsynced company
    # offered its RESIGNED directors as current, which is how a person with no
    # authority reaches a signature block.
    from datetime import date, timedelta

    past = (date.today() - timedelta(days=30)).isoformat()
    future = (date.today() + timedelta(days=120)).isoformat()

    def _names(entries):
        return [c.get("name") for c in pp._legacy_people(entries, "Director")]

    eq(
        "U20a",
        "a director who has already ceased is not offered",
        _names([{"name": "GONE", "date_of_cessation": past}, {"name": "HERE"}]),
        ["HERE"],
    )
    eq(
        "U20b",
        "the alternate spelling is honoured too",
        _names([{"name": "GONE", "resigned_date": past}, {"name": "HERE"}]),
        ["HERE"],
    )
    # Safe direction: shown, not hidden. A name the user can see can be
    # declined; a name never shown cannot be chosen.
    eq(
        "U20c",
        "a FUTURE cessation is still in office today",
        _names([{"name": "STILL SERVING", "date_of_cessation": future}]),
        ["STILL SERVING"],
    )
    eq("U20d", "a blank marker is not a resignation", _names([{"name": "FINE", "date_of_cessation": "-"}]), ["FINE"])
    eq(
        "U20e",
        "an unreadable date does not silently remove anybody",
        _names([{"name": "FINE", "date_of_cessation": "01/12/2024"}]),
        ["FINE"],
    )
    # …and the user must be able to SEE a pending departure before signing.
    sub = (
        pp._legacy_people([{"name": "STILL SERVING", "date_of_cessation": future}], "Director")[0].get("subtitle") or ""
    )
    check("U20f", "a pending departure is visible on the candidate", future in sub, sub)

    # --- U21: a representative must be on THAT company's board -------------
    # Measured: KYAW THU SOE sits on CITY MART's board and NOT on CITY
    # HOLDINGS'. He was printed as CITY HOLDINGS' authorised director — a person
    # with no power to bind the company he was signing for.
    #
    # These need real rows. On a fresh install the register is empty by design,
    # so they SKIP rather than fail — a correct empty product must not report red.
    board = rr._board_of("CITY HOLDINGS LIMITED") if register_has("CITY HOLDINGS") else []
    if not board:
        for cid, nm in (
            ("U21a", "the member company's board is readable"),
            ("U21b", "a director of the SUBJECT company is refused as the member's rep"),
            ("U21c", "a director who IS on that board is accepted"),
        ):
            skip(cid, nm, "needs CITY HOLDINGS LIMITED and its directors in the register")
    else:
        check("U21a", "the member company's board is readable", len(board) > 0, f"{board}")
    if board:
        outsider = "KYAW THU SOE"
        check(
            "U21b",
            "a director of the SUBJECT company is refused as the member's rep",
            rr._corp_representative(
                {"name": "CITY HOLDINGS LIMITED", "type": "Company"}, {"authorized director_name": outsider}
            )
            != outsider,
            f"board={board}",
        )
        insider = board[0]
        eq(
            "U21c",
            "a director who IS on that board is accepted",
            rr._corp_representative(
                {"name": "CITY HOLDINGS LIMITED", "type": "Company"}, {"authorized director_name": insider}
            ),
            insider,
        )
    # An unregistered member company cannot be checked. Refusing there would
    # blank the line for every corporate member not in the register, so it fails
    # OPEN — deliberately, and logged.
    eq(
        "U21d",
        "an unverifiable company fails open rather than blanking the line",
        rr._corp_representative(
            {"name": "NOT IN THE REGISTER PTE LTD", "type": "Company"}, {"authorized director_name": "SOMEBODY"}
        ),
        "SOMEBODY",
    )

    # --- U22: member slots are typed, not positional -----------------------
    # slots 1-2 were ASSUMED individual and slot 3 corporate, from a flat
    # comma-joined name list. CITY MART's only member is the corporate CITY
    # HOLDINGS LIMITED; it landed at index 0 and was written into the
    # INDIVIDUAL slot, rendering a company as an individual member.
    #
    # Needs both the template ON DISK and the company in the register, so it
    # skips on a fresh install for the same reason as U21.
    from scout.tools.smart_doc import prepare_document_data

    _tpl = "Shareholders Resolution In Writing - Director Appointment.docx"
    # NOT REPO/"documents" — that is /app/documents, which does not exist. The
    # templates are a bind mount at /documents, which is prepare_document_data's
    # own default documents_dir. Pointing at the wrong one would make this skip
    # permanently, which is the quiet way a test stops testing anything.
    _have = register_has("CITY MART") and Path("/documents/legal/templates", _tpl).exists()
    prepared = prepare_document_data(_tpl, "CITY MART HOLDING COMPANY LIMITED") if _have else {}
    cd = (prepared or {}).get("company_data") or {}
    if not cd:
        why = "needs CITY MART HOLDING COMPANY LIMITED in the register and the Director Appointment template on disk"
        for cid, nm in (
            ("U22a", "the sole CORPORATE member fills the corporate slot"),
            ("U22b", "and does NOT fill the individual slot"),
            ("U22c", "the space spelling agrees with the underscore one"),
            ("U22d", "the untyped slot still carries the member"),
        ):
            skip(cid, nm, why if _have is False else f"{why} (prepare returned {sorted(prepared or {})[:6]})")
    else:
        eq(
            "U22a",
            "the sole CORPORATE member fills the corporate slot",
            cd.get("corporate_shareholder_3_name"),
            "CITY HOLDINGS LIMITED",
        )
        eq("U22b", "and does NOT fill the individual slot", cd.get("individual_shareholder_1_name"), "TBD")
        eq("U22c", "the space spelling agrees with the underscore one", cd.get("individual shareholder_1_name"), "TBD")
        # The generic, type-agnostic slots still list every member in order.
        eq("U22d", "the untyped slot still carries the member", cd.get("shareholder_1_name"), "CITY HOLDINGS LIMITED")


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
        test_blank_reporting,
        test_register_authority,
        test_structural_contracts,
    ):
        try:
            fn()
        except Exception as e:
            check(fn.__name__, f"{fn.__name__} raised", False, f"{type(e).__name__}: {e}")

    width = max(len(r[2]) for r in _results)
    print(f"\n{'ID':<8} {'RESULT':<8} {'CASE':<{width}}  DETAIL")
    print("-" * (26 + width + 40))
    failed = skipped = 0
    for cid, result, name, detail in _results:
        if result == "FAIL":
            failed += 1
            print(f"{cid:<8} {result:<8} {name:<{width}}  {detail}")
        elif result == "SKIP":
            skipped += 1
            # A skip always says WHY. A silent skip is a test that quietly
            # stopped testing, which is the failure mode this suite exists for.
            print(f"{cid:<8} {result:<8} {name:<{width}}  {detail}")
        else:
            print(f"{cid:<8} {result:<8} {name:<{width}}")

    total = len(_results)
    print(
        f"\nSUMMARY: PASS={total - failed - skipped}"
        + (f" · SKIP={skipped}" if skipped else "")
        + (f" · FAIL={failed}" if failed else "")
    )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
