"""
Layer 2 of the client testing tracker — SCRIPTED, deterministic.

Layer 1 proves the DATA is right: the blank exists, the candidates come from the
right register, the date is not pre-filled. It cannot prove the BEHAVIOUR the
tracker actually complains about — "the system is automatically picking up the
first director", "not asked chair person", "auto filling the date".

That behaviour is observable only by talking to the agent, and until now this
file did exactly that: 14 real chat runs against a paid model. CLAUDE.md records
what that cost — "Layer 2/3 failures move between cases run to run; do not treat
one as a regression until it reproduces." A suite whose failures cannot be
trusted is not a gate.

WHAT CHANGED
------------
The MODEL is replaced by `scout.testing.ScriptedAgentRuntime`. Everything else —
the SSE parse, the PAUSED/ANSWERED/ERROR classification, and `verdict()`
character for character — is the code that was here before. The suite is
offline, needs no credentials and no container, and gives the same answer every
time.

WHAT IS UNDER TEST NOW
----------------------
Not the model. The verdict machinery, which is the part that decides whether a
transcript counts as a regression. Every case therefore runs TWICE:

  golden  — the agent behaves as the tracker requires. Must come out PASS.
  mutant  — the agent commits exactly the defect this case exists to catch.
            Must come out FAIL.

A case that only ever ran its golden script would pass just as happily against a
`verdict()` that returned "PASS" unconditionally. The mutant run is what makes
the case mean something, so a mutant that does NOT fail is itself reported as a
failure of this suite.

Real model behaviour still needs watching; that lives in `tracker_layer2_live.py`,
run on demand against a real stack.

Run:  python3 tests/tracker_layer2.py [case_id ...]
"""

import importlib.util
import json
import os
import re
import sys

# ── loading the runtime ─────────────────────────────────────────────
# Loaded by PATH, not as `from scout.testing import ...`.
#
# `scout/__init__.py` does `from scout.agent import scout`, and `scout/agent.py`
# imports `agno.tools.mcp.MCPTools`, which raises unless the `mcp` package is
# installed — it is not, on a dev laptop. So importing anything through the
# `scout` package drags in the whole agent and fails before this file runs.
# Loading the single module by file path keeps the suite runnable anywhere:
# `scripted_runtime.py` is stdlib-only and imports nothing from the package.
_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SPEC = importlib.util.spec_from_file_location(
    "scout_scripted_runtime",
    os.path.join(_REPO, "scout", "testing", "scripted_runtime.py"),
)
_RT = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_RT)

Ask, Complete, Error = _RT.Ask, _RT.Complete, _RT.Error
Pick, Text, ToolCall = _RT.Pick, _RT.Text, _RT.ToolCall
ScriptedAgentRuntime, candidate = _RT.ScriptedAgentRuntime, _RT.candidate

# Tools that mean the agent stopped to ask a human.
ASK_TOOLS = {"ask_questions"}
PICKER_HINT = re.compile(r"choose_|lookup_|picker", re.I)


def run_chat(runtime, message, session_id, user_id=None):
    """Post one turn, consume the stream, summarise what the agent did.

    The body below is the original — the only difference is where the stream
    comes from. `ScriptedAgentRuntime.start()` returns an object that iterates
    like the `urllib` response this used to read, byte line by byte line, so the
    parser is under test rather than bypassed.
    """
    tools, content, paused, questions, error = [], [], False, [], None

    for raw in runtime.start(message, session_id=session_id, user_id=user_id):
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            continue
        try:
            ev = json.loads(line[5:].strip(), strict=False)
        except (ValueError, TypeError):
            continue

        name = ev.get("event")
        if name == "ToolCallStarted":
            tool = (ev.get("tool") or {}).get("tool_name") or ev.get("tool_name")
            if tool:
                tools.append(tool)
        elif name == "RunContent":
            piece = ev.get("content")
            if isinstance(piece, str):
                content.append(piece)
        elif name == "RunPaused":
            paused = True
            for t in ev.get("tools") or []:
                tname = t.get("tool_name")
                if tname:
                    tools.append(tname)
                args = t.get("tool_args") or {}
                raw_q = args.get("questions_json")
                if raw_q:
                    try:
                        for q in json.loads(raw_q, strict=False):
                            questions.append(q.get("text", ""))
                    except (ValueError, TypeError):
                        questions.append(str(raw_q)[:120])
        elif name in ("RunError", "RunCancelled"):
            error = str(ev.get("content") or ev.get("error") or name)[:200]

    return {
        "tools": tools,
        "content": "".join(content).strip(),
        "paused": paused,
        "questions": questions,
        "error": error,
        # The live suite reported wall-clock seconds here. A scripted run has no
        # duration worth reporting, and a timing field is the one thing that
        # would stop two runs of this file being byte-identical.
        "seconds": 0.0,
    }


