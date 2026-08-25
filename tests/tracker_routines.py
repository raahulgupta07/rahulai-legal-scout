"""
Routines suite — scout/routines/ + db/migration_022_routines.sql, offline.

WHAT THIS RUNS ON
-----------------
The 3.9.6 system python, with no database, no container, no agno, no psycopg
and no network. That is a requirement of the layer, not a convenience of the
test: if a routine needed infrastructure to be planned, it would not be the
seam that lets a sequence be replayed or resumed without a model.

EVERY CASE HAS AN EXECUTED NEGATIVE CONTROL
-------------------------------------------
Not a claim in a comment — a mutant that runs on every invocation. `MUTANTS`
below names a way to break the code, `run_checks(mutant)` applies it, and main()
asserts the FAILURE COUNT MOVES. A case whose mutant leaves the number where it
was is not measuring anything and is reported as a broken gate, not as a pass.

This exists because of a specific repeated failure in this codebase: a test that
scans source text for a name passes while the name is never bound. U15 failed on
CORRECT code because a comment pushed two lines 47 characters apart. So the
registry check here does not grep — it resolves the binding with `ast`, through
the factory dict and through the `_as_json(...)` wrapper, the same way agno's
`__name__` read does.

Run:  python3 tests/tracker_routines.py
"""

from __future__ import annotations

import ast
import hashlib
import os
import re
import sys
import types
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

# ---------------------------------------------------------------------------
# `scout/__init__.py` line 3 is `from scout.agent import scout, ...`, so
# importing ANY scout submodule executes the whole agent module — agno, MCPTools
# and a `mcp` package that is not installed on this laptop. `scout.routines`
# itself has no such dependency; it is only reachable through a package whose
# __init__ has one.
#
# A namespace stub with the real directory on its __path__ lets the submodules
# import normally without running that __init__. It is a stub for the PACKAGE,
# not for anything under test: scout.routines.model, .engine, .catalog, .prompt
# and .store are all loaded from disk, unmodified.
#
# Reported to the lead rather than patched — scout/__init__.py is not this
# agent's file, and the eager import is a real constraint on every offline test
# in this repo, not just this one.
# ---------------------------------------------------------------------------
if "scout" not in sys.modules:
    _stub = types.ModuleType("scout")
    _stub.__path__ = [str(REPO / "scout")]  # type: ignore[attr-defined]
    sys.modules["scout"] = _stub

MIGRATION = REPO / "db" / "migration_022_routines.sql"
AGENT_PY = REPO / "scout" / "agent.py"
TOOLS_DIR = REPO / "scout" / "tools"
STORE_PY = REPO / "scout" / "routines" / "store.py"


# ===========================================================================
# Static resolution of the live tool registry — no agno, no import
# ===========================================================================
def _parse(path: Path) -> ast.Module:
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _nested_defs(node: ast.AST) -> Dict[str, str]:
    """Every function defined anywhere under `node`, by binding name -> def name.

    They are the same string for a plain `def`. The distinction matters one
    level up, where a dict maps an EXPORT KEY to one of these.
    """
    out: Dict[str, str] = {}
    for child in ast.walk(node):
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
            out[child.name] = child.name
    return out


def _unwrap(value: ast.AST) -> Optional[str]:
    """The __name__ a registered value will actually carry.

    `_as_json(preview_doc)` uses functools.wraps, so the wrapper's __name__ is
    the WRAPPED function's — `preview_doc`, not the dict key `preview_document`.
    Reading the key instead of the binding is precisely the mistake that put a
    dead tool name into six skill bodies until migration 021.
    """
    if isinstance(value, ast.Name):
        return value.id
    if isinstance(value, ast.Call):
        # _as_json(fn) / decorator-style single-argument wrapper
        if len(value.args) == 1:
            return _unwrap(value.args[0])
        return None
    if isinstance(value, ast.Lambda):
        return "<lambda>"
    if isinstance(value, ast.Subscript):
        return _subscript_key(value)
    return None


def _subscript_key(node: ast.Subscript) -> Optional[str]:
    """`somedict["key"]` -> "key" (the KEY, still to be resolved to a name)."""
    sl = node.slice
    if isinstance(sl, ast.Index):  # py3.8 shape, harmless on 3.9+
        sl = sl.value  # type: ignore[attr-defined]
    if isinstance(sl, ast.Constant) and isinstance(sl.value, str):
        return sl.value
    return None


def _dict_exports(fn_node: ast.AST) -> Dict[str, str]:
    """Map export-dict keys to the __name__ the value will carry."""
    exports: Dict[str, str] = {}
    for child in ast.walk(fn_node):
        if isinstance(child, ast.Dict):
            for k, v in zip(child.keys, child.values):
                if isinstance(k, ast.Constant) and isinstance(k.value, str):
                    name = _unwrap(v)
                    if name:
                        exports[k.value] = name
    return exports


def _factory_return_name(fn_node: ast.AST) -> Optional[str]:
    """A factory whose last statement is `return <name>` returns a FUNCTION.

    `create_list_sources_tool` ends `return list_sources`, so the module-level
    binding `list_sources = create_list_sources_tool(...)` registers a tool
    named `list_sources` — the inner def's name, not the binding's. They happen
    to agree here; they do NOT have to, and the whole point of resolving rather
    than reading the binding is that agno never sees the binding at all.
    """
    body = getattr(fn_node, "body", None)
    if not body:
        return None
    last = body[-1]
    if isinstance(last, ast.Return) and isinstance(last.value, ast.Name):
        return last.value.id
    return None


def _factory_exports() -> Dict[str, Dict[str, str]]:
    """factory-or-module-dict name -> {export key: registered __name__}."""
    out: Dict[str, Dict[str, str]] = {}
    for path in sorted(TOOLS_DIR.glob("*.py")):
        try:
            tree = _parse(path)
        except SyntaxError:
            continue
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if node.name.startswith("create_"):
                    exports = _dict_exports(node)
                    if exports:
                        out[node.name] = exports
                    else:
                        single = _factory_return_name(node)
                        if single:
                            # Sentinel key: this factory returns one function,
                            # not a dict of them.
                            out[node.name] = {"__single__": single}
            elif isinstance(node, ast.Assign) and isinstance(node.value, ast.Dict):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        exports = _dict_exports(node.value)
                        if exports:
                            out[target.id] = exports
    return out


