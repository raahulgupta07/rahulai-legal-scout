"""
Layer 3 LIVE — the original suite, driving the REAL agent over HTTP.

This is the on-demand variant. Every case is a multi-turn conversation against a
paid model, and its failures move between cases run to run, so it is not a
regression gate: use it to observe what the model actually does.
`tracker_layer3.py` is the scripted, deterministic suite that runs in CI.
Behaviour here is unchanged from the version that file replaced.

Layer 3 — drive a WHOLE conversation to a generated document.

Layers 1 and 2 proved the data is right and that the agent asks instead of
guessing. Neither answers the tracker's other big complaint:

    "The system asked the information, but the provided information are not
     used in the exported document."

That needs someone to actually answer the questions and then read the .docx.
This does that over the API: send the prompt, catch each RunPaused, fill the
answer into the paused tool exactly the way the browser does, resume the same
run, and repeat until the agent produces a file. Then it downloads the document
and asserts the answers are physically in it.

Every run is tagged with the admin user id, so each conversation shows up in the
app's own sidebar and can be read back by a human afterwards.

Run:  ADMIN_PASSWORD=... python3 tests/tracker_layer3.py
"""

import json
import os
import re
import sys
import time
import urllib.request
import zipfile
import io

BASE = os.environ.get("SCOUT_BASE", "http://localhost:8080")
EMAIL = os.environ.get("ADMIN_EMAIL", "admin@legalscout.com")
PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
TIMEOUT = int(os.environ.get("RUN_TIMEOUT", "300"))
MAX_TURNS = 16

BOUNDARY = "----scoutTracker"


def _encode(fields):
    parts = []
    for k, v in fields.items():
        parts.append(
            f"--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n"
        )
    parts.append(f"--{BOUNDARY}--\r\n")
    return "".join(parts).encode()


def login():
    if not PASSWORD:
        sys.exit("Set ADMIN_PASSWORD — this script will not hardcode a credential.")
    body = json.dumps({"email": EMAIL, "password": PASSWORD}).encode()
    req = urllib.request.Request(f"{BASE}/api/auth/login", data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=60) as r:
        out = json.loads(r.read().decode("utf-8", "replace"), strict=False)
    token = out.get("token") or out.get("access_token")
    if not token:
        sys.exit(f"Login failed: {out}")
    return token, (out.get("user") or {}).get("id", 1)


def _consume(resp):
    """Read one SSE stream into the bits we care about."""
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


def start(token, message, session_id, user_id):
    req = urllib.request.Request(
        f"{BASE}/agents/scout/runs",
        data=_encode({"message": message, "stream": "true",
                      "session_id": session_id, "user_id": str(user_id)}),
        method="POST",
    )
    req.add_header("Content-Type", f"multipart/form-data; boundary={BOUNDARY}")
    req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return _consume(r)


def answer_pause(token, paused, answers, session_id, user_id):
    """Resume a paused run.

    The whole ToolExecution is echoed back with only the target field given a
    value — dropping a field wipes it server-side, which is how the questions
    payload gets lost and the provider then rejects the dangling tool call.
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

    req = urllib.request.Request(
        f"{BASE}/agents/{agent_id}/runs/{run_id}/continue",
        data=_encode({"tools": json.dumps(payload), "stream": "true",
                      "session_id": session_id, "user_id": str(user_id)}),
        method="POST",
    )
    req.add_header("Content-Type", f"multipart/form-data; boundary={BOUNDARY}")
    req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return _consume(r)


def decide(paused, plan):
    """Choose an answer for whatever the agent just asked.

    `plan` supplies the deliberate values a tester would type, so the assertion
    afterwards knows exactly what should appear in the document.
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
                described.append(
                    f"{purpose or 'choose person'} → {chosen.get('name') or chosen.get('label')}"
                )
    return answers, described