# ── cases, transcribed from the tracker's "To test" column ──────────
# expect: "asks"  → must pause for input (ask_questions or a picker)
#         "lists" → must answer, naming the templates in `must_mention`
CASES = [
    ("A0", "lists",
     "Provide all relevant templates required for an Annual General Meeting",
     ["Notice of Calling", "Notice of Annual General Meeting", "Minutes", "Resolution In Writing"]),
    ("A1", "asks",
     "Prepare Notice of Calling for Annual General Meeting for City Holdings", []),
    ("A2", "asks",
     "Prepare Notice of Annual General Meeting to Shareholders for City Holdings", []),
    ("A3", "asks",
     "Prepare Annual General Meeting Minutes for City Holdings", []),
    ("A4", "asks",
     "Prepare Annual General Meeting Minutes for City Mart Holding", []),
    ("A5", "asks",
     "Prepare Shareholders Resolution in Writing for AGM of City Mart Holding", []),

    ("B0", "lists",
     "What documents are required to set up a company?",
     ["Director Consent", "Shareholder Consent"]),
    ("B1", "asks",
     "Prepare director consent form (non group member) to appoint in a new company. "
     "Use information of Min Min from people database", []),
    ("B2", "asks",
     "To appoint a director in a new company, create a director consent form for Min Min "
     "using information from people database", []),
    ("B3", "asks",
     "Prepare a shareholder consent form for Soe Moe Thu using information from people database", []),
    ("B4", "asks",
     "Prepare a directors resolution for Pahtama Group Co., Ltd to set up a new company "
     "and appointment of directors", []),

    ("C1", "asks",
     "Using the information in people database, prepare a director consent form (group member) "
     "for Min Min to appoint in City Mart Holding.", []),
    ("C3", "asks",
     "Prepare resignation letter of Daw Win Win Tint from City Holdings", []),
    ("C4", "asks",
     "Prepare a shareholders meeting minutes for director appointment only for City Holdings", []),
]


# ── scripts ─────────────────────────────────────────────────────────
#
# One golden and one mutant per case. The golden is the behaviour the tracker
# demands; the mutant is the specific defect the case was written against, which
# for every "asks" case is the same one the client reported — answering from a
# guess instead of stopping to ask.


def asks_via_questions(question_text, tool="get_template", options=None):
    """The agent looks something up, then stops on an `ask_questions` card."""
    q = {"id": "q1", "text": question_text}
    if options:
        q["options"] = list(options)
    return [
        Text(reasoning="Need a value the register cannot supply; must ask."),
        ToolCall(tool, {"query": question_text}, result="ok"),
        Ask([q]),
    ]


def asks_via_picker(purpose, names, company="", tool="choose_director"):
    """The agent looks up candidates, then stops on a person picker.

    Layer 2 counts a picker as a pause with no questions attached — the detail
    line says "picker card" — so this covers the other half of `verdict()`'s
    PASS branch, which an `ask_questions`-only script would leave unexercised.
    """
    cands = [candidate(i + 1, n) for i, n in enumerate(names)]
    return [
        ToolCall("lookup_director_candidates", {"company_name": company}, result="ok"),
        Pick(tool, purpose, cands, company_name=company),
    ]


def guesses(reply, tools=("generate_document",)):
    """The defect: it produced a document without asking anyone anything."""
    turns = [ToolCall(t, {}, result="ok") for t in tools]
    turns.append(Complete(reply))
    return turns