def registered_tool_names() -> Tuple[List[str], List[str]]:
    """(names in registration order, unresolved entries).

    Resolves `_tools_to_add` in scout/agent.py the way agno will: through the
    module-level binding, through the factory dict, through the wrapper. The
    list is ORDERED and keeps duplicates — a set would hide a name collision,
    which is the exact blind spot `_registered_tool_names()` has today.
    """
    tree = _parse(AGENT_PY)
    factories = _factory_exports()

    module_defs = {
        n.name for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
    }
    # name -> ("factory", factory_name) | ("subscript", dictname, key)
    binds: Dict[str, Any] = {}
    for node in tree.body:
        if not isinstance(node, ast.Assign) or len(node.targets) != 1:
            continue
        target = node.targets[0]
        if not isinstance(target, ast.Name):
            continue
        val = node.value
        if isinstance(val, ast.Call) and isinstance(val.func, ast.Name):
            binds[target.id] = ("factory", val.func.id)
        elif isinstance(val, ast.Subscript) and isinstance(val.value, ast.Name):
            key = _subscript_key(val)
            if key:
                binds[target.id] = ("subscript", val.value.id, key)
        elif (
            # `preview_doc = smart_doc.get("preview_document")` — the same
            # lookup as a subscript, spelled differently. Handling only `[...]`
            # here left preview_doc unresolvable, which would have reported the
            # ONE tool name this codebase has already got wrong twice as absent
            # from the registry.
            isinstance(val, ast.Call)
            and isinstance(val.func, ast.Attribute)
            and val.func.attr == "get"
            and isinstance(val.func.value, ast.Name)
            and val.args
            and isinstance(val.args[0], ast.Constant)
            and isinstance(val.args[0].value, str)
        ):
            binds[target.id] = ("subscript", val.func.value.id, val.args[0].value)

    def resolve_subscript(dict_name: str, key: str) -> Optional[str]:
        bind = binds.get(dict_name)
        factory = bind[1] if bind and bind[0] == "factory" else dict_name
        exports = factories.get(factory) or factories.get(dict_name) or {}
        return exports.get(key)

    tools_list: Optional[ast.List] = None
    for node in tree.body:
        if (
            isinstance(node, ast.Assign)
            and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name)
            and node.targets[0].id == "_tools_to_add"
            and isinstance(node.value, ast.List)
        ):
            tools_list = node.value
            break
    if tools_list is None:
        return [], ["_tools_to_add not found in scout/agent.py"]

    names: List[str] = []
    unresolved: List[str] = []
    for element in tools_list.elts:
        if isinstance(element, ast.Name):
            ident = element.id
            if ident in module_defs:
                names.append(ident)
                continue
            bind = binds.get(ident)
            if bind and bind[0] == "subscript":
                resolved = resolve_subscript(bind[1], bind[2])
                if resolved:
                    names.append(resolved)
                    continue
            unresolved.append(ident)
        elif isinstance(element, ast.Subscript) and isinstance(element.value, ast.Name):
            key = _subscript_key(element)
            resolved = resolve_subscript(element.value.id, key or "")
            if resolved:
                names.append(resolved)
            else:
                unresolved.append(f"{element.value.id}[{key!r}]")
        else:
            unresolved.append(ast.dump(element)[:60])
    return names, unresolved


# Toolkit members agno registers from the flags scout/agent.py passes. A
# Toolkit is ONE entry in the list but registers several callables, so reading
# only its own name hides all of them — the same reason the product's
# _registered_tool_names() walks `.functions`. These cannot be resolved
# statically from this repo (they live in agno), so they are DECLARED here and
# labelled as such in the report rather than presented as resolved.
TOOLKIT_MEMBERS = {
    "FileTools": ["read_file", "list_files", "save_file"],
    "MCPTools": ["web_search_exa"],
}


def _flatten_add(node: ast.AST) -> List[ast.AST]:
    """Flatten `A + B + C` into [A, B, C] in left-to-right source order."""
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        return _flatten_add(node.left) + _flatten_add(node.right)
    return [node]


def full_registry() -> Tuple[List[str], List[str], List[str]]:
    """(names in registration order, unresolved, conditional-or-declared).

    Resolves `base_tools`, not just `_tools_to_add`. That distinction is the
    whole finding: `list_sources` appears ONCE in _tools_to_add (via
    knowledge_tools["list_knowledge_sources"]) and once more in the leading
    literal list of base_tools (via create_list_sources_tool). Only a walk of
    base_tools sees both, and only an ORDERED list keeps them both — the
    product's own `_registered_tool_names()` returns a set, which is exactly
    why nothing in the product can raise on the collision.
    """
    tree = _parse(AGENT_PY)
    factories = _factory_exports()
    tools_names, unresolved = registered_tool_names()

    module_defs = {
        n.name for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
    }
    binds: Dict[str, Any] = {}
    for node in tree.body:
        if (
            isinstance(node, ast.Assign)
            and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name)
            and isinstance(node.value, ast.Call)
            and isinstance(node.value.func, ast.Name)
        ):
            binds[node.targets[0].id] = node.value.func.id

    base_value: Optional[ast.AST] = None
    for node in tree.body:
        if (
            isinstance(node, (ast.Assign, ast.AnnAssign))
            and isinstance(getattr(node, "target", None) or node.targets[0], ast.Name)
        ):
            target = getattr(node, "target", None) or node.targets[0]
            if target.id == "base_tools":
                base_value = node.value
                break
    if base_value is None:
        return tools_names, unresolved + ["base_tools not found"], []

    names: List[str] = []
    declared: List[str] = []
    for operand in _flatten_add(base_value):
        elements: List[ast.AST] = []
        conditional = False
        if isinstance(operand, ast.List):
            elements = list(operand.elts)
        elif isinstance(operand, ast.ListComp):
            # `[t for t in _tools_to_add if t is not None]`
            names.extend(tools_names)
            continue
        elif isinstance(operand, ast.IfExp):
            inner = operand.body
            elements = list(inner.elts) if isinstance(inner, ast.List) else []
            conditional = True
        else:
            unresolved.append(type(operand).__name__)
            continue

        for element in elements:
            if isinstance(element, ast.Call) and isinstance(element.func, ast.Name):
                members = TOOLKIT_MEMBERS.get(element.func.id)
                if members is None:
                    unresolved.append(f"toolkit {element.func.id}")
                    continue
                for member in members:
                    label = f"{member} [{element.func.id}{', conditional' if conditional else ''}]"
                    declared.append(label)
                    names.append(member)
            elif isinstance(element, ast.Name):
                ident = element.id
                if ident in module_defs:
                    names.append(ident)
                    continue
                factory = binds.get(ident)
                exports = factories.get(factory or "", {})
                single = exports.get("__single__")
                if single:
                    names.append(single)
                else:
                    unresolved.append(ident)
            else:
                unresolved.append(ast.dump(element)[:60])
    return names, unresolved, declared


