"""
Layer 2 LIVE — the original suite, driving the REAL agent over HTTP.

This is the on-demand variant. It costs money, needs a running stack, and its
failures move between cases run to run, so it is not a regression gate: use it
to observe what the model actually does. `tracker_layer2.py` is the scripted,
deterministic suite that runs in CI. Behaviour here is unchanged from the
version that file replaced.

Layer 2 of the client testing tracker — real chat runs through the agent API.

Layer 1 proves the DATA is right: the blank exists, the candidates come from the
right register, the date is not pre-filled. It cannot prove the BEHAVIOUR the
tracker actually complains about — "the system is automatically picking up the
first director", "not asked chair person", "auto filling the date".

That behaviour is only observable by talking to the agent. This drives each
tracker prompt through `POST /agents/scout/runs`, reads the SSE stream, and
records what the agent did:

  PAUSED   — it stopped and asked (ask_questions card or a person picker).
             For most cases this is the PASS condition: ask, do not guess.
  ANSWERED — it replied without pausing. Fine for a listing question,
             a failure for anything needing a signatory or a date.
  ERROR    — the run failed.

Each case declares what it expects, so the verdict is mechanical rather than a
human reading transcripts.

Run:  ADMIN_PASSWORD=... python3 tests/tracker_layer2.py [case_id ...]
"""

import json
import os
import re
import sys
import time
import urllib.request

BASE = os.environ.get("SCOUT_BASE", "http://localhost:8080")
EMAIL = os.environ.get("ADMIN_EMAIL", "admin@legalscout.com")
PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
TIMEOUT = int(os.environ.get("RUN_TIMEOUT", "240"))

# Tools that mean the agent stopped to ask a human.
ASK_TOOLS = {"ask_questions"}
PICKER_HINT = re.compile(r"choose_|lookup_|picker", re.IGNORECASE)


def login():
    """Return (token, user_id). The user id tags each run so the test sessions
    show up in the app's own chat sidebar rather than being stored invisibly."""
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
    user = out.get("user") or {}
    return token, user.get("id")


def _multipart(fields):
    """Minimal multipart encoder — the runs endpoint takes form data, not JSON."""
    boundary = "----scoutTracker"
    parts = []
    for k, v in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n')
    parts.append(f"--{boundary}--\r\n")
    return boundary, "".join(parts).encode()


def run_chat(token, message, session_id, user_id=None):
    """POST one turn, consume the SSE stream, summarise what the agent did.

    `user_id` matters for more than bookkeeping: the session list in the app is
    filtered per user, so a run posted without it is stored but invisible in the
    chat sidebar. Sending it lets an operator open any test run and read the
    whole conversation in the normal interface.
    """
    fields = {"message": message, "stream": "true", "session_id": session_id}
    if user_id is not None:
        fields["user_id"] = str(user_id)
    boundary, payload = _multipart(fields)
    req = urllib.request.Request(f"{BASE}/agents/scout/runs", data=payload, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    req.add_header("Authorization", f"Bearer {token}")

    tools, content, paused, questions, error = [], [], False, [], None
    started = time.time()

    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
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
        "seconds": round(time.time() - started, 1),
    }


# ── cases, transcribed from the tracker's "To test" column ──────────
# expect: "asks"  → must pause for input (ask_questions or a picker)
#         "lists" → must answer, naming the templates in `must_mention`
CASES = [
    (
        "A0",
        "lists",
        "Provide all relevant templates required for an Annual General Meeting",
        ["Notice of Calling", "Notice of Annual General Meeting", "Minutes", "Resolution In Writing"],
    ),
    ("A1", "asks", "Prepare Notice of Calling for Annual General Meeting for City Holdings", []),
    ("A2", "asks", "Prepare Notice of Annual General Meeting to Shareholders for City Holdings", []),
    ("A3", "asks", "Prepare Annual General Meeting Minutes for City Holdings", []),
    ("A4", "asks", "Prepare Annual General Meeting Minutes for City Mart Holding", []),
    ("A5", "asks", "Prepare Shareholders Resolution in Writing for AGM of City Mart Holding", []),
    ("B0", "lists", "What documents are required to set up a company?", ["Director Consent", "Shareholder Consent"]),
    (
        "B1",
        "asks",
        "Prepare director consent form (non group member) to appoint in a new company. "
        "Use information of Min Min from people database",
        [],
    ),
    (
        "B2",
        "asks",
        "To appoint a director in a new company, create a director consent form for Min Min "
        "using information from people database",
        [],
    ),
    ("B3", "asks", "Prepare a shareholder consent form for Soe Moe Thu using information from people database", []),
    (
        "B4",
        "asks",
        "Prepare a directors resolution for Pahtama Group Co., Ltd to set up a new company "
        "and appointment of directors",
        [],
    ),
    (
        "C1",
        "asks",
        "Using the information in people database, prepare a director consent form (group member) "
        "for Min Min to appoint in City Mart Holding.",
        [],
    ),
    ("C3", "asks", "Prepare resignation letter of Daw Win Win Tint from City Holdings", []),
    ("C4", "asks", "Prepare a shareholders meeting minutes for director appointment only for City Holdings", []),
]


def verdict(case, result):
    _cid, expect, _prompt, must_mention = case
    if result["error"]:
        return "ERROR", result["error"]

    if expect == "asks":
        if result["paused"]:
            asked = "; ".join(q for q in result["questions"] if q)[:150]
            return "PASS", f"paused and asked — {asked or 'picker card'}"
        return "FAIL", (
            f"answered without asking — tools={result['tools'][:5] or 'none'} · reply={result['content'][:90]!r}"
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


def main():
    token, user_id = login()
    wanted = set(sys.argv[1:])
    stamp = int(time.time())
    rows = []

    for case in CASES:
        cid, expect, prompt, _ = case
        if wanted and cid not in wanted:
            continue
        print(f"\n{'=' * 78}\n[{cid}] expect={expect}\n> {prompt}", flush=True)
        try:
            result = run_chat(token, prompt, f"Test {cid} — {stamp}", user_id)
        except Exception as e:
            rows.append((cid, "ERROR", str(e)[:110]))
            print(f"  ERROR {e}", flush=True)
            continue

        status, detail = verdict(case, result)
        rows.append((cid, status, detail))
        print(f"  tools: {result['tools'][:6]}", flush=True)
        if result["questions"]:
            for q in result["questions"]:
                print(f"  asked: {q[:110]}", flush=True)
        if result["content"]:
            print(f"  reply: {result['content'][:200]}...", flush=True)
        print(f"  -> {status}: {detail[:150]}  ({result['seconds']}s)", flush=True)

    print(f"\n\n{'ID':<5} {'RESULT':<9} DETAIL")
    print("-" * 100)
    for cid, status, detail in rows:
        print(f"{cid:<5} {status:<9} {detail[:88]}")
    counts = {}
    for _, s, _ in rows:
        counts[s] = counts.get(s, 0) + 1
    print("\nSUMMARY: " + " · ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    return 1 if counts.get("FAIL") or counts.get("ERROR") else 0


if __name__ == "__main__":
    sys.exit(main())