def docx_text(token, download_url):
    url = download_url if download_url.startswith("http") else f"{BASE}{download_url}"
    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=120) as r:
        blob = r.read()
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        xml = z.read("word/document.xml").decode("utf-8", "replace")
    return re.sub(r"<[^>]+>", "", xml)


CASES = [
    {
        "id": "E1",
        "prompt": "Prepare a shareholders meeting minutes for director appointment only for City Holdings",
        "person": "SOE MOE THU",
        "answers": {"meeting date": "2026-09-15", "pronoun": "he",
                    "date": "2026-09-15", "auditor": "", "financial year": ""},
        "default_answer": "",
        # What must physically appear in the exported .docx.
        "expect_in_doc": ["SOE MOE THU", "CITY HOLDINGS LIMITED"],
    },
    {
        "id": "E2",
        "prompt": "Prepare resignation letter of Daw Win Win Tint from City Holdings",
        "person": "WIN WIN TINT",
        "answers": {"date": "2026-09-20"},
        "default_answer": "",
        "expect_in_doc": ["WIN WIN TINT", "CITY HOLDINGS LIMITED"],
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
        # Template choice matters. "Corporate Shareholder Consent" is the wrong
        # one: it carries director_1_name..director_3_name, described as the
        # existing directors SIGNING the resolution, so MIN MIN appears there
        # legitimately and a negative assertion would fail on correct output.
        # "Shareholders Resolution In Writing - Director Appointment" has exactly
        # one register-sourced person slot, authorized_director_name — "an
        # existing director authorized to execute or sign on behalf of the
        # company" — which IS the representative slot the fix governs.
        #
        # ⚠ Interpreting a MIN MIN hit: MIN MIN is a director of BOTH CITY MART
        # and CITY HOLDINGS, so presence is strong evidence but not proof of the
        # old bug. On a FAIL here, read the document and find WHICH slot the name
        # landed in before calling it a regression.
        "id": "E3",
        "prompt": ("Prepare a shareholders resolution in writing for director "
                   "appointment for City Mart Holding Company Limited"),
        "person": "PHYOE MIN KYAW",
        "person_for": {"authoriz": "PHYOE MIN KYAW", "represent": "PHYOE MIN KYAW",
                       "signator": "PHYOE MIN KYAW"},
        "answers": {"date": "2026-10-01", "new director": "AUNG KYAW MOE",
                    "identification": "NRC", "pronoun": "he"},
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
        "expect_after": [{"marker": "represented by its authorized director",
                          "value": "PHYOE MIN KYAW"}],
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
        "prompt": ("Prepare a shareholders resolution in writing for director "
                   "appointment for CM Foods Company Limited"),
        "person": "KYAW THU SOE",
        "person_for": {"authoriz": "KYAW THU SOE", "represent": "KYAW THU SOE",
                       "signator": "KYAW THU SOE",
                       "new director": "MYO MIN KYAW", "appoint": "MYO MIN KYAW"},
        "answers": {"date": "2026-11-05", "identification": "NRC", "pronoun": "he"},
        "default_answer": "",
        "expect_ask": ["authoriz|represent|signator"],
        "expect_in_doc": ["KYAW THU SOE", "CITY MART HOLDING COMPANY LIMITED"],
        # A CM FOODS director who is NOT on CITY MART's board. If he appears at
        # all in a document whose only signatory is CITY MART's representative,
        # the wrong register was consulted.
        "forbid_in_doc": ["SOE MOE THU"],
        "expect_count": {"CITY MART HOLDING COMPANY LIMITED": 1},
        "expect_after": [{"marker": "represented by its authorized director",
                          "value": "KYAW THU SOE"}],
    },
    {
        # The contrast that makes E3/E4 mean something. Two members, both
        # people, so the corporate row group must be DELETED outright — no
        # representative line at all. Without this, a bug that collapsed every
        # member list to a single corporate block would still pass E3 and E4.
        "id": "E5",
        "prompt": ("Prepare a shareholders resolution in writing for director "
                   "appointment for Commerce Ace Company Limited"),
        "person": "WIN WIN TINT",
        "person_for": {"new director": "MYO MIN KYAW", "appoint": "MYO MIN KYAW"},
        "answers": {"date": "2026-11-12", "identification": "NRC", "pronoun": "she"},
        "default_answer": "",
        "expect_in_doc": ["WIN WIN TINT", "MIN MIN", "COMMERCE ACE COMPANY LIMITED"],
        # Neither member is a company, so this template row must not survive.
        "forbid_in_doc": ["Represented by its authorized director"],
        "expect_count": {"WIN WIN TINT": 1, "MIN MIN": 1},
    },
    {
        # Tracker row N5, run as the two consents the register actually holds.
        #
        # N5 asks for a COMBINED "Director and Shareholder Consent Form" for one
        # person who is both. That template does not exist — not in the register,
        # and not in the client's own OneDrive master folder as of 2026-08-24.
        # Their tracker marks it "(new template)" itself. So it cannot be run as
        # written, and authoring a substitute would prove nothing about theirs.
        #
        # What CAN be proven is that every expectation N5 lists is met by the two
        # approved consents the same person would sign. N5's four expectations:
        # ask for the new company name, auto-fill the person from the People
        # register, ask for share count and capital amount, and ask for the date
        # rather than filling one in. N5a covers the director half, N5b the
        # shareholder half (which is where shares and capital live).
        #
        # The company name is deliberately FICTIONAL and absent from the register:
        # a new company has not been incorporated yet, so the value can only have
        # come from the answer the tester typed. Same for the date — "07 July
        # 2027" is nowhere in the data, so finding it in the .docx proves the
        # supplied value was used, and finding any OTHER date proves it was not.
        "id": "N5a",
        "prompt": ("Prepare a director consent form (non group member) for Win Win "
                   "Tint to appoint in a new company. Use information of Win Win "
                   "Tint from people database"),
        "person": "WIN WIN TINT",
        "answers": {"company": "ZENITH ORCHID VENTURES LIMITED",
                    "date": "07 July 2027",
                    "nationality": "Myanmar",
                    "country": "Myanmar",
                    "registration": "TBC on incorporation"},
        "default_answer": "",
        "expect_ask": ["compan", "date"],
        "expect_in_doc": ["WIN WIN TINT", "ZENITH ORCHID VENTURES LIMITED",
                          "07 July 2027"],
    },
    {
        "id": "N5b",
        "prompt": ("Prepare an individual shareholder consent form for Win Win Tint "
                   "using information from people database"),
        "person": "WIN WIN TINT",
        "answers": {"company": "ZENITH ORCHID VENTURES LIMITED",
                    "number of shares": "7,700",
                    "share": "7,700",
                    "capital": "77,000,000 MMK",
                    "amount": "77,000,000 MMK",
                    "date": "07 July 2027",
                    "birth": "1 January 1970",
                    "nationality": "Myanmar"},
        "default_answer": "",
        "expect_ask": ["compan", "share", "capital|amount"],
        "expect_in_doc": ["WIN WIN TINT", "ZENITH ORCHID VENTURES LIMITED",
                          "7,700", "77,000,000"],
    },
]