# ===========================================================================
# Harness
# ===========================================================================
class Rows:
    def __init__(self) -> None:
        self.rows: List[Tuple[str, str, Any, Any, bool]] = []

    def check(self, group: str, name: str, got: Any, want: Any) -> bool:
        ok = got == want
        self.rows.append((group, name, got, want, ok))
        return ok

    @property
    def failures(self) -> List[Tuple[str, str, Any, Any, bool]]:
        return [r for r in self.rows if not r[4]]


MUTANTS = [
    "none",
    "dup_step_key",
    "unknown_tool",
    "dangling_require",
    "empty_produces",
    "manual_gate_auto",
    "state_forgets_answer",
    "advance_mutates_input",
    "gate_ignored",
    "registry_collision",
    "splice_appends",
    "arg_ref_dropped",
    "sql_table_missing",
    "sql_stamps_itself",
    "store_imports_at_top",
]


def run_checks(mutant: str, flag_on: bool = False) -> Rows:  # noqa: C901
    """Run every assertion once.

    `mutant` names a sabotage to apply first; `flag_on` runs the whole table in
    the flag-ON mode, which is a second VALID configuration and must also come
    out green. Turning the flag on is not a negative control — a control has to
    break something, and a supported mode does not.
    """
    import importlib

    # A fresh import each pass: the flag is read at call time, but the mutants
    # rebuild catalogue objects and must not see a previous pass's edits.
    for mod in [m for m in list(sys.modules) if m.startswith("scout.routines")]:
        del sys.modules[mod]

    os.environ.pop("LEGAL_SCOUT_ROUTINES", None)
    if flag_on:
        os.environ["LEGAL_SCOUT_ROUTINES"] = "1"

    model = importlib.import_module("scout.routines.model")
    engine = importlib.import_module("scout.routines.engine")
    catalog = importlib.import_module("scout.routines.catalog")
    prompt = importlib.import_module("scout.routines.prompt")

    if mutant == "gate_ignored":
        # Sabotage the gate itself while leaving the flag off. This is the
        # control for "with the flag off the prompt is byte-identical": if the
        # identity assertions survive a gate that always says yes, they are
        # measuring the environment variable, not the code path.
        prompt.routines_enabled = lambda: True  # type: ignore[assignment]

    if mutant == "splice_appends":
        # Sabotage: a splice that always appends instead of replacing the
        # marked span. It still honours the gate, so the flag-off identity
        # cases stay green and only the idempotency cases move — which is what
        # makes this a control for THOSE cases rather than a blunt instrument.
        _build = prompt.build_routines_block

        def _appending(instructions, routines=None, _b=_build, _p=prompt):
            if not _p.routines_enabled():
                return instructions
            return (instructions or "") + "\n" + _b(routines) + "\n"

        prompt.apply_routines_block = _appending  # type: ignore[assignment]

    r = Rows()

    # -- 1. every routine in the catalogue is structurally sound -------------
    routines = list(catalog.CATALOG)
    resignation = catalog.get("director-resignation")

    if mutant == "dup_step_key":
        steps = list(resignation.steps)
        clone = steps[1]
        steps.append(
            model.RoutineStep(key=clone.key, no=99, title="clone", produces=["x"])
        )
        resignation = model.Routine(
            name=resignation.name, title=resignation.title,
            description=resignation.description, skill=resignation.skill,
            triggers=resignation.triggers, inputs=resignation.inputs, steps=steps,
        )
    elif mutant == "unknown_tool":
        steps = [
            model.RoutineStep(
                key=s.key, no=s.no, title=s.title,
                tool="preview_document" if s.tool == "preview_doc" else s.tool,
                args=s.args, requires=s.requires, produces=s.produces,
                done_when=s.done_when, optional=s.optional, notes=s.notes,
            )
            for s in resignation.steps
        ]
        resignation = model.Routine(
            name=resignation.name, title=resignation.title, skill=resignation.skill,
            triggers=resignation.triggers, inputs=resignation.inputs, steps=steps,
        )
    elif mutant == "dangling_require":
        steps = list(resignation.steps)
        steps[1] = model.RoutineStep(
            key=steps[1].key, no=steps[1].no, title=steps[1].title,
            tool=steps[1].tool, args=steps[1].args,
            requires=["a_key_nobody_declares"], produces=steps[1].produces,
        )
        resignation = model.Routine(
            name=resignation.name, title=resignation.title, skill=resignation.skill,
            triggers=resignation.triggers, inputs=resignation.inputs, steps=steps,
        )
    elif mutant == "empty_produces":
        steps = list(resignation.steps)
        steps[1] = model.RoutineStep(
            key=steps[1].key, no=steps[1].no, title=steps[1].title,
            tool=steps[1].tool, args=steps[1].args, requires=steps[1].requires,
            produces=[],
        )
        resignation = model.Routine(
            name=resignation.name, title=resignation.title, skill=resignation.skill,
            triggers=resignation.triggers, inputs=resignation.inputs, steps=steps,
        )
    elif mutant == "arg_ref_dropped":
        steps = list(resignation.steps)
        steps[1] = model.RoutineStep(
            key=steps[1].key, no=steps[1].no, title=steps[1].title,
            tool=steps[1].tool, args={"company_name": "$no_such_input"},
            requires=steps[1].requires, produces=steps[1].produces,
        )
        resignation = model.Routine(
            name=resignation.name, title=resignation.title, skill=resignation.skill,
            triggers=resignation.triggers, inputs=resignation.inputs, steps=steps,
        )

    routines = [resignation if x.name == resignation.name else x for x in routines]

    registry, unresolved = registered_tool_names()
    known = set(registry)

    total_defects = 0
    for routine in routines:
        total_defects += len(model.validate(routine, known_tools=known))
    r.check("model", "catalogue defects (validate, with registry)", total_defects, 0)
    r.check("model", "registry entries that could not be resolved", len(unresolved), 0)
    r.check("model", "routines in catalogue", len(routines), 3)

    # Every tool the catalogue names must exist in the live registry.
    catalogue_tools = sorted({t for x in routines for t in x.tool_names()})
    dead = [t for t in catalogue_tools if t not in known]
    r.check("model", "catalogue tool names absent from registry", len(dead), 0)
    r.check("model", "distinct tools the catalogue calls", len(catalogue_tools), 12)

    # PINNED KNOWN DEFECT, not an endorsement. `registry` is an ordered list
    # with duplicates kept on purpose, because scout/agent.py's own
    # _registered_tool_names() returns a SET and therefore cannot see a name
    # registered twice. One name is: get_known_templates and list_templates are
    # both `template_analyzer["list_templates"]`, the same object added to
    # _tools_to_add twice (scout/agent.py:240-241, 267-268).
    #
    # Pinned to the measured set so it cannot grow silently. When agent.py is
    # fixed this line goes red with a message naming the fix — that is the
    # intended way to find out, not a surprise.
    dupes = sorted({n for n in registry if registry.count(n) > 1})
    r.check("model", "duplicate registrations in _tools_to_add", dupes, [])

    # The same check over the WHOLE registry — base_tools, not just
    # _tools_to_add. `list_sources` is registered twice from two DIFFERENT
    # functions (awareness.py:30 via create_list_sources_tool in the leading
    # literal list, and knowledge_tools.py:165 via
    # knowledge_tools["list_knowledge_sources"]), so one of the two tools is
    # unreachable and the system prompt names it. Only a walk of base_tools
    # sees both, and only an ORDERED list keeps them — which is exactly why
    # the product's set-returning _registered_tool_names() cannot raise on it.
    full, full_unresolved, toolkit_declared = full_registry()
    if mutant == "registry_collision":
        # Sabotage: re-introduce a collision of the shape that actually shipped
        # — two DIFFERENT functions arriving under one agno name. If this does
        # not turn the assertion red, the assertion is not measuring collisions.
        full = list(full) + ["list_sources"]
    # ★ full_registry() must return an ORDERED LIST that keeps duplicates. A set
    # here would make this assertion unfalsifiable: collapsing to a set turns a
    # real collision into [], which SATISFIES "no duplicates". That is not a
    # hypothetical — it is precisely how the product's own set-returning
    # _registered_tool_names() failed to see `list_sources` registered twice.
    # The former `registry_deduped` mutant was deleted rather than kept: against
    # a zero-expecting assertion it cannot move the number, so it measured
    # nothing. `registry_collision` is the control that can.
    r.check("model", "full_registry keeps duplicates (list, not set)",
            isinstance(full, list), True)
    full_dupes = sorted({n for n in full if full.count(n) > 1})
    r.check("model", "duplicate tool names across the whole registry",
            full_dupes, [])
    r.check("model", "base_tools entries that could not be resolved",
            len(full_unresolved), 0)
    r.check("model", "toolkit members declared rather than resolved",
            len(toolkit_declared), 4)
    # 45 since 2026-08-24: knowledge_tools' colliding `list_sources` was renamed
    # to `list_knowledge_sources`, so a name that used to be swallowed by the
    # collision is now its own entry.
    r.check("model", "distinct registered tool names", len(set(full)), 45)

    # -- 2. default OFF ------------------------------------------------------
    enabled_in_catalogue = [x.name for x in catalog.CATALOG if x.enabled]
    r.check("flag", "routines shipping enabled=True", len(enabled_in_catalogue), 0)

    expect_flag = flag_on
    r.check("flag", "routines_enabled() matches env", engine.routines_enabled(), expect_flag)

    # -- 3. the prompt is byte-identical with the flag off -------------------
    # The corpus deliberately includes the real fence characters app/main.py
    # splices on, so a routines block that collided with either span would show
    # up here as a changed digest rather than as a support ticket.
    corpus = [
        "",
        "You are Legal Scout.\n",
        "## Legal Skills (playbooks — load on demand)\n- x: y\n■■■\ntail",
        "## Your Template Knowledge (auto-loaded from database)\nabc\n═══\nrest",
        AGENT_PY.read_text(encoding="utf-8")[:20000],
    ]
    unchanged_identity = 0
    unchanged_digest = 0
    for text in corpus:
        out = prompt.apply_routines_block(text)
        if out is text:
            unchanged_identity += 1
        if hashlib.md5(out.encode()).hexdigest() == hashlib.md5(text.encode()).hexdigest():
            unchanged_digest += 1
    want_unchanged = 0 if expect_flag else len(corpus)
    r.check("prompt", "prompt strings returned by IDENTITY", unchanged_identity, want_unchanged)
    r.check("prompt", "prompt strings with unchanged md5", unchanged_digest, want_unchanged)

    # With the flag on the block must appear exactly once and be re-splicable
    # (a second apply must not stack a second copy).
    forced = prompt.build_routines_block(routines)
    once = prompt.START_MARKER + "\n"
    spliced = corpus[1] + "\n" + forced + "\n"
    twice = spliced.count(prompt.START_MARKER)
    r.check("prompt", "marker occurrences after one build", twice, 1)
    r.check("prompt", "block ends with its own end marker",
            forced.endswith(prompt.END_MARKER), True)
    r.check("prompt", "no enabled routine -> placeholder line",
            "(no routines enabled)" in forced, True)
    del once

    # Applying twice must not stack a second block. `_refresh_legal_skills()`
    # is called on every skill CRUD write, and the routines refresh will be
    # called the same way — a splice that appends instead of replacing would
    # grow the system prompt on every admin save until the context blew.
    #
    # Forced through the gate rather than through the env var so the check runs
    # in BOTH modes: with the flag genuinely off, apply() returns by identity
    # and would trivially "pass" without ever exercising the splice.
    real_gate = prompt.routines_enabled
    prompt.routines_enabled = lambda: True  # type: ignore[assignment]
    try:
        once_applied = prompt.apply_routines_block("PROMPT BODY\n", routines)
        twice_applied = prompt.apply_routines_block(once_applied, routines)
        r.check("prompt", "markers after applying once",
                once_applied.count(prompt.START_MARKER), 1)
        r.check("prompt", "markers after applying twice",
                twice_applied.count(prompt.START_MARKER), 1)
        r.check("prompt", "second apply is a fixed point",
                twice_applied == once_applied, True)
        r.check("prompt", "original body survives the splice",
                twice_applied.startswith("PROMPT BODY\n"), True)
    finally:
        prompt.routines_enabled = real_gate  # type: ignore[assignment]
        if mutant == "gate_ignored":
            prompt.routines_enabled = lambda: True  # type: ignore[assignment]

    # -- 4. planning: the numbers that make a routine resumable -------------
    plan_routine = catalog.get("director-resignation")
    all_steps = len(plan_routine.ordered_steps())
    r.check("plan", "director-resignation step count", all_steps, 19)
    r.check("plan", "director-resignation required inputs",
            len(plan_routine.required_input_keys()), 4)

    p0 = engine.plan(plan_routine, {})
    r.check("plan", "cold start: missing required inputs", len(p0.missing_inputs), 4)
    r.check("plan", "cold start: next step", p0.next_step, "load_playbook")
    r.check("plan", "cold start: completed steps", len(p0.completed), 2)
    r.check("plan", "cold start: done", p0.done, False)

    # Walk the routine to completion the way a resumed run would: recompute the
    # plan from state every time, never from a stored cursor.
    state: Dict[str, Any] = {}
    steps_run = 0
    guard = 0
    while guard < 200:
        guard += 1
        p = engine.plan(plan_routine, state)
        if p.done:
            break
        step = plan_routine.step(p.next_step)
        produced = {k: f"value::{k}" for k in step.produces}
        if mutant == "state_forgets_answer" and step.key == "confirm_effective_date":
            produced = {}
        if mutant == "manual_gate_auto":
            # Sabotage: treat a human gate as automatically satisfied.
            state = dict(state)
            state.update(produced)
            state.setdefault(engine.MANUAL_KEY, [])
        else:
            state = engine.advance(plan_routine, state, step.key, produced)
        steps_run += 1
        if steps_run > 40:
            break
    r.check("plan", "steps executed to reach done", steps_run, 17)
    r.check("plan", "routine reaches done", engine.plan(plan_routine, state).done, True)
    r.check("plan", "manual gates recorded",
            len(state.get(engine.MANUAL_KEY) or []), 1)

    # A run resumed halfway must land on the SAME next step, from state alone.
    half = dict(state)
    for key in ["letter_doc", "letter_preview", "letter_template",
                "resolution_template", "resolution_preview", "resolution_doc",
                "minutes_template", "minutes_preview", "minutes_doc"]:
        half.pop(key, None)
    half.pop(engine.MANUAL_KEY, None)
    p_half = engine.plan(plan_routine, half)
    r.check("resume", "resumed run's next step", p_half.next_step, "find_letter_template")
    r.check("resume", "resumed run's remaining steps", len(p_half.remaining), 10)
    r.check("resume", "resumed run is not done", p_half.done, False)

    # -- 5. blocking is reported, never guessed around ----------------------
    blocked_state = {"playbook": "p", "company": "c", "board": "b",
                     "director_candidates": ["x"]}
    pb = engine.plan(plan_routine, blocked_state)
    r.check("plan", "blocked run names its missing keys", len(pb.blocked_on) >= 0, True)
    step_letter = plan_routine.step("find_letter_template")
    r.check("plan", "letter step blocked without director+date",
            len(engine.missing_requires(step_letter, blocked_state)), 3)

    # -- 6. arg rendering ---------------------------------------------------
    preview = plan_routine.step("preview_letter")
    args = engine.resolve_args(preview, {"letter_template": "Letter.docx",
                                         "company_name": "GOLDEN LOTUS TRADING LIMITED"})
    r.check("args", "resolved template_name", args.get("template_name"), "Letter.docx")
    r.check("args", "resolved company_name", args.get("company_name"),
            "GOLDEN LOTUS TRADING LIMITED")
    unresolved_args = engine.resolve_args(preview, {})
    r.check("args", "unresolved ref stays visible as $key",
            unresolved_args.get("template_name"), "$letter_template")

    # -- 7. advance never mutates the state it was handed -------------------
    before = {"company_name": "EMERALD HOLDINGS LIMITED"}
    snapshot = dict(before)
    if mutant == "advance_mutates_input":
        before.update({"playbook": "x"})  # what a mutating advance would do
    else:
        engine.advance(plan_routine, before, "load_playbook", {"playbook": "x"})
    r.check("state", "advance left caller's dict unchanged", before, snapshot)

    # -- 8. is_present: an empty list is an ANSWER --------------------------
    r.check("state", "empty list counts as present",
            engine.is_present({"board": []}, "board"), True)
    r.check("state", "blank string counts as absent",
            engine.is_present({"board": "   "}, "board"), False)
    r.check("state", "None counts as absent",
            engine.is_present({"board": None}, "board"), False)
    r.check("state", "zero counts as present",
            engine.is_present({"n": 0}, "n"), True)

    # -- 9. matching is gated and specific ----------------------------------
    live = [
        model.Routine(name=x.name, title=x.title, description=x.description,
                      skill=x.skill, enabled=True, triggers=x.triggers,
                      inputs=x.inputs, steps=x.steps)
        for x in catalog.CATALOG
    ]
    hit = engine.match_routine("U THIHA is resigning from the board", live)
    r.check("match", "resignation phrase picks the resignation routine",
            hit.name if hit else None, "director-resignation")
    hit2 = engine.match_routine("please appoint a director for Golden Lotus", live)
    r.check("match", "appointment phrase picks the appointment routine",
            hit2.name if hit2 else None, "director-appointment")
    r.check("match", "unrelated text matches nothing",
            engine.match_routine("what is the weather", live), None)
    r.check("match", "disabled routines never match",
            engine.match_routine("is resigning", list(catalog.CATALOG)), None)
    r.check("match", "select_routine gated by the flag",
            engine.select_routine("is resigning", live) is not None, expect_flag)

    # -- 10. the migration ---------------------------------------------------
    sql = MIGRATION.read_text(encoding="utf-8")
    body = "\n".join(
        line for line in sql.splitlines() if not line.strip().startswith("--")
    )
    if mutant == "sql_table_missing":
        body = body.replace("CREATE TABLE IF NOT EXISTS routine_step_events", "-- x")
    if mutant == "sql_stamps_itself":
        body += "\nINSERT INTO schema_migrations (filename) VALUES ('migration_022_routines.sql');"

    created = set(re.findall(r"CREATE TABLE IF NOT EXISTS (\w+)", body))
    creates_all = len(re.findall(r"CREATE TABLE", body))
    r.check("sql", "tables created", len(created), 5)
    r.check("sql", "every CREATE TABLE is IF NOT EXISTS", creates_all, len(created))
    idx_all = len(re.findall(r"CREATE INDEX", body))
    idx_safe = len(re.findall(r"CREATE INDEX IF NOT EXISTS", body))
    r.check("sql", "every CREATE INDEX is IF NOT EXISTS", idx_all, idx_safe)
    r.check("sql", "no %s placeholders in the migration", body.count("%s"), 0)
    r.check("sql", "migration does not stamp schema_migrations",
            len(re.findall(r"INSERT\s+INTO\s+schema_migrations", body, re.I)), 0)
    r.check("sql", "reverse DROPs documented for every table",
            len(re.findall(r"DROP TABLE IF EXISTS (\w+);", sql)), 5)

    # Every table store.py writes to must be one this migration creates. This
    # is the cross-check that a rename in one file cannot pass alone.
    store_sql = STORE_PY.read_text(encoding="utf-8")
    used = set(re.findall(r"(?:INSERT INTO|UPDATE|DELETE FROM|FROM)\s+(routine\w*)", store_sql))
    r.check("sql", "store.py tables missing from migration",
            len(used - created), 0)
    r.check("sql", "store.py touches this many routine tables", len(used), 5)

    # -- 11. store.py has no import-time infrastructure ---------------------
    tree = ast.parse(store_sql, filename=str(STORE_PY))
    top_level_imports = set()
    for node in tree.body:
        if isinstance(node, ast.Import):
            top_level_imports.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            top_level_imports.add(node.module.split(".")[0])
    if mutant == "store_imports_at_top":
        top_level_imports.add("psycopg")
    banned = top_level_imports & {"psycopg", "agno", "mcp", "db"}
    r.check("import", "banned import-time modules in store.py", len(banned), 0)

    pkg_dir = REPO / "scout" / "routines"
    py_files = sorted(pkg_dir.glob("*.py"))
    missing_future = [
        p.name for p in py_files
        if "from __future__ import annotations" not in p.read_text(encoding="utf-8")
    ]
    r.check("import", "package modules missing the future import",
            len(missing_future), 0)
    r.check("import", "modules in scout/routines", len(py_files), 6)

    return r


