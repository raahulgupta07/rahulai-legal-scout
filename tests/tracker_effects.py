"""
Effects ledger tests — deterministic, no database, no HTTP, no LLM.
===================================================================

Run:
    python3 tests/tracker_effects.py                 # the suite
    python3 tests/tracker_effects.py --controls      # negative-control audit
    python3 tests/tracker_effects.py --all           # both

Every test here runs with zero infrastructure: no Postgres, no psycopg, no
agno, no container. That is deliberate — the flag-off path must not need any of
them, and a test that needs a database to prove "the database is never touched"
proves nothing.

WHY THE BOOTSTRAP BELOW EXISTS
    ``scout/__init__.py`` does ``from scout.agent import scout``, which imports
    agno. So a plain ``import scout.effects`` executes that and fails on any
    machine without agno installed. The ledger package itself has no such
    dependency; only its parent's ``__init__`` does. Where the real package
    imports cleanly the bootstrap is a no-op; where it does not, a bare
    ``scout`` package pointing at the same directory is registered instead.
    Either way the same modules are exercised, and nothing in ``scout/`` is
    modified. E03 is the test that keeps this honest — it re-imports the
    package with psycopg/agno/mcp blocked and asserts the import pulled none of
    them in.

NEGATIVE CONTROLS
    ``--controls`` re-runs the whole suite once per mutation, each mutation a
    deliberate break of one behaviour, and prints how many tests failed before
    and after. A mutation that moves no number means the test guarding it does
    not work and the test should be deleted, not kept. The table is the
    evidence for that claim, printed rather than asserted in prose.
"""

from __future__ import annotations

import importlib
import os
import sys
import threading
import types
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))


# ── bootstrap: import scout.effects without executing scout/__init__.py ──────

def _bootstrap_scout_package() -> None:
    """Register a bare ``scout`` package so ``scout.effects`` is importable.

    Only installed when the real one cannot be imported (no agno). In the
    container the real package imports fine and this is a no-op, so the tests
    exercise the same modules in both places.
    """
    if "scout" in sys.modules and hasattr(sys.modules["scout"], "__path__"):
        return
    try:
        import scout  # noqa: F401
        return
    except Exception:
        pass
    pkg = types.ModuleType("scout")
    pkg.__path__ = [str(REPO / "scout")]  # type: ignore[attr-defined]
    sys.modules["scout"] = pkg


_bootstrap_scout_package()

import scout.effects as fx  # noqa: E402
from scout.effects import flag as fx_flag  # noqa: E402
from scout.effects import model as fx_model  # noqa: E402
from scout.effects import recorder as fx_recorder  # noqa: E402
from scout.effects import sink as fx_sink  # noqa: E402
from scout.effects import turn as fx_turn  # noqa: E402


# ── harness ─────────────────────────────────────────────────────────────────

# The ledger logs a warning-with-traceback every time it swallows a failure,
# and E05/E06 make it swallow a dozen. Silenced so the result table is
# readable; the tests assert on return values, never on log output.
import logging as _logging  # noqa: E402

_logging.getLogger("legalscout").setLevel(_logging.CRITICAL)
_logging.getLogger("legalscout").addHandler(_logging.NullHandler())
_logging.getLogger("legalscout").propagate = False


class Ok(Exception):
    pass