def run_case(token, user_id, case):
    session = f"E2E {case['id']} — {int(time.time())}"
    print(f"\n{'='*76}\n[{case['id']}] {case['prompt']}\n  session: {session}", flush=True)

    result = start(token, case["prompt"], session, user_id)
    transcript = []
    nudges = 0

    for turn in range(MAX_TURNS):
        if result["error"]:
            return {"status": "ERROR", "detail": result["error"], "session": session}

        if result["paused"]:
            answers, described = decide(result["paused"], case)
            if not answers:
                break
            for d in described:
                print(f"  answered: {d}", flush=True)
                transcript.append(d)
            result = answer_pause(token, result["paused"], answers, session, user_id)
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
            result = start(token, "continue", session, user_id)
            continue

        break

    body = result["content"]
    # Both alternatives anchor on `.docx`. `content` is the concatenation of
    # every RunContent chunk, so a link that arrives flush against the next
    # chunk ("…AGM_Minutes.docxThe minutes are ready.") must not have the
    # following word swallowed into the path.
    #
    # ★ Scope, measured rather than assumed: the second alternative was ALREADY
    # safe — `[^\s)"']+` is greedy but the required `\.docx` makes it backtrack
    # to the extension — and it is the only one that matches real output, because
    # the product emits `/documents/legal/output/<name>.docx`
    # (app/main.py:4555). There is NO `/api/documents/download/` route anywhere
    # in the product; that first alternative matches nothing the agent sends.
    # So this is defensive, not a live defect: it is a no-op on every real link
    # shape (plain, trailing space, markdown link) and it closes the greedy
    # alternative in case such a route is ever added.
    m = re.search(r"(/api/documents/download/[^\s)\"']+?\.docx|/documents/[^\s)\"']+?\.docx)", body)
    if not m:
        return {"status": "NO-DOC",
                "detail": f"no download link; reply={body[:120]!r}",
                "session": session, "answered": transcript}

    try:
        text = docx_text(token, m.group(1))
    except Exception as e:
        return {"status": "ERROR", "detail": f"could not read docx: {e}",
                "session": session, "answered": transcript}

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
    for spec in (case.get("expect_after") or []):
        marker, value = spec["marker"].lower(), spec["value"].lower()
        window = spec.get("within", 160)
        low = text.lower()
        at = low.find(marker)
        if at < 0:
            misplaced.append(f"marker {spec['marker']!r} not in document")
        elif value not in low[at + len(marker): at + len(marker) + window]:
            near = text[at + len(marker): at + len(marker) + window]
            near = " ".join(near.split())[:60]
            misplaced.append(f"{spec['value']!r} not after {spec['marker']!r} (found: {near!r})")

    # Some questions must actually be PUT to the user. If the agent stops asking
    # and starts assuming again, the document can still come out looking fine.
    # An entry may list alternatives as "a|b|c": the model's WORDING varies run to
    # run ("authorized director" / "signatory" / "representative") while the
    # question being asked is the same one, and pinning one spelling fails the
    # case for a reason that has nothing to do with the product.
    joined = " | ".join(transcript).lower()
    unasked = [v for v in case.get("expect_ask", [])
               if not any(alt in joined for alt in v.lower().split("|"))]

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
        "detail": ("all answers present in the .docx" if not problems
                   else " · ".join(problems))
                  + f" · {nudges} silent stop(s) had to be nudged",
        "session": session,
        "answered": transcript,
        "file": m.group(1),
        "nudges": nudges,
    }


def main():
    # Optional case-id filter: `python3 tests/tracker_layer3.py E3`. Every case
    # is a multi-turn conversation against a paid model, so re-running the ones
    # that already passed to reach the one under test is real money.
    wanted = {a.upper() for a in sys.argv[1:] if not a.startswith("-")}
    cases = [c for c in CASES if not wanted or c["id"].upper() in wanted]
    if wanted and not cases:
        sys.exit(f"No case matched {sorted(wanted)}; have {[c['id'] for c in CASES]}")

    token, user_id = login()
    rows = []
    for case in cases:
        try:
            out = run_case(token, user_id, case)
        except Exception as e:
            out = {"status": "ERROR", "detail": str(e)[:140], "session": "-"}
        rows.append((case["id"], out))
        print(f"  -> {out['status']}: {out['detail'][:120]}", flush=True)

    print(f"\n\n{'ID':<5} {'RESULT':<8} SESSION (open this in the app)")
    print("-" * 96)
    for cid, out in rows:
        print(f"{cid:<5} {out['status']:<8} {out['session']}")
        print(f"      {out['detail'][:88]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