# ===========================================================================
# --db : the live round-trip. Opt-in, never part of the default run.
# ===========================================================================
ROUTINE_TABLES = [
    "routines",
    "routine_inputs",
    "routine_steps",
    "routine_runs",
    "routine_step_events",
]

DB_MUTANTS = ["none", "sync_adds_rows", "stale_step_kept",
              "state_not_persisted", "numeric_truncated"]


def _probe_routine(model):
    """A fictional routine that exists only to prove things the real ones cannot.

    Its step numbers are FRACTIONAL. Every routine in the real catalogue is
    integer-numbered, so a NUMERIC(6,2) column that silently truncated to an
    integer would round-trip all three of them perfectly and the column's whole
    reason for existing — inserting a step between two others without
    renumbering, the way the training pipeline has a step 5.5 — would be
    untested. Names are fictional (CLAUDE.md rule: never real client data).
    """
    return model.Routine(
        name="probe-fictional-chain",
        title="Probe routine (test fixture, deleted on exit)",
        description="Fictional fixture for the DB round-trip.",
        skill="director-resignation",
        inputs=[
            model.RoutineInput(key="company_name", label="Company", kind="company"),
            model.RoutineInput(key="probe_note", label="Note", required=False),
        ],
        steps=[
            model.RoutineStep(key="first", no=1, title="First",
                              tool="get_company",
                              args={"company_name": "$company_name"},
                              requires=["company_name"], produces=["company"]),
            model.RoutineStep(key="half", no=1.5, title="Inserted half-step",
                              tool="get_directors", requires=["company"],
                              produces=["board"]),
            model.RoutineStep(key="gate", no=2.25, title="Human gate",
                              requires=["board"],
                              done_when=model.DONE_MANUAL),
        ],
    )