def _assert(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


class flag_on:
    """Turn the ledger on for the duration of a block, and restore after."""

    def __init__(self, value: str = "1") -> None:
        self.value = value
        self.prev = None

    def __enter__(self):
        self.prev = os.environ.get(fx_flag.FLAG_ENV)
        os.environ[fx_flag.FLAG_ENV] = self.value
        return self

    def __exit__(self, *exc):
        if self.prev is None:
            os.environ.pop(fx_flag.FLAG_ENV, None)
        else:
            os.environ[fx_flag.FLAG_ENV] = self.prev
        fx_sink.reset_sink()
        return False


class flag_off:
    def __init__(self) -> None:
        self.prev = None

    def __enter__(self):
        self.prev = os.environ.pop(fx_flag.FLAG_ENV, None)
        return self

    def __exit__(self, *exc):
        if self.prev is not None:
            os.environ[fx_flag.FLAG_ENV] = self.prev
        fx_sink.reset_sink()
        return False


class SpySink(fx_sink.MemorySink):
    """MemorySink that counts every call, so 'never touched' is assertable."""

    def __init__(self) -> None:
        super().__init__()
        self.calls = 0

    def open_turn(self, ctx):
        self.calls += 1
        return super().open_turn(ctx)

    def close_turn(self, ctx):
        self.calls += 1
        return super().close_turn(ctx)

    def write(self, effect):
        self.calls += 1
        return super().write(effect)


class ExplodingSink:
    """Every method raises. Models a ledger that is completely broken."""

    def __init__(self, exc=None) -> None:
        self.exc = exc or RuntimeError("effect_log does not exist")
        self.attempts = 0

    def open_turn(self, ctx):
        self.attempts += 1
        raise self.exc

    def close_turn(self, ctx):
        self.attempts += 1
        raise self.exc

    def write(self, effect):
        self.attempts += 1
        raise self.exc


# Fictional fixtures. Never real client data.
COMPANY = "Thandar Bridge Holdings Limited"
PERSON = "Daw Khin Myat Noe"
ACTOR = "aung.thura@example-firm.test"
SESSION = "sess-fixture-0001"


# ── tests ───────────────────────────────────────────────────────────────────
# Each returns (passed, detail).

def t01_flag_default_off():
    """The flag is off unless explicitly set to a true value."""
    with flag_off():
        _assert(fx.ledger_enabled() is False, "unset should be off")
    for v in ("0", "false", "no", "off", "", "  ", "maybe"):
        with flag_on(v):
            _assert(fx.ledger_enabled() is False, "{!r} should be off".format(v))
    for v in ("1", "true", "TRUE", "Yes", " on "):
        with flag_on(v):
            _assert(fx.ledger_enabled() is True, "{!r} should be on".format(v))
    return True, "off for 7 falsey values, on for 5 truthy"


def t02_flag_off_is_a_no_op():
    """Flag off: record returns None and the sink is never called, once."""
    spy = SpySink()
    with flag_off():
        fx_sink.set_sink(spy)
        with fx.turn_scope(session_id=SESSION, actor_email=ACTOR) as turn:
            _assert(turn is None, "turn_scope must yield None when off")
            _assert(fx.current_turn() is None, "no turn may be in scope when off")
            out = fx.record(
                "document.generated", "insert",
                target_table="documents", target_id=7,
                after={"file_name": "AGM.docx"},
            )
            _assert(out is None, "record must return None when off")
        fx_sink.set_sink(None)
    _assert(spy.calls == 0, "sink was called {} time(s) with the flag off".format(spy.calls))
    _assert(spy.effects == [], "effects were written with the flag off")
    return True, "sink calls=0, effects=0, record()=None, turn=None"


def t03_no_infrastructure_imports():
    """No module in the package imports psycopg/agno/mcp at import time."""
    blocked = {"psycopg", "agno", "mcp", "db.connection"}

    class Blocker:
        def find_module(self, name, path=None):
            return self if name.split(".")[0] in {"psycopg", "agno", "mcp"} or name in blocked else None

        def load_module(self, name):
            raise ImportError("blocked by test: " + name)

        # PEP 451
        def find_spec(self, name, path=None, target=None):
            root = name.split(".")[0]
            if root in {"psycopg", "agno", "mcp"} or name in blocked:
                raise ImportError("blocked by test: " + name)
            return None

    purged = [m for m in list(sys.modules) if m == "scout.effects" or m.startswith("scout.effects.")]
    saved = {m: sys.modules.pop(m) for m in purged}
    # Only modules the REIMPORT itself pulls in count. agno may already be in
    # sys.modules because the real `scout` package imported it (it is installed
    # on some machines and not others); what is being tested is whether
    # scout.effects reaches for it, not whether anything else already has.
    before = set(sys.modules)
    blocker = Blocker()
    sys.meta_path.insert(0, blocker)
    try:
        mod = importlib.import_module("scout.effects")
        _assert(hasattr(mod, "record"), "reimported package has no record()")
        leaked = sorted(
            m for m in set(sys.modules) - before
            if m.split(".")[0] in {"psycopg", "agno", "mcp"} or m == "db.connection"
        )
        _assert(not leaked, "imported at module scope: {}".format(leaked))
    finally:
        sys.meta_path.remove(blocker)
        sys.modules.update(saved)
        # ★ Restoring sys.modules is NOT enough. `import a.b.c as m` binds via
        # getattr on the PARENT PACKAGE, not sys.modules, so after the blocked
        # reimport `scout.effects.model` (the attribute) still pointed at the
        # throwaway module while sys.modules held the original. Two live copies
        # of the same module: anything patching one was invisible to the other.
        # That silently neutered the M12 control, which read as "the test is
        # inert" when the harness was the broken part. Rebind every restored
        # submodule onto its parent.
        for name, mod in saved.items():
            if "." in name:
                parent, _, leaf = name.rpartition(".")
                if parent in sys.modules:
                    setattr(sys.modules[parent], leaf, mod)
    return True, "package imports clean with psycopg/agno/mcp blocked"


def t04_turn_groups_and_orders_effects():
    """One turn id across effects; seq strictly increasing from 1."""
    spy = SpySink()
    with flag_on():
        fx_sink.set_sink(spy)
        with fx.turn_scope(session_id=SESSION, actor_email=ACTOR) as turn:
            _assert(turn is not None, "turn_scope must yield a context when on")
            fx.record("document.generated", "insert", target_table="documents",
                      target_id=1, after={"file_name": "a.docx"})
            fx.record("person.updated", "update", target_table="people", target_id=42,
                      before={"nrc_passport_no": None}, after={"nrc_passport_no": "12/AAA(N)000001"})
            fx.record("email.queued", "external", target_label="to secretary")
        fx_sink.set_sink(None)
    ids = {e.turn_id for e in spy.effects}
    seqs = [e.seq for e in spy.effects]
    _assert(len(spy.effects) == 3, "expected 3 effects, got {}".format(len(spy.effects)))
    _assert(len(ids) == 1, "effects spread over {} turn ids".format(len(ids)))
    _assert(seqs == [1, 2, 3], "seq was {}".format(seqs))
    _assert(all(e.session_id == SESSION for e in spy.effects), "session_id not propagated")
    _assert(all(e.actor_email == ACTOR for e in spy.effects), "actor_email not propagated")
    return True, "3 effects, 1 turn id, seq={}".format(seqs)


def t05_ledger_failure_cannot_break_the_caller():
    """★ RULE 6. A ledger that throws on every call must not disturb the work.

    The primary operation here stands in for document generation: it returns a
    value and appends to a list. With an ExplodingSink installed, both the
    return value and the side effect must be exactly what they are with a
    working sink, and nothing may propagate.
    """
    generated = []

    def generate_document(name):
        # ── primary operation, exactly as a tool would write it ──
        generated.append(name)
        doc_id = len(generated)
        fx.record(
            "document.generated", "insert",
            target_table="documents", target_id=doc_id,
            target_label="Resignation Letter — {}".format(COMPANY),
            after={"file_name": name, "company_name": COMPANY},
            tool_name="generate_document",
        )
        return {"ok": True, "file_name": name, "id": doc_id}

    boom = ExplodingSink()
    with flag_on():
        fx_sink.set_sink(boom)
        # turn_scope's own open/close also explode; the body must still run.
        ran = False
        with fx.turn_scope(session_id=SESSION, actor_email=ACTOR):
            ran = True
            result = generate_document("Resignation_Letter.docx")
        fx_sink.set_sink(None)

    _assert(ran, "turn_scope body did not run when open_turn raised")
    _assert(result == {"ok": True, "file_name": "Resignation_Letter.docx", "id": 1},
            "primary operation returned {!r}".format(result))
    _assert(generated == ["Resignation_Letter.docx"], "primary side effect lost")
    _assert(boom.attempts >= 3, "sink was not actually exercised (attempts={})".format(boom.attempts))
    return True, "{} sink failures absorbed, result intact".format(boom.attempts)


def t06_ledger_failure_variants():
    """Rule 6 across failure shapes: DB error, bad data, sink returning junk."""
    cases = []
    for exc in (RuntimeError("connection refused"),
                ValueError("relation \"effect_log\" does not exist"),
                TypeError("can't adapt type 'set'"),
                MemoryError("out of memory")):
        with flag_on():
            fx_sink.set_sink(ExplodingSink(exc))
            with fx.turn_scope(session_id=SESSION):
                out = fx.record("person.updated", "update", target_table="people",
                                target_id=42, before={"a": 1}, after={"a": 2})
            fx_sink.set_sink(None)
        _assert(out is None, "record returned {!r} on {}".format(out, type(exc).__name__))
        cases.append(type(exc).__name__)
    # A malformed effect (bad op) must also be swallowed, not raised.
    with flag_on():
        fx_sink.set_sink(SpySink())
        with fx.turn_scope(session_id=SESSION):
            out = fx.record("weird", "frobnicate", target_table="people", target_id=1)
        fx_sink.set_sink(None)
    _assert(out is None, "malformed op raised or returned {!r}".format(out))
    return True, "swallowed: {} + malformed op".format(", ".join(cases))


def t07_before_image_is_field_scoped():
    """An update stores only the columns that actually moved."""
    before_row = {
        "id": 42, "full_name": PERSON, "nrc_passport_no": None,
        "father_name": None, "business_occupation": "Director",
        "country_of_residence": "Myanmar", "address": "No. 12, Yangon",
    }
    after_row = dict(before_row, nrc_passport_no="12/AAA(N)000001")
    spy = SpySink()
    with flag_on():
        fx_sink.set_sink(spy)
        with fx.turn_scope(session_id=SESSION):
            fx.record("person.updated", "update", target_table="people", target_id=42,
                      target_label=PERSON, before=before_row, after=after_row)
        fx_sink.set_sink(None)
    e = spy.effects[0]
    _assert(set(e.before_image) == {"nrc_passport_no"},
            "before_image keys were {}".format(sorted(e.before_image)))
    _assert(set(e.after_image) == {"nrc_passport_no"},
            "after_image keys were {}".format(sorted(e.after_image)))
    _assert(e.before_image["nrc_passport_no"] is None, "before value wrong")
    _assert(e.after_image["nrc_passport_no"] == "12/AAA(N)000001", "after value wrong")
    _assert(e.reversible is True, "a field-scoped update must be reversible")
    return True, "7 columns in, 1 stored, reversible=True"


def t08_diff_marks_absent_keys_explicitly():
    """A key on one side only is emitted on both, the missing side as None."""
    b, a = fx.diff_images({"x": 1}, {"x": 1, "y": 2})
    _assert(set(b) == {"y"} and set(a) == {"y"}, "keys were {} / {}".format(sorted(b), sorted(a)))
    _assert(b["y"] is None, "absent-before must be explicit None, got {!r}".format(b["y"]))
    _assert(a["y"] == 2, "after value wrong")
    # No change at all: both sides existed, nothing moved.
    b2, a2 = fx.diff_images({"x": 1}, {"x": 1})
    _assert(b2 == {} and a2 == {}, "unchanged pair gave {} / {}".format(b2, a2))
    # One side genuinely absent stays None, which is not the same as {}.
    b3, a3 = fx.diff_images(None, {"x": 1})
    _assert(b3 is None and a3 == {"x": 1}, "insert-shaped diff gave {} / {}".format(b3, a3))
    return True, "absent→None, unchanged→{}, insert→None"


def t09_oversized_image_flips_reversibility():
    """Over the cap: truncated AND reversible turned off, with a reason."""
    huge = {"directors": ["Director {}".format(i) for i in range(20000)], "id": 9}
    size = len(__import__("json").dumps(huge))
    _assert(size > fx.MAX_IMAGE_BYTES, "fixture is not actually oversized ({}B)".format(size))
    spy = SpySink()
    with flag_on():
        fx_sink.set_sink(spy)
        with fx.turn_scope(session_id=SESSION):
            fx.record("company.updated", "update", target_table="companies", target_id=9,
                      target_label=COMPANY, before=huge, after={"directors": [], "id": 9})
        fx_sink.set_sink(None)
    e = spy.effects[0]
    _assert(fx.is_truncated(e.before_image), "oversized before_image was not truncated")
    _assert("directors" in e.before_image["_keys"], "truncation marker lost the key names")
    _assert(e.reversible is False, "truncated effect still claims reversible=True")
    _assert(e.irreversible_reason and "truncated" in e.irreversible_reason,
            "reason was {!r}".format(e.irreversible_reason))
    stored = len(__import__("json").dumps(e.before_image))
    _assert(stored < fx.MAX_IMAGE_BYTES, "stored image is still {}B".format(stored))
    return True, "{}B in → {}B stored, reversible False".format(size, stored)


def t10_reversibility_rules():
    """Every op's reversibility, decided by the writer and not guessed later."""
    cases = [
        # (op, table, id, before, truncated, expected)
        ("insert", "documents", "7", None, False, True),
        ("update", "people", "42", {"a": 1}, False, True),
        ("update", "people", "42", None, False, False),
        ("update", "people", "42", {}, False, False),
        ("delete", "people", "42", {"a": 1}, False, True),
        ("external", None, None, None, False, False),
        ("external", "documents", "7", {"a": 1}, False, False),
        ("insert", None, None, None, False, False),
        ("insert", "documents", None, None, False, False),
        ("update", "people", "42", {"a": 1}, True, False),
    ]
    for op, tbl, tid, before, trunc, expected in cases:
        got, reason = fx.decide_reversibility(op, tbl, tid, before, trunc)
        _assert(got is expected,
                "{} {}/{} before={} trunc={} → {} (want {})".format(
                    op, tbl, tid, before, trunc, got, expected))
        if not got:
            _assert(reason, "irreversible case gave no reason: {} {}".format(op, tbl))
    return True, "{} cases, every irreversible one carries a reason".format(len(cases))


def t11_delete_keeps_the_whole_row():
    """A delete stores the full row — a diff of it would not be re-insertable.

    Two shapes, and the SECOND is the one that matters. A hard delete passes
    after=None, and diff_images against None already returns every key, so it
    would pass with or without the override in build_effect — asserting only
    that shape is a test that cannot fail. The real case is the SOFT delete:
    ``migration_025`` adds people cessation, so a caller can legitimately
    record op='delete' with after={"resigned_date": ...}. Field-scoping that
    would store one column as the before image of a row removal, and the
    re-insert would rebuild a person with nothing but a resignation date.
    """
    row = {"id": 42, "full_name": PERSON, "nrc_passport_no": "12/AAA(N)000001",
           "father_name": "U Tin Maung", "country_of_residence": "Myanmar"}
    spy = SpySink()
    with flag_on():
        fx_sink.set_sink(spy)
        with fx.turn_scope(session_id=SESSION):
            # diff=True is passed on purpose: build_effect must override it.
            fx.record("person.deleted", "delete", target_table="people", target_id=42,
                      target_label=PERSON, before=row, after=None, diff=True)
            # Soft delete: only one column moves, but the whole row must be kept.
            fx.record("person.ceased", "delete", target_table="people", target_id=42,
                      target_label=PERSON, before=row,
                      after=dict(row, resigned_date="2026-08-24"), diff=True)
        fx_sink.set_sink(None)

    hard, soft = spy.effects[0], spy.effects[1]
    _assert(set(hard.before_image) == set(row),
            "hard delete stored {} of {} columns".format(len(hard.before_image), len(row)))
    _assert(hard.after_image is None, "hard delete should have no after image")
    _assert(hard.reversible is True, "a full-row delete must be reversible")

    _assert(set(soft.before_image) == set(row),
            "soft delete field-scoped the before image to {} — the whole row is "
            "needed to re-insert".format(sorted(soft.before_image)))
    _assert(soft.before_image["full_name"] == PERSON,
            "soft delete lost full_name from the before image")
    _assert(set(soft.after_image) == set(row) | {"resigned_date"},
            "soft delete after image was {}".format(sorted(soft.after_image)))
    _assert(soft.reversible is True, "a full-row soft delete must be reversible")
    return True, "hard: {}/{} cols; soft: {}/{} cols despite 1 changed".format(
        len(hard.before_image), len(row), len(soft.before_image), len(row))


def t12_effect_outside_a_turn_is_dropped():
    """No turn in scope: drop, rather than invent a turn boundary."""
    spy = SpySink()
    with flag_on():
        fx_sink.set_sink(spy)
        out = fx.record("document.generated", "insert", target_table="documents", target_id=1)
        fx_sink.set_sink(None)
    _assert(out is None, "record outside a turn returned {!r}".format(out))
    _assert(spy.effects == [], "{} effect(s) written with no turn".format(len(spy.effects)))
    return True, "dropped, no synthesised turn id"


def t13_turn_scope_is_reset_on_exception():
    """A turn that raises must not leak its id into the next one."""
    with flag_on():
        fx_sink.set_sink(SpySink())
        try:
            with fx.turn_scope(session_id=SESSION):
                _assert(fx.current_turn_id() is not None, "no turn inside scope")
                raise Ok("boom")
        except Ok:
            pass
        leaked = fx.current_turn_id()
        fx_sink.set_sink(None)
    _assert(leaked is None, "turn id {!r} leaked past a failed turn".format(leaked))
    return True, "turn id cleared after an exception"


def t13b_turn_scope_resets_when_open_turn_raises():
    """★ The leak M03 exposed: a throwing open_turn must still reset the scope.

    ``_safe_open`` swallows, so this cannot happen through the front door — but
    it sits between ``_current.set(token)`` and the body, and if it is ever
    reachable as a raise the ``finally`` is the only thing that clears the
    ContextVar. Without that, one failed turn silently adopts every later
    request on the same task. Found by the control run, not by reading.
    """
    orig_open = fx_turn._safe_open
    fx_turn._safe_open = lambda ctx: (_ for _ in ()).throw(RuntimeError("open failed"))
    try:
        with flag_on():
            fx_sink.set_sink(SpySink())
            try:
                with fx.turn_scope(session_id=SESSION):
                    pass
            except RuntimeError:
                pass
            leaked = fx.current_turn_id()
            fx_sink.set_sink(None)
    finally:
        fx_turn._safe_open = orig_open
    _assert(leaked is None, "turn id {!r} leaked after open_turn raised".format(leaked))
    return True, "scope cleared even when open_turn throws"


def t14_nested_turns_do_not_bleed():
    """Turn ids are distinct and the outer one is restored on exit."""
    with flag_on():
        fx_sink.set_sink(SpySink())
        with fx.turn_scope(session_id="outer") as a:
            outer = a.turn_id
            with fx.turn_scope(session_id="inner") as b:
                inner = b.turn_id
                _assert(fx.current_turn_id() == inner, "inner scope not active")
            _assert(fx.current_turn_id() == outer, "outer turn not restored")
        fx_sink.set_sink(None)
    _assert(outer != inner, "nested turns shared an id")
    return True, "distinct ids, outer restored"


def t15_seq_is_unique_under_concurrency():
    """Two threads inside one turn must not be handed the same seq."""
    spy = SpySink()
    n = 200
    with flag_on():
        fx_sink.set_sink(spy)
        ctx = fx.TurnContext(turn_id="t-conc", session_id=SESSION)
        seen = []
        lock = threading.Lock()

        def worker():
            local = [ctx.next_seq() for _ in range(n)]
            with lock:
                seen.extend(local)

        threads = [threading.Thread(target=worker) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        fx_sink.set_sink(None)
    _assert(len(seen) == 4 * n, "expected {} seqs, got {}".format(4 * n, len(seen)))
    _assert(len(set(seen)) == 4 * n,
            "{} duplicate seq value(s)".format(4 * n - len(set(seen))))
    _assert(min(seen) == 1 and max(seen) == 4 * n, "seq range {}..{}".format(min(seen), max(seen)))
    return True, "{} seqs across 4 threads, 0 duplicates".format(len(seen))


def t16_sink_never_borrows_a_connection():
    """PostgresSink must have no way to be handed the caller's connection.

    This is the schema-level half of rule 6: a ledger insert on a shared
    connection poisons the caller's transaction even when the Python exception
    is caught. The guard is structural — no method may accept a connection.
    """
    import inspect

    for name in ("open_turn", "close_turn", "write", "_connect"):
        fn = getattr(fx_sink.PostgresSink, name)
        params = set(inspect.signature(fn).parameters) - {"self"}
        bad = {p for p in params if "conn" in p.lower() or "cur" in p.lower()}
        _assert(not bad, "PostgresSink.{} accepts {}".format(name, sorted(bad)))
    src = inspect.getsource(fx_sink.PostgresSink)
    _assert("get_db_conn(autocommit=True)" in src,
            "PostgresSink does not open its own autocommit connection")
    _assert(src.count("conn.close()") >= 3, "not every method closes its connection")
    return True, "4 methods, 0 connection parameters, autocommit, closed"


def t17_migration_follows_the_runner_rules():
    """db/migrate.py's constraints, checked against the file itself."""
    path = REPO / "db" / "migration_024_effects.sql"
    _assert(path.exists(), "migration file missing")
    sql = path.read_text()

    body = "\n".join(
        line for line in sql.splitlines() if not line.strip().startswith("--")
    )
    _assert("%s" not in body, "migration contains a %s placeholder (cur.execute would bind it)")
    _assert("schema_migrations" not in body,
            "migration writes schema_migrations itself — the runner already does")
    _assert(body.count("CREATE TABLE IF NOT EXISTS") == 2,
            "expected 2 idempotent CREATE TABLEs, got {}".format(
                body.count("CREATE TABLE IF NOT EXISTS")))
    _assert("CREATE TABLE " not in body.replace("CREATE TABLE IF NOT EXISTS", ""),
            "a CREATE TABLE without IF NOT EXISTS")
    idx = body.count("CREATE INDEX IF NOT EXISTS")
    _assert(idx >= 6, "expected the six indexes, found {}".format(idx))
    _assert("CREATE INDEX " not in body.replace("CREATE INDEX IF NOT EXISTS", ""),
            "a CREATE INDEX without IF NOT EXISTS")
    _assert("REFERENCES" not in body.upper(), "migration declares a foreign key")
    _assert("DROP TABLE IF EXISTS effect_log;" in sql, "no reversing DROP for effect_log")
    _assert("DROP TABLE IF EXISTS effect_turns;" in sql, "no reversing DROP for effect_turns")
    for stmt in ("DROP TABLE IF EXISTS effect_log;", "DROP TABLE IF EXISTS effect_turns;"):
        for line in sql.splitlines():
            if stmt in line:
                _assert(line.strip().startswith("--"),
                        "reversing DROP is live SQL, not commented: {}".format(line.strip()))
    return True, "2 tables, {} indexes, no %s, no FK, no schema_migrations, DROPs commented".format(idx)


def t18_future_annotations_everywhere():
    """Local python is 3.9.6; every new module needs the __future__ import."""
    pkg = REPO / "scout" / "effects"
    files = sorted(pkg.glob("*.py")) + [Path(__file__)]
    missing = []
    for f in files:
        head = f.read_text()
        if "from __future__ import annotations" not in head:
            missing.append(f.name)
    _assert(not missing, "missing __future__ annotations in: {}".format(missing))
    _assert(len(files) >= 6, "expected the package's modules, found {}".format(len(files)))
    return True, "{} files, all carry it".format(len(files))


def t19_columns_match_the_migration():
    """Every column the sink writes exists in the migration, and vice versa."""
    import re

    sql = (REPO / "db" / "migration_024_effects.sql").read_text()
    block = sql.split("CREATE TABLE IF NOT EXISTS effect_log (", 1)[1].split(");", 1)[0]
    cols = set()
    for line in block.splitlines():
        line = line.strip()
        if not line or line.startswith("--"):
            continue
        m = re.match(r"([a-z_]+)\s+[A-Z]", line)
        if m:
            cols.add(m.group(1))
    _assert("id" in cols and "created_at" in cols, "parsed columns look wrong: {}".format(sorted(cols)))

    written = set(
        fx_model.Effect(kind="k", op="insert").as_row().keys()
    )
    missing = written - cols
    _assert(not missing, "sink writes columns absent from the migration: {}".format(sorted(missing)))

    # The insert statement's column list must match as_row() exactly — a
    # mismatch binds values to the wrong columns silently.
    ins = fx_sink._INSERT_SQL.split("(", 1)[1].split(")", 1)[0]
    ins_cols = [c.strip() for c in ins.split(",")]
    _assert(set(ins_cols) == written,
            "INSERT columns {} != as_row() {}".format(sorted(ins_cols), sorted(written)))
    _assert(fx_sink._INSERT_SQL.count("%s") == len(ins_cols),
            "{} columns but {} placeholders".format(len(ins_cols), fx_sink._INSERT_SQL.count("%s")))
    return True, "{} written columns, all present, {} placeholders".format(len(written), len(ins_cols))


def t20_ops_closed_set_matches_the_check_constraint():
    """model.OPS and the SQL CHECK must not drift apart."""
    sql = (REPO / "db" / "migration_024_effects.sql").read_text()
    chunk = sql.split("CHECK (op IN (", 1)[1].split("))", 1)[0]
    sql_ops = {p.strip().strip("'") for p in chunk.split(",")}
    _assert(sql_ops == set(fx.OPS),
            "SQL {} vs model {}".format(sorted(sql_ops), sorted(fx.OPS)))
    return True, "both = {}".format(sorted(sql_ops))


def t24_product_record_calls_use_a_valid_op():
    """★ Every `record(...)` in product code must pass an op from `OPS`.

    `record` swallows everything — a bad argument is logged at WARNING and
    dropped — so an invalid `op` does not fail, it just means the ledger stays
    EMPTY while the code looks wired. That is exactly what happened: the first
    document call site passed op="create", which is not in
    ('insert','update','delete','external'), and the only symptom was zero rows.

    Read with AST, not a text scan: an op named in a comment or a docstring must
    not be able to satisfy this.
    """
    import ast as _ast

    offenders = []
    checked = 0
    for path in sorted((REPO / "scout").rglob("*.py")) + sorted((REPO / "app").rglob("*.py")):
        if "effects" in path.parts and path.parent.name == "effects":
            continue  # the layer's own tests/fixtures may exercise bad values
        try:
            tree = _ast.parse(path.read_text())
        except SyntaxError:
            continue
        for node in _ast.walk(tree):
            if not isinstance(node, _ast.Call):
                continue
            fname = getattr(node.func, "id", None) or getattr(node.func, "attr", None)
            if fname != "record":
                continue
            for kw in node.keywords:
                if kw.arg != "op":
                    continue
                checked += 1
                if isinstance(kw.value, _ast.Constant) and kw.value.value not in fx.OPS:
                    offenders.append("{}:{} op={!r}".format(
                        path.relative_to(REPO), node.lineno, kw.value.value))
    _assert(not offenders, "invalid op(s): {}".format(offenders))
    _assert(checked > 0, "no record(op=...) call sites found — the scan is inert")
    return True, "{} call site(s), all ops valid".format(checked)


def t21_session_falls_back_to_the_tools_context_var():
    """The turn opens without a session; the tools layer's ContextVar fills it.

    The middleware cannot cheaply read the agno session id (it is in the
    multipart body of POST /agents/{id}/runs). ``scout.tools.slot_resolver``
    already tracks it in a ContextVar for the party-picker scoping, so the
    ledger reads that. Stubbed here rather than imported, because
    slot_resolver pulls in psycopg.
    """
    stub = types.ModuleType("scout.tools.slot_resolver")
    stub.current_session_scope = lambda: "sess-from-run-context"  # type: ignore
    tools_pkg = sys.modules.get("scout.tools")
    made_pkg = False
    if tools_pkg is None:
        tools_pkg = types.ModuleType("scout.tools")
        tools_pkg.__path__ = [str(REPO / "scout" / "tools")]  # type: ignore
        sys.modules["scout.tools"] = tools_pkg
        made_pkg = True
    prev = sys.modules.get("scout.tools.slot_resolver")
    sys.modules["scout.tools.slot_resolver"] = stub

    spy = SpySink()
    try:
        with flag_on():
            fx_sink.set_sink(spy)
            with fx.turn_scope(actor_email=ACTOR) as turn:  # no session_id given
                _assert(turn.session_id is None, "turn started with a session id")
                fx.record("document.generated", "insert", target_table="documents",
                          target_id=1, after={"file_name": "a.docx"})
                bound = turn.session_id
                fx.record("person.updated", "update", target_table="people", target_id=42,
                          before={"a": None}, after={"a": 1})
            fx_sink.set_sink(None)
    finally:
        if prev is not None:
            sys.modules["scout.tools.slot_resolver"] = prev
        else:
            sys.modules.pop("scout.tools.slot_resolver", None)
        if made_pkg:
            sys.modules.pop("scout.tools", None)

    _assert(all(e.session_id == "sess-from-run-context" for e in spy.effects),
            "session ids were {}".format([e.session_id for e in spy.effects]))
    _assert(bound == "sess-from-run-context", "session was not memoised onto the turn")

    # And an unavailable slot_resolver must cost nothing but the session id.
    spy2 = SpySink()
    with flag_on():
        fx_sink.set_sink(spy2)
        with fx.turn_scope(actor_email=ACTOR):
            fx.record("document.generated", "insert", target_table="documents", target_id=2)
        fx_sink.set_sink(None)
    _assert(len(spy2.effects) == 1, "effect lost when the session lookup failed")
    _assert(spy2.effects[0].session_id is None, "session id invented from nowhere")
    return True, "2 effects carry the ambient session; lookup failure costs 0 effects"


def t22_bind_session_is_explicit_and_safe():
    """bind_session sets the turn's session; outside a turn it is a no-op."""
    with flag_on():
        fx_sink.set_sink(SpySink())
        fx.bind_session("no-turn-here")  # must not raise
        with fx.turn_scope() as turn:
            fx.bind_session("sess-explicit")
            _assert(turn.session_id == "sess-explicit", "bind_session did not set it")
            fx.bind_session("")  # falsey: must not clear a real value
            _assert(turn.session_id == "sess-explicit", "empty bind cleared the session")
            fx.bind_session("  padded  ")
            _assert(turn.session_id == "padded", "bind_session did not strip")
        fx_sink.set_sink(None)
    return True, "sets, strips, ignores empty, no-ops outside a turn"


def t23_turn_survives_a_streaming_response():
    """★ Agent turns STREAM. Does the turn reach effects recorded in the tail?

    Under BaseHTTPMiddleware, `call_next` returns once the response headers are
    ready; an SSE body streams afterwards, while the agent is still calling
    tools. If the turn did not reach those tool calls they would carry no turn
    id and E12 would drop them — silent data loss, not a stale counter.

    Measured, not reasoned: a real BaseHTTPMiddleware around a real
    StreamingResponse, recording through the real `record`. Two facts pinned:

      1. every effect — including ones recorded after the middleware's
         `with` block has exited — carries the middleware's turn id;
      2. `close_turn` sees a SMALLER count than the turn finally produced,
         which is why effect_turns.effect_count is a hint and any per-turn
         view must COUNT from effect_log.

    Sensitivity is proven by M15, which opens the turn in a task the request
    does not inherit from and takes this to 0 effects recorded.
    """
    try:
        from starlette.applications import Starlette
        from starlette.middleware.base import BaseHTTPMiddleware
        from starlette.responses import StreamingResponse
        from starlette.routing import Route
        from starlette.testclient import TestClient
    except Exception as e:
        return None, "SKIPPED — starlette/httpx unavailable ({})".format(type(e).__name__)

    class SnapSink(fx_sink.MemorySink):
        """Snapshots effect_count AT close time.

        ``TurnContext.effect_count`` is a live property over ``_seq``, so
        reading it after the run reports the FINAL count, not what close_turn
        saw. Reading it late is how the first version of this measurement
        concluded, wrongly, that there was no under-report at all.
        """

        def __init__(self):
            super().__init__()
            self.count_at_close = None

        def close_turn(self, ctx):
            self.count_at_close = ctx.effect_count
            return super().close_turn(ctx)

    state = {}

    async def endpoint(request):
        fx.record("document.generated", "insert", target_table="documents",
                  target_id=1, after={"file_name": "in_endpoint.docx"})

        async def event_stream():
            # Runs after the middleware's `with` block has already exited.
            for i in range(3):
                fx.record("person.updated", "update", target_table="people",
                          target_id=100 + i, before={"x": None}, after={"x": i})
                yield "data: {}\n\n".format(i).encode()

        return StreamingResponse(event_stream(), media_type="text/event-stream")

    class TurnMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            with fx.turn_scope(session_id=SESSION, actor_email=ACTOR) as turn:
                state["turn_id"] = turn.turn_id
                return await call_next(request)

    spy = SnapSink()
    with flag_on():
        fx_sink.set_sink(spy)
        app = Starlette(routes=[Route("/agents/scout/runs", endpoint, methods=["POST"])])
        app.add_middleware(TurnMiddleware)
        TestClient(app).post("/agents/scout/runs")
        fx_sink.set_sink(None)

    tid = state.get("turn_id")
    _assert(tid, "middleware never opened a turn")
    _assert(len(spy.effects) == 4,
            "expected 4 effects (1 endpoint + 3 streamed), got {}".format(len(spy.effects)))
    carried = sum(1 for e in spy.effects if e.turn_id == tid)
    _assert(carried == 4,
            "only {}/4 effects carried the turn id — tail effects are being "
            "dropped".format(carried))
    _assert(len({e.turn_id for e in spy.effects}) == 1, "effects split across turns")

    _assert(spy.count_at_close is not None, "close_turn never ran")
    _assert(spy.count_at_close < len(spy.effects),
            "effect_count at close ({}) did not under-report against {} — if this "
            "ever stops being true the 'hint' caveat can be dropped".format(
                spy.count_at_close, len(spy.effects)))
    return True, "4/4 effects carry the turn id; effect_count at close {} vs {} final".format(
        spy.count_at_close, len(spy.effects))


TESTS = [
    ("E01", "flag defaults to off, parses truthy/falsey", t01_flag_default_off),
    ("E02", "flag off is a total no-op", t02_flag_off_is_a_no_op),
    ("E03", "no psycopg/agno/mcp import at module scope", t03_no_infrastructure_imports),
    ("E04", "one turn id groups effects, seq orders them", t04_turn_groups_and_orders_effects),
    ("E05", "★ ledger failure cannot break the caller", t05_ledger_failure_cannot_break_the_caller),
    ("E06", "rule 6 across failure shapes", t06_ledger_failure_variants),
    ("E07", "before-image is field-scoped", t07_before_image_is_field_scoped),
    ("E08", "diff marks absent keys explicitly", t08_diff_marks_absent_keys_explicitly),
    ("E09", "oversized image truncates AND flips reversible", t09_oversized_image_flips_reversibility),
    ("E10", "reversibility rules per op", t10_reversibility_rules),
    ("E11", "delete keeps the whole row", t11_delete_keeps_the_whole_row),
    ("E12", "effect outside a turn is dropped", t12_effect_outside_a_turn_is_dropped),
    ("E13", "turn scope reset after an exception", t13_turn_scope_is_reset_on_exception),
    ("E13b", "★ turn scope reset when open_turn raises", t13b_turn_scope_resets_when_open_turn_raises),
    ("E14", "nested turns do not bleed", t14_nested_turns_do_not_bleed),
    ("E15", "seq unique under concurrency", t15_seq_is_unique_under_concurrency),
    ("E16", "sink never borrows a connection", t16_sink_never_borrows_a_connection),
    ("E17", "migration follows the runner's rules", t17_migration_follows_the_runner_rules),
    ("E18", "__future__ annotations in every module", t18_future_annotations_everywhere),
    ("E19", "written columns match the migration", t19_columns_match_the_migration),
    ("E20", "ops closed set matches the CHECK", t20_ops_closed_set_matches_the_check_constraint),
    ("E21", "session falls back to the tools ContextVar", t21_session_falls_back_to_the_tools_context_var),
    ("E22", "bind_session is explicit and safe", t22_bind_session_is_explicit_and_safe),
    ("E23", "★ turn survives a streaming response", t23_turn_survives_a_streaming_response),
    ("E24", "★ product record() calls use a valid op", t24_product_record_calls_use_a_valid_op),
]


def _clear_turn_scope():
    """Drop any turn a previous test or mutation left in the ContextVar.

    Without this a single leaking mutation contaminates every mutation after
    it, and the control table fills with collateral failures that hide whether
    the mutation broke the test it was aimed at. That is precisely how the M03
    leak was mistaken for twelve unrelated ones on the first run.
    """
    try:
        fx_turn._current.set(None)
    except Exception:
        pass


def run_suite(quiet=False):
    rows = []
    _clear_turn_scope()
    for tid, desc, fn in TESTS:
        try:
            passed, detail = fn()
            # passed is None == SKIP: the assertion never ran. Reported as its
            # own state and called out in the summary, because a skip counted
            # as a pass is how a dead test survives.
            rows.append((tid, desc, "SKIP" if passed is None else ("PASS" if passed else "FAIL"), detail))
        except AssertionError as e:
            rows.append((tid, desc, "FAIL", str(e)[:110]))
        except Exception as e:
            rows.append((tid, desc, "ERROR", "{}: {}".format(type(e).__name__, e)[:110]))
        finally:
            fx_sink.reset_sink()
            _clear_turn_scope()

    failures = sum(1 for _, _, r, _ in rows if r in ("FAIL", "ERROR"))
    if not quiet:
        width = max(len(d) for _, d, _, _ in rows) + 2
        print("\n{:<5} {:<8} {:<{w}} DETAIL".format("ID", "RESULT", "CASE", w=width))
        print("-" * (16 + width + 60))
        for tid, desc, result, detail in rows:
            print("{:<5} {:<8} {:<{w}} {}".format(tid, result, desc, detail, w=width))
        counts = {}
        for _, _, r, _ in rows:
            counts[r] = counts.get(r, 0) + 1
        print("\nSUMMARY: " + " · ".join("{}={}".format(k, v) for k, v in sorted(counts.items())))
    return failures, rows


# ── negative controls ───────────────────────────────────────────────────────
# Each mutation breaks ONE behaviour. The suite is re-run under it and the
# failure count is printed before/after. A mutation that moves nothing means
# the test guarding it is not a test.

def _mut_flag_always_on():
    orig = fx_flag.ledger_enabled
    fx_flag.ledger_enabled = lambda: True
    fx_recorder.ledger_enabled = lambda: True
    fx_turn.ledger_enabled = lambda: True
    def undo():
        fx_flag.ledger_enabled = orig
        fx_recorder.ledger_enabled = orig
        fx_turn.ledger_enabled = orig
    return undo


def _mut_recorder_reraises():
    """record() propagates instead of swallowing — the rule-6 break."""
    orig = fx_recorder.record

    def raising(kind, op, **kw):
        turn = fx_turn.current_turn()
        if turn is None:
            return None
        from scout.effects.model import build_effect
        effect = build_effect(kind=kind, op=op, turn_id=turn.turn_id,
                              seq=turn.next_seq(), session_id=turn.session_id,
                              actor_email=turn.actor_email,
                              tool_name=kw.get("tool_name"),
                              target_table=kw.get("target_table"),
                              target_id=kw.get("target_id"),
                              target_label=kw.get("target_label"),
                              before=kw.get("before"), after=kw.get("after"),
                              diff=kw.get("diff", True))
        return fx_sink.get_sink().write(effect)

    fx_recorder.record = raising
    fx.record = raising
    def undo():
        fx_recorder.record = orig
        fx.record = orig
    return undo


def _mut_turn_scope_reraises():
    """turn_scope stops absorbing open_turn/close_turn failures."""
    orig_open, orig_close = fx_turn._safe_open, fx_turn._safe_close
    fx_turn._safe_open = lambda ctx: fx_sink.get_sink().open_turn(ctx)
    fx_turn._safe_close = lambda ctx: fx_sink.get_sink().close_turn(ctx)
    def undo():
        fx_turn._safe_open, fx_turn._safe_close = orig_open, orig_close
    return undo


def _mut_no_diff():
    """Store whole rows instead of field-scoping them."""
    orig = fx_model.diff_images
    fx_model.diff_images = lambda b, a: (dict(b) if b is not None else None,
                                         dict(a) if a is not None else None)
    def undo():
        fx_model.diff_images = orig
    return undo


def _mut_cap_does_not_flip_reversible():
    """Truncate the image but keep claiming the effect is reversible."""
    orig = fx_model.decide_reversibility

    def lax(op, table, tid, before, truncated):
        return orig(op, table, tid, before, False)

    fx_model.decide_reversibility = lax
    def undo():
        fx_model.decide_reversibility = orig
    return undo


def _mut_no_cap():
    """Raise the cap so nothing is ever truncated."""
    orig = fx_model.MAX_IMAGE_BYTES
    fx_model.MAX_IMAGE_BYTES = 10 ** 9
    def undo():
        fx_model.MAX_IMAGE_BYTES = orig
    return undo


def _mut_seq_unlocked():
    """Hand out seq without the lock — the concurrency break."""
    orig = fx_turn.TurnContext.next_seq

    def racy(self):
        v = self._seq + 1
        # A busy loop is not enough to force a switch — CPython holds the GIL
        # through it and the first version of this mutation was inert. sleep(0)
        # yields unconditionally, which is what actually opens the window the
        # lock was closing.
        import time

        time.sleep(0)
        self._seq = v
        return v

    fx_turn.TurnContext.next_seq = racy
    def undo():
        fx_turn.TurnContext.next_seq = orig
    return undo


def _mut_turn_not_reset():
    """Leave the ContextVar set after the scope exits."""
    orig = fx_turn.turn_scope
    import contextlib as _c

    @_c.contextmanager
    def leaky(session_id=None, actor_email=None, turn_id=None, meta=None):
        if not fx_flag.ledger_enabled():
            yield None
            return
        ctx = fx_turn.TurnContext(turn_id or fx_turn.new_turn_id(), session_id, actor_email, meta)
        fx_turn._current.set(ctx)
        fx_turn._safe_open(ctx)
        yield ctx  # no finally, no reset

    fx_turn.turn_scope = leaky
    fx.turn_scope = leaky
    def undo():
        fx_turn.turn_scope = orig
        fx.turn_scope = orig
    return undo


def _mut_record_invents_a_turn():
    """Synthesise a turn id when none is in scope."""
    orig = fx_turn.current_turn
    fx_recorder.current_turn = lambda: fx_turn.current_turn() or fx_turn.TurnContext(
        fx_turn.new_turn_id(), "synthetic"
    )
    def undo():
        fx_recorder.current_turn = orig
    return undo


def _mut_ops_drift():
    """Add an op the SQL CHECK does not know about."""
    orig = fx_model.OPS
    fx_model.OPS = orig + ("archive",)
    fx.OPS = fx_model.OPS
    def undo():
        fx_model.OPS = orig
        fx.OPS = orig
    return undo


def _mut_insert_columns_drift():
    """Drop a column from the INSERT statement."""
    orig = fx_sink._INSERT_SQL
    fx_sink._INSERT_SQL = orig.replace("before_image, after_image,", "after_image,")
    def undo():
        fx_sink._INSERT_SQL = orig
    return undo


def _mut_delete_gets_diffed():
    """Let a delete be field-scoped like an update."""
    orig = fx_model.build_effect

    def no_override(**kw):
        kw["diff"] = True
        if kw.get("op") == "delete":
            # Reproduce build_effect without the delete override.
            b, a = fx_model.diff_images(kw.get("before"), kw.get("after"))
            b, bt = fx_model.cap_image(b)
            a, at = fx_model.cap_image(a)
            tid = None if kw.get("target_id") is None else str(kw["target_id"])
            rev, reason = fx_model.decide_reversibility(
                "delete", kw.get("target_table"), tid, b, bt or at)
            return fx_model.Effect(
                kind=kw["kind"], op="delete", turn_id=kw["turn_id"], seq=kw["seq"],
                session_id=kw.get("session_id"), actor_email=kw.get("actor_email"),
                tool_name=kw.get("tool_name"), target_table=kw.get("target_table"),
                target_id=tid, target_label=kw.get("target_label"),
                before_image=b, after_image=a, reversible=rev, irreversible_reason=reason)
        return orig(**kw)

    # Patch through the reference bound at import time AND the sys.modules
    # entry, so the mutation lands whichever of the two `record`'s inner
    # `from scout.effects.model import build_effect` resolves against.
    fx_model.build_effect = no_override
    sys.modules["scout.effects.model"].build_effect = no_override

    def undo():
        fx_model.build_effect = orig
        sys.modules["scout.effects.model"].build_effect = orig

    return undo


def _mut_session_fallback_removed():
    """Stop consulting the tools layer's session ContextVar."""
    orig = fx_turn.ambient_session
    fx_turn.ambient_session = lambda: None
    fx_recorder.ambient_session = lambda: None
    def undo():
        fx_turn.ambient_session = orig
        fx_recorder.ambient_session = orig
    return undo


def _mut_bind_session_clears_on_empty():
    """Let a falsey bind_session wipe a session already bound."""
    orig = fx_turn.bind_session

    def clobber(session_id):
        turn = fx_turn._current.get()
        if turn is not None:
            turn.session_id = str(session_id or "").strip() or None

    fx_turn.bind_session = clobber
    fx.bind_session = clobber
    def undo():
        fx_turn.bind_session = orig
        fx.bind_session = orig
    return undo


def _mut_turn_opened_in_a_separate_task():
    """Open the turn in a task the request does not inherit from.

    The mechanism actually feared for E23: if the turn does not reach the
    request's context, every effect is recorded with no turn and dropped.
    """
    import asyncio
    import contextlib as _c

    orig = fx_turn.turn_scope

    @_c.contextmanager
    def detached(session_id=None, actor_email=None, turn_id=None, meta=None):
        if not fx_flag.ledger_enabled():
            yield None
            return
        ctx = fx_turn.TurnContext(turn_id or fx_turn.new_turn_id(), session_id, actor_email, meta)
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        if loop is None:
            # Outside async code behave normally, so this mutation only bites
            # the streaming test it is aimed at.
            with orig(session_id, actor_email, turn_id, meta) as c:
                yield c
            return
        yield ctx  # never set into the ContextVar

    fx_turn.turn_scope = detached
    fx.turn_scope = detached

    def undo():
        fx_turn.turn_scope = orig
        fx.turn_scope = orig

    return undo


MUTATIONS = [
    ("M01", "flag reads as always-ON", _mut_flag_always_on, "E02"),
    ("M02", "★ record() re-raises instead of swallowing", _mut_recorder_reraises, "E05, E06"),
    ("M03", "★ turn_scope re-raises open/close failures", _mut_turn_scope_reraises, "E05, E13b"),
    ("M04", "diff removed — whole rows stored", _mut_no_diff, "E07, E08"),
    ("M05", "★ cap no longer flips reversible", _mut_cap_does_not_flip_reversible, "E09, E10"),
    ("M06", "cap raised — nothing truncates", _mut_no_cap, "E09"),
    ("M07", "seq handed out without the lock", _mut_seq_unlocked, "E15"),
    ("M08", "turn ContextVar never reset", _mut_turn_not_reset, "E13, E14"),
    ("M09", "record invents a turn id when none", _mut_record_invents_a_turn, "E12"),
    ("M10", "OPS drifts from the SQL CHECK", _mut_ops_drift, "E20"),
    ("M11", "INSERT column list drifts", _mut_insert_columns_drift, "E19"),
    ("M12", "delete gets field-scoped", _mut_delete_gets_diffed, "E11"),
    ("M13", "session fallback to slot_resolver removed", _mut_session_fallback_removed, "E21"),
    ("M14", "empty bind_session clears the session", _mut_bind_session_clears_on_empty, "E22"),
    ("M15", "★ turn never reaches the request context", _mut_turn_opened_in_a_separate_task, "E23"),
]


def run_controls():
    base_failures, base_rows = run_suite(quiet=True)
    base_failed_ids = {t for t, _, r, _ in base_rows if r != "PASS"}
    print("\nNEGATIVE CONTROLS — baseline failures: {}/{}".format(base_failures, len(TESTS)))
    print("-" * 108)
    print("{:<5} {:<44} {:<8} {:<8} {}".format("ID", "MUTATION", "BEFORE", "AFTER", "TESTS THAT FLIPPED"))
    print("-" * 108)
    bad = []
    for mid, desc, apply_mut, expected in MUTATIONS:
        undo = apply_mut()
        try:
            failures, rows = run_suite(quiet=True)
            flipped = sorted(
                t for t, _, r, _ in rows if r != "PASS" and t not in base_failed_ids
            )
        finally:
            undo()
            fx_sink.reset_sink()
        moved = failures > base_failures
        if not moved:
            bad.append(mid)
        print("{:<5} {:<44} {:<8} {:<8} {}".format(
            mid, desc, base_failures, failures, ", ".join(flipped) or "NONE — test is inert"))
    print("-" * 108)
    if bad:
        print("INERT MUTATIONS: {} — the tests guarding these do not work.".format(", ".join(bad)))
    else:
        print("All {} mutations moved the number. No inert tests.".format(len(MUTATIONS)))
    return 1 if bad else 0


def main():
    args = set(sys.argv[1:])
    rc = 0
    if "--controls" not in args or "--all" in args:
        failures, _ = run_suite()
        rc |= 1 if failures else 0
    if "--controls" in args or "--all" in args:
        rc |= run_controls()
    return rc


if __name__ == "__main__":
    sys.exit(main())
