"""
ScriptedAgentRuntime — a deterministic stand-in for the Scout agent.

WHY THIS EXISTS
---------------
`tracker_layer2.py` and `tracker_layer3.py` were HTTP clients pointed at
`POST /agents/scout/runs`, which means every assertion in them sat downstream of
a paid model. CLAUDE.md says so out loud:

    "Layer 2/3 failures move between cases run to run; do not treat one as a
     regression until it reproduces."

A suite whose failures cannot be trusted is not a gate. This module replaces the
MODEL, not the machinery: the suites keep their own SSE parser, their own
pause/resume echo, their own `.docx` unzip and every assertion they had. Only
the thing on the other end of the socket changes.

WHAT SURFACE IT IMPLEMENTS
--------------------------
The tracker suites never import `scout.agent` — they speak HTTP to AgentOS and
read the agno event stream. (They could not import it anyway: `scout/agent.py:38`
imports `agno.tools.mcp.MCPTools`, and `mcp` is not installed on a dev laptop.)
So the surface modelled here is the wire surface, faithfully:

  * `start(message, ...)`        → `POST /agents/{id}/runs`      → an SSE stream
  * `continue_run(...)`          → `POST /agents/{id}/runs/{run_id}/continue`
  * `download(url)`              → `GET /api/documents/download/...`

`start` and `continue_run` return an object that iterates like the file-like
`urllib` response the suites already loop over: byte lines, some `data: {...}`,
some blank, some not SSE at all. The suites' existing `_consume()` reads it
unchanged.

Event names and payload shapes follow agno's:

  ToolCallStarted   {"tool": {"tool_name", "tool_args", "tool_call_id"}}
  ToolCallCompleted {"tool": {..., "result"}}
  RunContent        {"content": str, "reasoning_content": str}
  RunPaused         {"run_id", "agent_id", "tools": [ToolExecution, ...]}
  RunCompleted / RunError

A paused turn emits **no** ToolCallStarted. That is not a shortcut — agno pauses
*before* executing a `requires_user_input=True` tool (see the TIMING note in
`scout/tools/ask_questions.py`), so the only place a paused tool's name appears
is inside the RunPaused payload. `tracker_layer2.run_chat` harvests tool names
from exactly there, and would be wrong against a runtime that announced them
twice.

DETERMINISM
-----------
No wall clock, no `random`, no network, no filesystem reads. Every identifier is
derived from the turn index: run `N` is `run-000`-style, its tool calls
`call-000-0`. Two processes running the same script produce byte-identical
streams.

THE SCRIPT
----------
A script is a flat list of turns. The runtime walks it in order and ends the
current stream when it reaches a turn that ends a stream — `Ask`, `Pick`,
`Complete` or `Error`. The next `start()` / `continue_run()` picks up at the
next index. Turn kinds:

    Text(content, reasoning)      assistant prose (and/or invisible thinking)
    ToolCall(name, args, result)  an ordinary tool call with a canned result
    Ask(questions)                pause on `ask_questions`
    Pick(tool, purpose, cands)    pause on a person picker
    Document(template, url)       build a .docx from the answers collected so far
    Complete(content)             end of turn
    Error(message)                a failed run

WHAT IS AND IS NOT UNDER TEST
-----------------------------
`Document` does not paste the expected strings into a file — that would be a
test asserting nothing. It fills a template through `fill_template()`, which
resolves each slot from the run's RECORDED state: the person actually chosen in
a picker, the answer actually submitted for a question. `resolve_mode` can be
flipped to `"first_candidate"` to reproduce the historical corporate-representative
bug (take `candidates[0]` and never mind the choice), which is how the Layer 3
suite proves its own document assertions can still fail.

What this suite therefore gates is the harness and the protocol: the SSE parse,
the pause/resume echo, the answer plumbing, the `.docx` read-back and every
verdict rule. It does NOT gate the model's behaviour. That stays in
`tracker_layer2_live.py` / `tracker_layer3_live.py`, run on demand.
"""