def lists(items, extra="Here are the documents you will need: "):
    return [Complete(extra + ", ".join(items) + ".")]


_A0 = ["Notice of Calling of Annual General Meeting",
       "Notice of Annual General Meeting to Shareholders",
       "Annual General Meeting Minutes",
       "Shareholders Resolution In Writing"]
_B0 = ["Director Consent Form", "Shareholder Consent Form",
       "Directors Resolution", "Company Constitution"]

SCRIPTS = {
    # A0 — a pure listing question. It must ANSWER; pausing is not the pass
    # condition here, it is merely allowed.
    "A0": {"golden": lists(_A0),
           # Names three of the four. The tracker's complaint was documents the
           # agent forgot to mention, so the mutant drops one.
           "mutant": lists(_A0[:3])},

    "A1": {"golden": asks_via_questions("What is the date of the Annual General Meeting?"),
           "mutant": guesses("I have prepared the Notice of Calling using today's date.")},
    "A2": {"golden": asks_via_questions("Which director signs the notice?"),
           "mutant": guesses("Prepared, signed by the first director on the register.")},
    "A3": {"golden": asks_via_questions("Who chaired the meeting?"),
           # "not asked chair person" — the tracker's own words.
           "mutant": guesses("Minutes prepared with the first director as chair.")},
    "A4": {"golden": asks_via_questions("What is the meeting date?"),
           "mutant": guesses("Minutes prepared, dated today.")},
    "A5": {"golden": asks_via_picker("sign the AGM resolution",
                                     ["KYAW THU SOE", "PHYOE MIN KYAW"],
                                     company="CITY MART HOLDING COMPANY LIMITED"),
           "mutant": guesses("Resolution prepared and signed by MIN MIN.")},

    # B0 — lists AND then offers a follow-up chip. That is the DESIRED
    # behaviour, not a partial one: an earlier version of `verdict()` failed a
    # run that named every template and then asked "generate one now?". The
    # golden script deliberately pauses after a complete answer, so a
    # regression back to that stricter rule fails here.
    "B0": {"golden": [Text(content="Here are the documents you will need: "
                                   + ", ".join(_B0) + "."),
                      Ask([{"id": "q1", "text": "Shall I generate one now?",
                            "options": ["Yes", "No"]}])],
           # Incomplete list AND a pause — the branch that has to report both.
           "mutant": [Text(content="You will need a Director Consent Form."),
                      Ask([{"id": "q1", "text": "Shall I generate it now?"}])]},

    "B1": {"golden": asks_via_questions("Which company is the director being appointed to?"),
           "mutant": guesses("Consent form prepared for Min Min.")},
    "B2": {"golden": asks_via_questions("What is the appointment date?"),
           "mutant": guesses("Consent form prepared, dated today.")},
    "B3": {"golden": asks_via_questions("How many shares does the shareholder hold?"),
           "mutant": guesses("Shareholder consent prepared for Soe Moe Thu.")},
    "B4": {"golden": asks_via_picker("be appointed as director",
                                     ["MIN MIN", "SOE MOE THU", "WIN WIN TINT"],
                                     company="PAHTAMA GROUP CO., LTD",
                                     tool="choose_person_from_register"),
           # "the system is automatically picking up the first director".
           "mutant": guesses("Resolution prepared appointing MIN MIN.")},

    "C1": {"golden": asks_via_picker("represent the corporate shareholder",
                                     ["KYAW THU SOE", "PHYOE MIN KYAW"],
                                     company="CITY MART HOLDING COMPANY LIMITED",
                                     tool="choose_representative_director"),
           "mutant": guesses("Consent form prepared for Min Min at City Mart Holding.")},
    "C3": {"golden": asks_via_questions("What is the effective date of resignation?"),
           "mutant": guesses("Resignation letter prepared, effective today.")},
    "C4": {"golden": asks_via_questions("Who chaired the shareholders meeting?"),
           "mutant": guesses("Minutes prepared with the first director as chair.")},
}