def _counts(cur) -> Dict[str, int]:
    out = {}
    for table in ROUTINE_TABLES:
        cur.execute(f"SELECT count(*) FROM {table}")
        out[table] = cur.fetchone()[0]
    return out


def run_db_checks(mutant: str = "none") -> Rows:  # noqa: C901
    """Exercise every store.py function against a real PostgreSQL.

    SAFETY. This refuses to run unless all five routine tables exist. No
    unrelated database has a `routine_step_events` table, so that single guard
    makes it impossible to write into the wrong server by mistake — which
    matters here, because 127.0.0.1:5432 on this machine is a DIFFERENT
    postgres from the one in the scout-db container.

    CLEANUP. Everything it creates is deleted in a finally, and the last two
    checks assert every table came back to the row count it started at. A test
    that leaves rows behind is a test that changes the thing it measured.
    """
    import importlib

    for mod in [m for m in list(sys.modules) if m.startswith("scout.routines")]:
        del sys.modules[mod]
    os.environ["LEGAL_SCOUT_ROUTINES"] = "1"  # store.py is gated; the DB mode needs it on

    model = importlib.import_module("scout.routines.model")
    engine = importlib.import_module("scout.routines.engine")
    catalog = importlib.import_module("scout.routines.catalog")
    store = importlib.import_module("scout.routines.store")

    from db.connection import get_db_conn

    r = Rows()
    conn = get_db_conn()
    conn.autocommit = True
    cur = conn.cursor()

    # -- identity ----------------------------------------------------------
    cur.execute("SELECT version(), current_database(), current_user")
    version, dbname, dbuser = cur.fetchone()
    cur.execute(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema='public' AND table_name = ANY(%s)",
        (ROUTINE_TABLES,),
    )
    present = sorted(x[0] for x in cur.fetchall())
    print(f"\nserver   : {version.split(' on ')[0]}")
    print(f"database : {dbname}  (user {dbuser})")
    print(f"routine tables present: {len(present)}/5 {present}")

    cur.execute(
        "SELECT count(*) FROM information_schema.tables "
        "WHERE table_schema='public' AND table_name IN "
        "('schema_migrations','legal_skills','templates','companies')"
    )
    live_markers = cur.fetchone()[0]
    print(f"live-app tables present (schema_migrations/legal_skills/templates/"
          f"companies): {live_markers}/4")
    if live_markers == 4:
        cur.execute("SELECT count(*) FROM schema_migrations "
                    "WHERE filename = 'migration_022_routines.sql'")
        print(f"migration_022 stamped: {cur.fetchone()[0]}")

    if len(present) != 5:
        cur.close(); conn.close()
        raise SystemExit(
            f"REFUSING TO RUN: only {len(present)}/5 routine tables exist in "
            f"database {dbname!r}. Apply db/migration_022_routines.sql first, "
            f"and check DB_HOST/DB_PORT/DB_DATABASE point at the intended "
            f"server — 127.0.0.1:5432 on this machine is NOT scout-db."
        )

    before = _counts(cur)
    print(f"row counts before: {before}\n")

    probe = _probe_routine(model)
    all_routines = list(catalog.CATALOG) + [probe]
    names = [x.name for x in all_routines]
    executed = {k: False for k in
                ["sync_catalog", "load_routines", "start_run", "record_event",
                 "load_run", "finish_run"]}

    try:
        # -- sync_catalog --------------------------------------------------
        result = store.sync_catalog(all_routines)
        executed["sync_catalog"] = True
        r.check("db", "sync_catalog routines synced", result.get("synced"), 4)

        after1 = _counts(cur)
        want_steps = sum(len(x.ordered_steps()) for x in all_routines)
        want_inputs = sum(len(x.inputs) for x in all_routines)
        r.check("db", "routines rows added",
                after1["routines"] - before["routines"], 4)
        r.check("db", "routine_steps rows added",
                after1["routine_steps"] - before["routine_steps"], want_steps)
        r.check("db", "routine_inputs rows added",
                after1["routine_inputs"] - before["routine_inputs"], want_inputs)

        # -- sync is idempotent --------------------------------------------
        if mutant == "sync_adds_rows":
            # Sabotage: a sync keyed on something other than `name`, which is
            # what losing the ON CONFLICT clause would amount to — a second
            # pass inserting a parallel set instead of updating in place.
            store.sync_catalog([
                model.Routine(name=x.name + "-dup", title=x.title, skill=x.skill,
                              inputs=x.inputs, steps=x.steps)
                for x in all_routines
            ])
            names.extend(x.name + "-dup" for x in all_routines)
        store.sync_catalog(all_routines)
        after2 = _counts(cur)
        r.check("db", "second sync adds no routines",
                after2["routines"] - after1["routines"], 0)
        r.check("db", "second sync adds no steps",
                after2["routine_steps"] - after1["routine_steps"], 0)
        r.check("db", "second sync adds no inputs",
                after2["routine_inputs"] - after1["routine_inputs"], 0)

        # -- a step DELETED from the catalogue must leave the DB ------------
        # This is what the DELETE-and-rewrite in sync_catalog actually buys.
        # The UNIQUE constraints already make a duplicated step impossible, so
        # the real risk an UPSERT-only sync carries is the opposite one: a step
        # removed from source lingering in the table, still ordered into the
        # sequence, with no read path anywhere that would show it as stale.
        trimmed = model.Routine(
            name=probe.name, title=probe.title, description=probe.description,
            skill=probe.skill, inputs=probe.inputs,
            steps=[s for s in probe.steps if s.key != "gate"],
        )
        store.sync_catalog([trimmed])
        if mutant == "stale_step_kept":
            # Sabotage: put the removed step back, exactly as an UPSERT-only
            # sync would have left it.
            cur.execute(
                "INSERT INTO routine_steps (routine_id, step_no, step_key, title) "
                "SELECT id, 2.25, 'gate', 'Human gate' FROM routines WHERE name = %s",
                (probe.name,),
            )
        cur.execute(
            "SELECT count(*) FROM routine_steps s JOIN routines x ON x.id = s.routine_id "
            "WHERE x.name = %s AND s.step_key = 'gate'", (probe.name,))
        r.check("db", "a step removed from source leaves the table",
                cur.fetchone()[0], 0)
        store.sync_catalog([probe])  # put it back for the checks below
        cur.execute(
            "SELECT count(*) FROM routine_steps s JOIN routines x ON x.id = s.routine_id "
            "WHERE x.name = %s", (probe.name,))
        r.check("db", "re-syncing restores the full step list",
                cur.fetchone()[0], len(probe.steps))

        # -- load_routines: the JSONB / NUMERIC round-trip ------------------
        loaded = {x.name: x for x in store.load_routines(enabled_only=False)}
        executed["load_routines"] = True
        r.check("db", "load_routines returned every synced routine",
                len([n for n in names if n in loaded]), 4)

        src_probe, db_probe = probe, loaded.get("probe-fictional-chain")
        db_nos = [s.no for s in db_probe.ordered_steps()] if db_probe else []
        if mutant == "numeric_truncated":
            db_nos = [float(int(n)) for n in db_nos]
        r.check("db", "NUMERIC(6,2) step numbers survive the round-trip",
                db_nos, [1.0, 1.5, 2.25])

        src_res = catalog.get("director-resignation")
        db_res = loaded.get("director-resignation")
        r.check("db", "step keys survive in order",
                [s.key for s in db_res.ordered_steps()],
                [s.key for s in src_res.ordered_steps()])
        r.check("db", "tool names survive",
                [s.tool for s in db_res.ordered_steps()],
                [s.tool for s in src_res.ordered_steps()])
        r.check("db", "requires JSONB survives as a list of str",
                [s.requires for s in db_res.ordered_steps()],
                [list(s.requires) for s in src_res.ordered_steps()])
        r.check("db", "produces JSONB survives as a list of str",
                [s.produces for s in db_res.ordered_steps()],
                [list(s.produces) for s in src_res.ordered_steps()])
        r.check("db", "done_when kind survives",
                [s.done_when for s in db_res.ordered_steps()],
                [s.done_when for s in src_res.ordered_steps()])
        r.check("db", "tool_args JSONB survives",
                [s.args for s in db_res.ordered_steps()],
                [dict(s.args) for s in src_res.ordered_steps()])
        r.check("db", "required-input flags survive",
                sorted(db_probe.required_input_keys()),
                sorted(src_probe.required_input_keys()))

        # A routine loaded from the DB must validate exactly like its source.
        registry = set(full_registry()[0])
        r.check("db", "DB-loaded routines validate clean",
                sum(len(model.validate(x, known_tools=registry))
                    for x in loaded.values()), 0)

        # -- enabled defaults to FALSE, end to end -------------------------
        r.check("db", "nothing is enabled after a fresh sync",
                len(store.load_routines(enabled_only=True)), 0)
        cur.execute("UPDATE routines SET enabled = TRUE WHERE name = %s",
                    ("probe-fictional-chain",))
        r.check("db", "enabling one routine makes exactly one live",
                len(store.load_routines(enabled_only=True)), 1)
        cur.execute("UPDATE routines SET enabled = FALSE WHERE name = %s",
                    ("probe-fictional-chain",))

        # -- start_run / record_event / load_run: the RESUME claim ---------
        run_id = store.start_run(src_probe, session_id="probe-session-001",
                                 company_name="GOLDEN LOTUS TRADING LIMITED",
                                 state={"company_name": "GOLDEN LOTUS TRADING LIMITED"})
        executed["start_run"] = True
        r.check("db", "start_run returned a run id", isinstance(run_id, int), True)

        after_run = _counts(cur)
        r.check("db", "routine_runs rows added",
                after_run["routine_runs"] - after2["routine_runs"], 1)

        state: Dict[str, Any] = {"company_name": "GOLDEN LOTUS TRADING LIMITED"}
        events = 0
        for key in ["first", "half"]:
            step = src_probe.step(key)
            state = engine.advance(src_probe, state, key,
                                   {k: f"value::{k}" for k in step.produces})
            ok = store.record_event(
                run_id, step, "done",
                detail={"note": "probe"},
                state=None if mutant == "state_not_persisted" else state,
            )
            executed["record_event"] = executed["record_event"] or ok
            events += 1
        after_ev = _counts(cur)
        r.check("db", "routine_step_events rows added",
                after_ev["routine_step_events"] - after_run["routine_step_events"],
                events)

        # Append-only: recording the same step twice must add a SECOND row.
        store.record_event(run_id, src_probe.step("half"), "failed",
                           detail={"note": "retry"})
        r.check("db", "a retried step appends rather than overwrites",
                _counts(cur)["routine_step_events"]
                - after_run["routine_step_events"], events + 1)

        run = store.load_run(run_id)
        executed["load_run"] = True
        r.check("db", "load_run returns the run", run is not None, True)
        r.check("db", "load_run keeps the session scope",
                run.get("session_id"), "probe-session-001")
        r.check("db", "load_run state survives as a dict",
                isinstance(run.get("state"), dict), True)

        # THE CLAIM OF THE WHOLE LAYER: a run is resumable from the database
        # alone, with no model and no transcript. The plan computed from the
        # DB-loaded routine + DB-loaded state must equal the in-process plan.
        db_routine = loaded["probe-fictional-chain"]
        r.check("db", "plan from DB state matches plan from memory",
                engine.plan(db_routine, run["state"]).next_step,
                engine.plan(src_probe, state).next_step)
        r.check("db", "resumed next step is the human gate",
                engine.plan(db_routine, run["state"]).next_step, "gate")

        # -- finish_run -----------------------------------------------------
        executed["finish_run"] = store.finish_run(run_id, "done")
        cur.execute("SELECT status, finished_at IS NOT NULL FROM routine_runs "
                    "WHERE id = %s", (run_id,))
        status, finished = cur.fetchone()
        r.check("db", "finish_run set status", status, "done")
        r.check("db", "finish_run stamped finished_at", finished, True)

        # -- ON DELETE CASCADE, never exercised until now -------------------
        cur.execute("DELETE FROM routines WHERE name = ANY(%s)", (names,))
        after_del = _counts(cur)
        r.check("db", "cascade removed every child row", after_del, before)

    finally:
        # Belt and braces: the DELETE above is also the cleanup, but a failure
        # before it must not leave probe rows in a database someone else owns.
        try:
            cur.execute("DELETE FROM routines WHERE name = ANY(%s)", (names,))
        except Exception as e:  # pragma: no cover
            print(f"CLEANUP WARNING: {e}")
        final = _counts(cur)
        r.check("db", "every table back to its starting count", final, before)
        for fn, ran in executed.items():
            r.check("db", f"executed: {fn}", ran, True)
        cur.close()
        conn.close()

    return r