import io
import json
import re
import zipfile

__all__ = [
    "Ask",
    "Complete",
    "Document",
    "Error",
    "Pick",
    "ScriptedAgentRuntime",
    "ScriptedRunError",
    "Text",
    "ToolCall",
    "candidate",
    "fill_template",
]


class ScriptedRunError(Exception):
    """The script and the caller disagree — a harness bug, not a product one."""


# ---------------------------------------------------------------------------
# Turns
# ---------------------------------------------------------------------------
# Written as plain classes rather than dataclasses: this file has to run on the
# system python3.9 the tracker scripts already use, with no dependencies.


class _Turn(object):
    ends_stream = False


class Text(_Turn):
    """Assistant output. `reasoning` streams on `reasoning_content`, which the
    model does emit separately — a turn with reasoning and no content is the
    'silent stop' Layer 3 has to nudge through."""

    def __init__(self, content="", reasoning=""):
        self.content = content
        self.reasoning = reasoning


class ToolCall(_Turn):
    """An ordinary (non-pausing) tool call and its canned result."""

    def __init__(self, name, args=None, result=""):
        self.name = name
        self.args = dict(args or {})
        self.result = result


class Ask(_Turn):
    """Pause on `ask_questions`.

    `questions` is the list the model would have put in `questions_json`:
    {"id", "text", "options"?}. The runtime serialises it exactly the way the
    tool receives it, so the suites' `json.loads(args["questions_json"])` is
    real work rather than a fixture handed to them pre-parsed.
    """

    ends_stream = True

    def __init__(self, questions):
        self.questions = [dict(q) for q in questions]


class Pick(_Turn):
    """Pause on one of the person pickers in `scout/tools/people_picker.py`.

    `candidates` are `candidate()` dicts. They are wrapped in the same envelope
    `people_picker._payload()` builds, because `tracker_layer3.decide()` reaches
    into `candidates_json` -> `["candidates"]` and would not survive a flatter
    shape.
    """

    ends_stream = True

    def __init__(self, tool, purpose, candidates, company_name="", extra_args=None):
        self.tool = tool
        self.purpose = purpose
        self.candidates = [dict(c) for c in candidates]
        self.company_name = company_name
        self.extra_args = dict(extra_args or {})


class Document(_Turn):
    """Generate a `.docx` from the state collected so far.

    Emits the generating tool call and a RunContent carrying the download link
    in the same prose shape the agent writes it, because Layer 3 finds the file
    by regex over the reply rather than by a structured field.
    """

    def __init__(self, template, filename="scripted.docx", tool_name="generate_document",
                 trailing="\n"):
        self.template = template
        self.filename = filename
        self.tool_name = tool_name
        # What follows the link in the same content chunk. The default newline
        # is what a real stream puts between the link and whatever comes next.
        # Setting it to "" makes the next chunk land FLUSH against the URL,
        # which is the shape that breaks an unanchored extraction regex — see
        # the note in `_play` and case E6 in tracker_layer3.py.
        self.trailing = trailing


class Complete(_Turn):
    """End of turn."""

    ends_stream = True

    def __init__(self, content=""):
        self.content = content


class Error(_Turn):
    """A failed run — RunError, which both suites treat as ERROR."""

    ends_stream = True

    def __init__(self, message):
        self.message = message


# ---------------------------------------------------------------------------
# Candidate helper — mirrors people_picker._candidate()
# ---------------------------------------------------------------------------


def candidate(person_id, name, identifier="", subtitle="", party_type="individual",
              source="company_people", representatives=None):
    """The candidate shape the chat UI (and therefore `decide()`) expects.

    Kept field-for-field with `people_picker._candidate()`. If that shape drifts,
    the scripted suite should drift with it — a fixture that has quietly stopped
    resembling the payload it stands in for is worse than no fixture.
    """
    return {
        "id": str(person_id) if person_id is not None else "name:%s" % name,
        "name": name or "",
        "identifier": identifier or "",
        "subtitle": subtitle or "",
        "party_type": party_type,
        "source": source,
        "representatives": list(representatives or []),
    }