def verdict(case, result):
    cid, expect, _prompt, must_mention = case
    if result["error"]:
        return "ERROR", result["error"]

    if expect == "asks":
        if result["paused"]:
            asked = "; ".join(q for q in result["questions"] if q)[:150]
            return "PASS", f"paused and asked — {asked or 'picker card'}"
        return "FAIL", (
            "answered without asking — "
            f"tools={result['tools'][:5] or 'none'} · "
            f"reply={result['content'][:90]!r}"
        )

    # expect == "lists"
    #
    # Listing AND then offering a follow-up chip is the desired behaviour, not a
    # partial one — the earlier version of this check failed a run that named
    # every template and then asked "generate one now?", which is exactly what
    # we want. Only the CONTENT decides the verdict; a pause is additive.
    body = result["content"]
    missing = [m for m in must_mention if m.lower() not in body.lower()]
    if missing:
        return "FAIL", (
            f"missing from answer: {missing}"
            + (" (and it paused before finishing the list)" if result["paused"] else "")
        )
    tail = " · then offered a follow-up" if result["paused"] else ""
    return "PASS", f"listed all expected ({len(body)} chars){tail}"


# ── protocol checks ─────────────────────────────────────────────────
# Branches of the classifier that no case script reaches on its own.

def protocol_checks():
    """(name, expected_status, script) — each run through the same pipeline."""
    return [
        # A failed run must classify as ERROR, not as a silent pass. Nothing in
        # the case list produces one.
        ("error-run", "ERROR",
         [ToolCall("get_template", {}, result="ok"),
          Error("provider rejected the dangling tool call")]),
        # An empty reply with no pause is not an "ask". The blank-bubble bug
        # made this exact shape, and it must read as FAIL for an "asks" case.
        ("empty-reply", "FAIL",
         [ToolCall("get_template", {}, result="ok"), Complete("")]),
    ]


def main():
    wanted = set(sys.argv[1:])
    rows = []
    failures = 0

    for case in CASES:
        cid, expect, prompt, _ = case
        if wanted and cid not in wanted:
            continue
        scripts = SCRIPTS[cid]
        print(f"\n{'='*78}\n[{cid}] expect={expect}\n> {prompt}", flush=True)

        for variant, want_status in (("golden", "PASS"), ("mutant", "FAIL")):
            runtime = ScriptedAgentRuntime(scripts[variant])
            result = run_chat(runtime, prompt, f"Test {cid} {variant}", 1)
            status, detail = verdict(case, result)
            ok = status == want_status
            if not ok:
                failures += 1
            rows.append((f"{cid}/{variant}", status, want_status, ok, detail))
            print(f"  {variant:<6} tools={result['tools'][:4]}", flush=True)
            for q in result["questions"]:
                print(f"         asked: {q[:110]}", flush=True)
            if result["content"]:
                print(f"         reply: {result['content'][:120]}", flush=True)
            print(f"      -> {status} (want {want_status}) {'OK' if ok else '<<< SUITE FAILURE'}"
                  f": {detail[:110]}", flush=True)

    if not wanted:
        print(f"\n{'='*78}\nprotocol checks", flush=True)
        for name, want_status, script in protocol_checks():
            runtime = ScriptedAgentRuntime(script)
            result = run_chat(runtime, "probe", f"protocol {name}", 1)
            # Classified as an "asks" case: that is the branch these shapes
            # would otherwise slip through.
            status, detail = verdict((name, "asks", "probe", []), result)
            ok = status == want_status
            if not ok:
                failures += 1
            rows.append((name, status, want_status, ok, detail))
            print(f"  {name:<14} -> {status} (want {want_status}) "
                  f"{'OK' if ok else '<<< SUITE FAILURE'}: {detail[:90]}", flush=True)

    print(f"\n\n{'CASE':<16} {'GOT':<7} {'WANT':<7} {'':<4} DETAIL")
    print("-" * 100)
    for name, status, want, ok, detail in rows:
        print(f"{name:<16} {status:<7} {want:<7} {'ok' if ok else 'BAD':<4} {detail[:60]}")

    print(f"\nSUMMARY: {len(rows)} checks · {failures} unexpected")
    if failures:
        print("A mutant that did not FAIL means the verdict rule it targets no "
              "longer discriminates — treat it as a broken gate, not a flake.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