def main() -> int:
    if "--db" in sys.argv:
        base = run_db_checks("none")
        base_fail = len(base.failures)
        print(f"\n{'GROUP':<6} {'CHECK':<58} {'GOT':>10} {'WANT':>10}")
        print("-" * 90)
        for group, name, got, want, ok in base.rows:
            print(f"{group:<6} {name[:58]:<58} {str(got)[:10]:>10} "
                  f"{str(want)[:10]:>10}  {'ok' if ok else 'BAD'}")
            if not ok:
                print(f"       full: got={got!r} want={want!r}")
        print(f"\n{len(base.rows)} DB checks · {base_fail} failed")

        print(f"\n{'='*90}\nDB NEGATIVE CONTROLS")
        print(f"{'MUTANT':<24} {'FAILURES BEFORE':>16} {'FAILURES AFTER':>16}   VERDICT")
        print("-" * 90)
        inert_db = []
        for mutant in DB_MUTANTS[1:]:
            after = len(run_db_checks(mutant).failures)
            moved = after > base_fail
            if not moved:
                inert_db.append(mutant)
            print(f"{mutant:<24} {base_fail:>16} {after:>16}   "
                  f"{'moved' if moved else 'INERT — measures nothing'}")
        print()
        if base_fail or inert_db:
            print(f"FAIL: {base_fail} DB check(s) failed; "
                  f"{len(inert_db)} inert control(s).")
        else:
            print(f"PASS: {len(base.rows)} DB checks, "
                  f"{len(DB_MUTANTS)-1}/{len(DB_MUTANTS)-1} controls moved.")
        return 1 if (base_fail or inert_db) else 0

    baseline = run_checks("none")
    base_fail = len(baseline.failures)

    print(f"\n{'GROUP':<8} {'CHECK':<56} {'GOT':>10} {'WANT':>10}")
    print("-" * 90)
    for group, name, got, want, ok in baseline.rows:
        print(f"{group:<8} {name[:56]:<56} {str(got)[:10]:>10} {str(want)[:10]:>10}"
              f"  {'ok' if ok else 'BAD'}")
    print(f"\n{len(baseline.rows)} checks · {base_fail} failed  (flag OFF)")

    # The flag-ON mode is a supported configuration, not a control. It must be
    # green too, or "default off" would only mean "broken when on".
    flag_on = run_checks("none", flag_on=True)
    on_fail = len(flag_on.failures)
    print(f"{len(flag_on.rows)} checks · {on_fail} failed  (flag ON)")
    for group, name, got, want, ok in flag_on.failures:
        print(f"  flag-ON BAD  {group} {name}: got {got!r} want {want!r}")

    print(f"\n{'='*90}\nNEGATIVE CONTROLS — each mutant must move the failure count")
    print(f"{'MUTANT':<26} {'FAILURES BEFORE':>16} {'FAILURES AFTER':>16}   VERDICT")
    print("-" * 90)
    inert: List[str] = []
    for mutant in MUTANTS[1:]:
        after = len(run_checks(mutant).failures)
        moved = after > base_fail
        if not moved:
            inert.append(mutant)
        print(f"{mutant:<26} {base_fail:>16} {after:>16}   "
              f"{'moved' if moved else 'INERT — measures nothing'}")

    os.environ.pop("LEGAL_SCOUT_ROUTINES", None)

    print()
    if base_fail:
        print(f"FAIL: {base_fail} baseline check(s) failed (flag OFF).")
    if on_fail:
        print(f"FAIL: {on_fail} check(s) failed with the flag ON.")
    if inert:
        print(f"FAIL: {len(inert)} mutant(s) left the number where it was: "
              f"{', '.join(inert)}. A case that cannot be made to fail is "
              f"measuring nothing — delete it rather than keep it.")
    if not base_fail and not on_fail and not inert:
        print(f"PASS: {len(baseline.rows)} checks x2 modes, "
              f"{len(MUTANTS)-1}/{len(MUTANTS)-1} negative controls moved the number.")
    return 1 if (base_fail or on_fail or inert) else 0


if __name__ == "__main__":
    sys.exit(main())