# ---------------------------------------------------------------------------
# Template fill
# ---------------------------------------------------------------------------

_TOKEN = re.compile(r"\{\{([a-z_]+)(?::([^}]*))?\}\}")


def fill_template(template, state, resolve_mode="chosen"):
    """Resolve `{{slot}}` tokens against what the run actually recorded.

    Slots:
      {{company}}          the document's company, as declared by the script
      {{picked:needle}}    the person chosen in the picker whose PURPOSE contains
                           `needle` (case-insensitive)
      {{answer:needle}}    the answer submitted for the question whose TEXT
                           contains `needle`
      {{literal:text}}     passed through — for fixed template prose

    `resolve_mode="first_candidate"` reproduces the defect the E3/E4 cases were
    written for: the representative slot resolves to the member company's first
    director and the user's choice is discarded. Nothing else changes, so a run
    under that mode is a true negative control — the assertions fire because the
    resolution is wrong, not because the test was edited.

    An unresolved slot renders as `[unfilled:<slot>]` rather than an empty
    string. A blank would let a missing value read as a legitimately empty
    field, which is the same failure mode as the U+00A0 placeholder bug.
    """
    if resolve_mode not in ("chosen", "first_candidate"):
        raise ScriptedRunError("unknown resolve_mode %r" % (resolve_mode,))

    def resolve(match):
        slot, arg = match.group(1), (match.group(2) or "")
        if slot == "literal":
            return arg
        if slot == "company":
            return state.get("company", "") or "[unfilled:company]"
        if slot == "picked":
            for sel in state.get("selections", []):
                if arg.lower() in str(sel.get("purpose", "")).lower():
                    if resolve_mode == "first_candidate":
                        offered = sel.get("offered") or []
                        if offered:
                            return str(offered[0].get("name", ""))
                    return str((sel.get("chosen") or {}).get("name", ""))
            return "[unfilled:picked:%s]" % arg
        if slot == "answer":
            for ans in state.get("answers", []):
                if arg.lower() in str(ans.get("text", "")).lower():
                    return str(ans.get("value", ""))
            return "[unfilled:answer:%s]" % arg
        return "[unfilled:%s]" % slot

    return _TOKEN.sub(resolve, template)


def _docx_bytes(text):
    """A real .docx — a zip with `word/document.xml`.

    Built rather than faked because Layer 3's read-back is
    `zipfile -> word/document.xml -> strip tags`, and that path should keep
    running. Each line becomes a paragraph, so tag-stripping concatenates the
    document in reading order and `expect_after`'s character window means what
    it means against a real file.
    """
    paragraphs = []
    for line in text.splitlines():
        safe = (line.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
        paragraphs.append("<w:p><w:r><w:t>%s</w:t></w:r></w:p>" % safe)
    xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body>%s</w:body></w:document>" % "".join(paragraphs)
    )
    buf = io.BytesIO()
    # Fixed date_time on every entry: zipfile defaults to time.localtime(), and
    # a timestamp in the archive would make two identical runs produce different
    # bytes. This is the only place the clock could have leaked in.
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        info = zipfile.ZipInfo("word/document.xml", date_time=(1980, 1, 1, 0, 0, 0))
        z.writestr(info, xml)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# The stream
# ---------------------------------------------------------------------------


class _SSEStream(object):
    """Iterates like the `urllib` response the suites already consume.

    Deliberately includes a blank line and one non-`data:` line per stream. The
    real endpoint emits both, the suites' parsers skip anything not starting
    with `data:`, and a stream that only ever produced clean events would stop
    exercising that filter.
    """

    def __init__(self, events):
        self._events = list(events)

    def __iter__(self):
        yield b": scripted stream\n"
        for ev in self._events:
            yield ("data: %s\n" % json.dumps(ev, sort_keys=True)).encode("utf-8")
            yield b"\n"

    # Context-manager parity with `urllib.request.urlopen`, so a caller can be
    # written the same way against either.
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


# ---------------------------------------------------------------------------
# The runtime
# ---------------------------------------------------------------------------


class ScriptedAgentRuntime(object):
    """Drive the tracker suites off a script instead of a model.

    Usage mirrors the HTTP calls one for one::

        rt = ScriptedAgentRuntime(script, company="CITY HOLDINGS LIMITED")
        stream = rt.start("Prepare ...", session_id="E1", user_id=1)
        result = _consume(stream)                      # the suite's own parser
        stream = rt.continue_run(result["paused"]["run_id"], "scout", tools_json)
    """

    def __init__(self, script, company="", agent_id="scout", resolve_mode="chosen"):
        self.script = list(script)
        self.company = company
        self.agent_id = agent_id
        self.resolve_mode = resolve_mode

        self._index = 0          # next turn to play
        self._run_seq = 0        # how many streams have been opened
        self._pending = None     # the turn we are paused on, if any
        self._pending_run = None

        # What the conversation actually recorded. `fill_template` reads this,
        # and the suites can inspect it to assert plumbing rather than prose.
        self.state = {"company": company, "answers": [], "selections": []}
        self.documents = {}      # download url -> bytes
        self.messages = []       # every message posted, in order
        self.continues = []      # every resume payload, as received

    # -- ids ---------------------------------------------------------------
    # Derived from the stream index, never from a clock or a counter that could
    # be reordered by test selection.

    def _run_id(self, seq):
        return "run-%03d" % seq

    def _tool_call_id(self, seq, n):
        return "call-%03d-%d" % (seq, n)

    # -- the two POSTs -----------------------------------------------------

    def start(self, message, session_id="scripted", user_id=1):
        """`POST /agents/{id}/runs`.

        A message of "continue" is the browser's one-shot nudge after a silent
        stop, and Layer 3 sends it too. It is recorded but does not rewind the
        script: the script author decides what the nudge produces by putting the
        next turns after the silent stop.
        """
        if self._pending is not None:
            raise ScriptedRunError(
                "start() while the run is paused on %s — the suite must resume "
                "via continue_run() first" % type(self._pending).__name__
            )
        self.messages.append({"message": message, "session_id": session_id,
                              "user_id": user_id})
        return self._play()

    def continue_run(self, run_id, agent_id, tools_json, session_id="scripted", user_id=1):
        """`POST /agents/{agent_id}/runs/{run_id}/continue`.

        The `tools_json` string is the one the suite built, and it is parsed here
        the way the server parses it. That matters: `answer_pause()` echoes the
        WHOLE ToolExecution back with only the target field filled, because
        dropping a field wipes it server-side and the provider then rejects the
        dangling tool call. So a resume that loses `questions_json` /
        `candidates_json` produces a RunError here, exactly as it would in
        production. If that echo ever regresses, this runtime fails the suite
        instead of quietly accepting a payload the real server would reject.
        """
        if self._pending is None:
            raise ScriptedRunError("continue_run() with no paused run")
        if run_id != self._pending_run:
            raise ScriptedRunError(
                "continue_run() posted to %r but the paused run is %r"
                % (run_id, self._pending_run)
            )
        if agent_id != self.agent_id:
            raise ScriptedRunError("continue_run() posted to agent %r" % (agent_id,))

        try:
            tools = json.loads(tools_json)
        except (ValueError, TypeError) as exc:
            raise ScriptedRunError("resume payload is not JSON: %s" % exc)
        self.continues.append(tools)

        turn = self._pending
        fields = self._echoed_fields(tools)
        self._pending = None
        self._pending_run = None

        err = self._record_answer(turn, fields)
        if err:
            return self._error_stream(err)
        return self._play()

    def download(self, url):
        """`GET /api/documents/download/...` — the generated file's bytes."""
        key = url.split("?")[0]
        if key not in self.documents:
            raise ScriptedRunError("no scripted document at %r" % (url,))
        return self.documents[key]

    # -- resume payload ----------------------------------------------------

    @staticmethod
    def _echoed_fields(tools):
        """Flatten the echoed `user_input_schema` back into tool arguments.

        Only fields that came back are kept. A field the caller dropped is
        genuinely gone, which is the server behaviour `answer_pause` guards
        against.
        """
        fields = {}
        for tool in tools or []:
            for field in tool.get("user_input_schema") or []:
                name = field.get("name")
                if name:
                    fields[name] = field.get("value")
        return fields

    def _record_answer(self, turn, fields):
        """Write the user's answer into run state. Returns an error string or None."""
        if isinstance(turn, Ask):
            if not fields.get("questions_json"):
                return ("dangling tool call: questions_json was dropped from the "
                        "resume payload")
            raw = fields.get("answers")
            try:
                picked = json.loads(raw) if raw else {}
            except (ValueError, TypeError):
                return "answers was not JSON: %r" % (raw,)
            if not isinstance(picked, dict):
                return "answers must be a JSON object of {question_id: value}"
            by_id = dict((q.get("id"), q.get("text") or "") for q in turn.questions)
            for qid, value in picked.items():
                if qid not in by_id:
                    return "answer for unknown question id %r" % (qid,)
                self.state["answers"].append(
                    {"id": qid, "text": by_id[qid], "value": value}
                )
            return None

        if isinstance(turn, Pick):
            if not fields.get("candidates_json"):
                return ("dangling tool call: candidates_json was dropped from the "
                        "resume payload")
            raw = fields.get("selected")
            try:
                chosen = json.loads(raw) if raw else None
            except (ValueError, TypeError):
                return "selected was not JSON: %r" % (raw,)
            if not chosen:
                return "picker resumed with no selection"
            # `offered` is kept alongside the choice so `first_candidate` mode
            # can reproduce the old bug without the script having to describe it.
            self.state["selections"].append(
                {"tool": turn.tool, "purpose": turn.purpose,
                 "chosen": chosen, "offered": list(turn.candidates)}
            )
            return None

        return "resumed a turn that does not pause: %s" % type(turn).__name__

    # -- playback ----------------------------------------------------------

    def _error_stream(self, message):
        seq = self._run_seq
        self._run_seq += 1
        return _SSEStream([{"event": "RunError", "run_id": self._run_id(seq),
                            "agent_id": self.agent_id, "content": message}])

    def _play(self):
        """Emit events until a turn ends the stream, or the script runs out."""
        seq = self._run_seq
        self._run_seq += 1
        run_id = self._run_id(seq)
        events = []
        calls = 0

        while self._index < len(self.script):
            turn = self.script[self._index]
            self._index += 1

            if isinstance(turn, Text):
                ev = {"event": "RunContent", "run_id": run_id}
                if turn.content:
                    ev["content"] = turn.content
                if turn.reasoning:
                    ev["reasoning_content"] = turn.reasoning
                events.append(ev)
                continue

            if isinstance(turn, ToolCall):
                cid = self._tool_call_id(seq, calls)
                calls += 1
                events.append({"event": "ToolCallStarted", "run_id": run_id,
                               "tool": {"tool_call_id": cid, "tool_name": turn.name,
                                        "tool_args": turn.args}})
                events.append({"event": "ToolCallCompleted", "run_id": run_id,
                               "tool": {"tool_call_id": cid, "tool_name": turn.name,
                                        "tool_args": turn.args,
                                        "result": turn.result}})
                continue

            if isinstance(turn, Document):
                cid = self._tool_call_id(seq, calls)
                calls += 1
                text = fill_template(turn.template, self.state, self.resolve_mode)
                url = "/api/documents/download/%s-%s" % (self._run_id(seq), turn.filename)
                self.documents[url] = _docx_bytes(text)
                events.append({"event": "ToolCallStarted", "run_id": run_id,
                               "tool": {"tool_call_id": cid, "tool_name": turn.tool_name,
                                        "tool_args": {"filename": turn.filename}}})
                events.append({"event": "ToolCallCompleted", "run_id": run_id,
                               "tool": {"tool_call_id": cid, "tool_name": turn.tool_name,
                                        "tool_args": {"filename": turn.filename},
                                        "result": json.dumps({"download_url": url})}})
                # `turn.trailing` is what separates the link from the next
                # chunk. `content` is the concatenation of every RunContent
                # chunk, so with trailing="" the following word lands flush
                # against the URL ("…e1-minutes.docxThe minutes are ready.").
                #
                # A real stream normally separates them, hence the newline
                # default — but the SUITE must not depend on that, because the
                # extraction regex is the thing under test. Case E6 sets
                # trailing="" deliberately so the anchored pattern is pinned by
                # a test instead of by this comment.
                events.append({"event": "RunContent", "run_id": run_id,
                               "content": "The document is ready: %s%s"
                                          % (url, turn.trailing)})
                continue

            if isinstance(turn, (Ask, Pick)):
                self._pending = turn
                self._pending_run = run_id
                events.append({"event": "RunPaused", "run_id": run_id,
                               "agent_id": self.agent_id,
                               "tools": [self._paused_tool(turn, seq, calls)]})
                return _SSEStream(events)

            if isinstance(turn, Complete):
                if turn.content:
                    events.append({"event": "RunContent", "run_id": run_id,
                                   "content": turn.content})
                events.append({"event": "RunCompleted", "run_id": run_id,
                               "agent_id": self.agent_id})
                return _SSEStream(events)

            if isinstance(turn, Error):
                events.append({"event": "RunError", "run_id": run_id,
                               "agent_id": self.agent_id, "content": turn.message})
                return _SSEStream(events)

            raise ScriptedRunError("unknown turn %r" % (turn,))

        # Script exhausted without an explicit end. Close the run rather than
        # returning a stream that never terminates — a suite waiting on a stream
        # that will not end is the hang this whole module exists to remove.
        events.append({"event": "RunCompleted", "run_id": run_id,
                       "agent_id": self.agent_id})
        return _SSEStream(events)

    def _paused_tool(self, turn, seq, calls):
        """One agno `ToolExecution`, as it appears inside RunPaused.

        `user_input_schema` lists EVERY parameter of the tool, not just the
        user-filled one — agno builds it from `sig.parameters` with no
        exclusions, which is why the pickers must not declare `run_context`
        (see `people_picker._session_of`). The suites echo the whole schema back.
        """
        cid = self._tool_call_id(seq, calls)
        if isinstance(turn, Ask):
            args = {"questions_json": json.dumps(turn.questions, sort_keys=True),
                    "answers": ""}
            schema = [
                {"name": "questions_json", "field_type": "str",
                 "description": "The questions to ask", "value": args["questions_json"]},
                {"name": "answers", "field_type": "str",
                 "description": "Filled in by the user", "value": None},
            ]
            return {"tool_call_id": cid, "tool_name": "ask_questions",
                    "tool_args": args, "requires_user_input": True,
                    "user_input_schema": schema}

        payload = {
            "picker": turn.tool,
            "purpose": turn.purpose,
            "session": "scripted",
            "company": {"name": turn.company_name} if turn.company_name else {},
            "multi_select": False,
            "candidates": turn.candidates,
            "allow_new": True,
            "new_person_fields": [],
            "note": "",
        }
        args = {"purpose": turn.purpose,
                "candidates_json": json.dumps(payload, sort_keys=True),
                "selected": ""}
        if turn.company_name:
            args["company_name"] = turn.company_name
        args.update(turn.extra_args)
        schema = [{"name": name, "field_type": "str", "description": "",
                   "value": (None if name == "selected" else value)}
                  for name, value in sorted(args.items())]
        return {"tool_call_id": cid, "tool_name": turn.tool,
                "tool_args": args, "requires_user_input": True,
                "user_input_schema": schema}
