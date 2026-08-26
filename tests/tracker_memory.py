"""Tracker — durable per-company memory (migration 023 + scout/memory).

Runs with ZERO infrastructure: stdlib only, no Docker, no psycopg, no
agno, no network. Local python 3.9.6 and container python 3.12.8 both.

    python3 tests/tracker_memory.py                    # the suite
    python3 tests/tracker_memory.py --negative-controls # prove it can fail

WHY SQLITE
----------
A scope test that runs against a hand-written query proves nothing about
the query production runs. So this harness loads the REAL DDL out of
db/migration_023_memory.sql and executes the REAL statement strings out
of scout/memory/sql.py against stdlib sqlite3, translating only
paramstyle and three type names. Delete `company_id = %s` from the scope
predicate and these tests go red, because the engine really does return
the other company's rows.

What this DOES prove: the WHERE clauses, the visibility rules, the
unique index, the FK cascade, the flag gate.
What it does NOT prove: that the DDL is valid PostgreSQL. Only applying
the migration proves that, and the lead applies it.

Fixture names are fictional.
"""

from __future__ import annotations

import os
import re
import sqlite3
import subprocess
import sys
import traceback
import types
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


def stub_scout_package():
    """Make `scout.memory` importable without booting the whole agent.

    ★ DEFECT (scout/__init__.py, not ours to fix): the package __init__ is

        from scout.agent import scout, scout_knowledge, scout_learnings

    so importing ANY submodule of `scout` executes scout/agent.py, which
    constructs the Agno agent, the model client, the DB handle and all 45
    tools at import time — and agno pulls `mcp`, which is not installed
    locally. `import scout.memory` therefore dies with
    "ImportError: `mcp` not installed" before reaching a line of our code.

    This registers a bare namespace module for `scout` pointing at the
    real directory, so `scout.memory.*` resolves to the REAL files on
    disk while __init__.py stays unexecuted. Nothing under scout/memory
    is stubbed.
    """
    if "scout" in sys.modules:
        return
    package = types.ModuleType("scout")
    package.__path__ = [str(REPO_ROOT / "scout")]
    sys.modules["scout"] = package


stub_scout_package()

MIGRATION = REPO_ROOT / "db" / "migration_023_memory.sql"
MIGRATION_SESSION = REPO_ROOT / "db" / "migration_026_session_company.sql"
MEMORY_PKG = REPO_ROOT / "scout" / "memory"

# The defect this process is running under, if any. Set by
# --negative-controls in the child processes it spawns.
BREAK = os.environ.get("TRACKER_MEMORY_BREAK", "")

# --- fictional fixtures -----------------------------------------------------
CO_GOLDEN = 101  # Golden Lotus Trading Company Limited
CO_EMERALD = 202  # Emerald Pagoda Holdings Limited
CO_SAFFRON = 303  # Saffron River Logistics Limited
CLERK = "thiri.aung@firm.example"
OTHER_CLERK = "kyaw.min.htet@firm.example"


# ===========================================================================
# sqlite harness — executes the real SQL
# ===========================================================================


def _pg_ddl_to_sqlite(ddl: str) -> str:
    """Translate the migration's PostgreSQL DDL for sqlite.

    Only three substitutions. If this list ever grows, the harness has
    started testing a different schema than the one that ships.
    """
    ddl = re.sub(r"\bBIGSERIAL PRIMARY KEY\b", "INTEGER PRIMARY KEY AUTOINCREMENT", ddl)
    ddl = re.sub(r"\bbtrim\(", "trim(", ddl)
    ddl = re.sub(r"\bDEFAULT TRUE\b", "DEFAULT 1", ddl)
    return ddl


def _pg_sql_to_sqlite(statement: str) -> str:
    """Translate a runtime statement: paramstyle, booleans, ILIKE.

    sqlite has no ILIKE; its LIKE is already case-insensitive for ASCII,
    which is the property the resolver relies on. ESCAPE clauses pass
    through unchanged — both engines support them, and that is the point
    of testing them here.
    """
    statement = re.sub(r"\bTRUE\b", "1", statement)
    statement = re.sub(r"\bFALSE\b", "0", statement)
    statement = re.sub(r"\bILIKE\b", "LIKE", statement)
    return statement.replace("%s", "?")


class _TranslatingCursor:
    """A cursor that speaks psycopg's paramstyle to a sqlite backend."""

    def __init__(self, cursor):
        self._cursor = cursor

    def execute(self, statement, params=None):
        return self._cursor.execute(_pg_sql_to_sqlite(statement), tuple(params or ()))

    def fetchone(self):
        return self._cursor.fetchone()

    def fetchall(self):
        return self._cursor.fetchall()

    @property
    def rowcount(self):
        return self._cursor.rowcount

    def close(self):
        self._cursor.close()


class _TranslatingConnection:
    def __init__(self, connection):
        self._connection = connection

    def cursor(self):
        return _TranslatingCursor(self._connection.cursor())

    def commit(self):
        self._connection.commit()

    def rollback(self):
        self._connection.rollback()

    def close(self):
        pass  # the fixture owns the lifetime; store.py closes what it opens


# ---------------------------------------------------------------------------
# A connection that behaves like PostgreSQL after a failed statement
# ---------------------------------------------------------------------------
# ★ sqlite does NOT poison a transaction on a constraint violation, so the
# plain harness above cannot express the failure the savepoints exist to
# prevent — with it, removing them changes nothing and the test is
# unfalsifiable. This wrapper models the three PostgreSQL behaviours that
# matter, and nothing else:
#
#   1. after any failed statement the transaction is ABORTED
#   2. every later statement raises InFailedSqlTransaction until a
#      ROLLBACK or ROLLBACK TO SAVEPOINT
#   3. COMMIT on an aborted transaction performs a ROLLBACK and REPORTS
#      SUCCESS — the green light that discards the caller's work
#
# This is a model of Postgres, not Postgres. It makes the savepoint
# load-bearing so the code can be falsified; only the live database proves
# the model is faithful.


class InFailedSqlTransaction(Exception):
    """Stand-in for psycopg.errors.InFailedSqlTransaction."""


class _AbortingCursor(_TranslatingCursor):
    def __init__(self, cursor, state):
        _TranslatingCursor.__init__(self, cursor)
        self._state = state

    def execute(self, statement, params=None):
        recovers = statement.strip().upper().startswith("ROLLBACK")
        if self._state["aborted"] and not recovers:
            raise InFailedSqlTransaction(
                "current transaction is aborted, commands ignored until end of transaction block"
            )
        try:
            result = _TranslatingCursor.execute(self, statement, params)
        except Exception:
            if not recovers:
                self._state["aborted"] = True
            raise
        if recovers:
            self._state["aborted"] = False
        return result


class _AbortingConnection(_TranslatingConnection):
    def __init__(self, connection):
        _TranslatingConnection.__init__(self, connection)
        self._state = {"aborted": False}

    @property
    def aborted(self):
        return self._state["aborted"]

    def cursor(self):
        return _AbortingCursor(self._connection.cursor(), self._state)

    def commit(self):
        if self._state["aborted"]:
            # ★ The behaviour that makes this dangerous: no exception, no
            # error return — the work is simply discarded.
            self._connection.rollback()
            self._state["aborted"] = False
            return
        self._connection.commit()

    def rollback(self):
        self._connection.rollback()
        self._state["aborted"] = False


#: The default fictional register. (id, name, registration number)
DEFAULT_COMPANIES = (
    (CO_GOLDEN, "Golden Lotus Trading Company Limited", "108234567"),
    (CO_EMERALD, "Emerald Pagoda Holdings Limited", "108765432"),
    (CO_SAFFRON, "Saffron River Logistics Limited", "109111222"),
)


def build_db(companies=DEFAULT_COMPANIES, aborting=False):
    """Fresh in-memory DB carrying BOTH real migrations' DDL.

    ``aborting=True`` returns a connection that models PostgreSQL's
    transaction-abort behaviour — see _AbortingConnection.
    """
    raw = sqlite3.connect(":memory:")
    raw.execute("PRAGMA foreign_keys = ON")
    raw.execute(
        "CREATE TABLE companies ("
        "  id INTEGER PRIMARY KEY,"
        "  company_name_english TEXT,"
        "  company_registration_number TEXT"
        ")"
    )
    for company_id, name, registration_number in companies:
        raw.execute(
            "INSERT INTO companies (id, company_name_english, company_registration_number) VALUES (?, ?, ?)",
            (company_id, name, registration_number),
        )
    for path in (MIGRATION, MIGRATION_SESSION):
        raw.executescript(_pg_ddl_to_sqlite(path.read_text(encoding="utf-8")))
    raw.commit()
    if aborting:
        return _AbortingConnection(raw)
    return _TranslatingConnection(raw)


class ExplodingFactory:
    """A connection factory that fails if anything tries to use it.

    This is how "the flag is off so no connection is opened" is proved:
    not by reading a boolean back, but by making the DB unreachable and
    watching the calls succeed anyway.
    """

    def __init__(self):
        self.calls = 0

    def __call__(self):
        self.calls += 1
        raise AssertionError("connection opened while the memory flag was OFF")


# ===========================================================================
# injected defects (negative controls)
# ===========================================================================


def apply_break(name):
    """Introduce one real defect, so the suite can be proved able to fail."""
    from scout.memory import flags, store
    from scout.memory import scope as scope_mod
    from scout.memory import sql as sql_mod

    if name == "scope_read":
        # Reads stop restricting to the company.
        sql_mod._SCOPE_WHERE = "(user_email IS NULL OR user_email = %s)"
        sql_mod._scope_params = lambda scope: [scope.user_email]

    elif name == "scope_write":
        # Writes stop restricting to the company.
        sql_mod._OWNER_WHERE = "COALESCE(user_email, '') = COALESCE(%s, '')"
        sql_mod._owner_params = lambda scope: [scope.user_email]

    elif name == "private_leak":
        # Company scope kept, per-user privacy dropped.
        sql_mod._SCOPE_WHERE = "company_id = %s AND (%s IS NOT NULL OR 1=1)"

    elif name == "flag_default_on":
        # The flag defaults ON instead of OFF.
        flags.memory_enabled = lambda: True
        store.memory_enabled = lambda: True

    elif name == "no_supersede":
        # Re-remembering inserts without retiring the old revision.
        sql_mod.select_owned_active = lambda scope, key: ("SELECT id, revision FROM company_memory WHERE 1=0", [])

    elif name == "scope_no_validate":
        # require_scope waves everything through.
        scope_mod.require_scope = lambda scope: scope
        store.require_scope = lambda scope: scope

    elif name == "ambiguous_collapses":
        # ★ THE defect this resolver exists to prevent: an ambiguous name
        # silently becomes a pick. This is precisely what
        # people_picker.py:123 does today — ILIKE ORDER BY LENGTH ASC LIMIT 1.
        from scout.memory import resolve as resolve_mod

        original = resolve_mod.resolve_company

        def collapsing(name_arg, conn=None):
            result = original(name_arg, conn=conn)
            if result.status == resolve_mod.AMBIGUOUS and result.candidates:
                best = min(result.candidates, key=lambda c: len(c["company_name"]))
                return resolve_mod.Resolution(
                    resolve_mod.RESOLVED,
                    company_id=best["company_id"],
                    company_name=best["company_name"],
                    registration_number=best["registration_number"],
                    match_kind="shortest_name",
                    query=result.query,
                )
            return result

        resolve_mod.resolve_company = collapsing

    elif name == "fuzzy_resolves":
        # Softer version: only a LONE substring match is auto-picked.
        from scout.memory import resolve as resolve_mod

        original = resolve_mod.resolve_company

        def lone_pick(name_arg, conn=None):
            result = original(name_arg, conn=conn)
            if result.status == resolve_mod.AMBIGUOUS and len(result.candidates) == 1:
                only = result.candidates[0]
                return resolve_mod.Resolution(
                    resolve_mod.RESOLVED,
                    company_id=only["company_id"],
                    company_name=only["company_name"],
                    registration_number=only["registration_number"],
                    match_kind="lone_substring",
                    query=result.query,
                )
            return result

        resolve_mod.resolve_company = lone_pick

    elif name == "like_unescaped":
        # LIKE metacharacters in the needle go through raw — the same class
        # of bug as the delete-by-ILIKE at app/main.py:5223.
        sql_mod.like_escape = lambda needle: str(needle or "")

    elif name == "no_savepoint":
        # Writes on a BORROWED connection stop isolating themselves, so a
        # failed memory write takes the caller's transaction with it.
        store._enter_savepoint = lambda conn, borrowed: None
        store._release_savepoint = lambda conn, borrowed: None
        store._rollback_savepoint = lambda conn, borrowed: None
        from scout.memory import resolve as resolve_mod

        resolve_mod._enter_savepoint = lambda conn, borrowed: None
        resolve_mod._release_savepoint = lambda conn, borrowed: None
        resolve_mod._rollback_savepoint = lambda conn, borrowed: None

    elif name == "binding_ignores_name":
        # A bound session ignores a name that resolves somewhere else.
        from scout.memory import resolve as resolve_mod

        resolve_mod.resolve_for_session = lambda session_id, name=None, conn=None: resolve_mod.session_binding(
            session_id, conn=conn
        )

    else:
        raise SystemExit(f"unknown break: {name}")


BREAKS = (
    "scope_read",
    "scope_write",
    "private_leak",
    "flag_default_on",
    "no_supersede",
    "scope_no_validate",
    "ambiguous_collapses",
    "fuzzy_resolves",
    "like_unescaped",
    "binding_ignores_name",
    "no_savepoint",
)


# ===========================================================================
# tiny runner
# ===========================================================================

PASSED = []
FAILED = []


def check(label, condition, detail=""):
    if condition:
        PASSED.append(label)
    else:
        FAILED.append((label, detail))


def case(fn):
    """Register a test function; exceptions inside count as failures."""

    def wrapped():
        try:
            fn()
        except Exception as exc:
            FAILED.append((fn.__name__, f"{type(exc).__name__}: {exc}"))
            if os.environ.get("TRACKER_MEMORY_TRACE"):
                traceback.print_exc()

    wrapped.__name__ = fn.__name__
    CASES.append(wrapped)
    return wrapped


CASES = []


# ===========================================================================
# flag gate — the product must be byte-identical with the flag off
# ===========================================================================


@case
def t01_flag_defaults_off():
    from scout.memory import flags

    os.environ.pop(flags.MEMORY_FLAG_ENV, None)
    check("t01 flag unset -> disabled", flags.memory_enabled() is False)


@case
def t02_flag_truthy_and_falsy_values():
    from scout.memory import flags

    for value in ("1", "true", "TRUE", "  Yes ", "on", "enabled"):
        os.environ[flags.MEMORY_FLAG_ENV] = value
        check(f"t02 {value!r} -> enabled", flags.memory_enabled() is True, f"got False for {value!r}")
    for value in ("0", "false", "off", "no", "", "maybe", "2"):
        os.environ[flags.MEMORY_FLAG_ENV] = value
        check(f"t02 {value!r} -> disabled", flags.memory_enabled() is False, f"got True for {value!r}")
    os.environ.pop(flags.MEMORY_FLAG_ENV, None)


@case
def t03_flag_off_opens_no_connection():
    """Every entry point, with the DB made unreachable."""
    from scout.memory import MemoryScope, flags, store

    os.environ.pop(flags.MEMORY_FLAG_ENV, None)
    exploding = ExplodingFactory()
    store.connection_factory.set_override(exploding)
    try:
        scope = MemoryScope(CO_GOLDEN, CLERK)
        result = store.remember(scope, "financial year end", "31 March")
        check("t03 remember disabled", result["stored"] is False and result["disabled"] is True, str(result))
        check("t03 recall empty", store.recall(scope) == [])
        check("t03 count zero", store.count(scope) == 0)
        check("t03 forget zero", store.forget(scope, "financial year end") == 0)
        check("t03 history empty", store.history(scope, "financial year end") == [])
        check("t03 prompt block empty", store.render_for_prompt(scope) == "")
        check("t03 no connection attempted", exploding.calls == 0, f"factory called {exploding.calls}x")
    finally:
        store.connection_factory.clear_override()


@case
def t04_flag_off_prompt_is_byte_identical():
    """render_for_prompt contributes exactly zero bytes while off."""
    from scout.memory import MemoryScope, flags, store

    conn = build_db()
    os.environ[flags.MEMORY_FLAG_ENV] = "1"
    scope = MemoryScope(CO_GOLDEN, CLERK)
    store.remember(scope, "financial year end", "31 March", category="convention", conn=conn)
    conn.commit()
    on_block = store.render_for_prompt(scope, conn=conn)
    os.environ.pop(flags.MEMORY_FLAG_ENV, None)
    off_block = store.render_for_prompt(scope, conn=conn)
    check("t04 flag on renders content", len(on_block) > 0, f"len={len(on_block)}")
    check("t04 flag off renders zero bytes", off_block == "", repr(off_block[:80]))


# ===========================================================================
# scope — the security-relevant part. Every one asserts a NUMBER MOVED.
# ===========================================================================


def _enabled_scope_db():
    from scout.memory import flags

    os.environ[flags.MEMORY_FLAG_ENV] = "1"
    return build_db()


@case
def t05_write_under_a_is_invisible_to_b():
    from scout.memory import MemoryScope, store

    conn = _enabled_scope_db()
    golden = MemoryScope(CO_GOLDEN, CLERK)
    emerald = MemoryScope(CO_EMERALD, CLERK)

    for key, value in (
        ("financial year end", "31 March"),
        ("filing naming convention", "GLT-<form>-<yyyymmdd>"),
        ("director transliteration", "Daw Thiri Aung, never 'Daw Thiri Oung'"),
    ):
        store.remember(golden, key, value, category="convention", conn=conn)
    conn.commit()

    golden_count = store.count(golden, conn=conn)
    emerald_count = store.count(emerald, conn=conn)
    check("t05 company A sees 3", golden_count == 3, f"got {golden_count}")
    check("t05 company B sees 0", emerald_count == 0, f"got {emerald_count}")
    check("t05 A recall non-empty", len(store.recall(golden, conn=conn)) == 3)
    check("t05 B recall empty", len(store.recall(emerald, conn=conn)) == 0)


@case
def t06_same_key_different_companies_do_not_collide():
    """Both companies remember 'financial year end' — each reads its own."""
    from scout.memory import MemoryScope, store

    conn = _enabled_scope_db()
    golden = MemoryScope(CO_GOLDEN, CLERK)
    emerald = MemoryScope(CO_EMERALD, CLERK)

    store.remember(golden, "financial year end", "31 March", conn=conn)
    store.remember(emerald, "financial year end", "30 September", conn=conn)
    conn.commit()

    golden_rows = store.recall(golden, key="financial year end", conn=conn)
    emerald_rows = store.recall(emerald, key="financial year end", conn=conn)
    check("t06 A has exactly 1", len(golden_rows) == 1, f"got {len(golden_rows)}")
    check("t06 B has exactly 1", len(emerald_rows) == 1, f"got {len(emerald_rows)}")
    check("t06 A value correct", golden_rows[0]["memory_value"] == "31 March", str(golden_rows))
    check("t06 B value correct", emerald_rows[0]["memory_value"] == "30 September", str(emerald_rows))
    check("t06 A row carries A's company_id", golden_rows[0]["company_id"] == CO_GOLDEN)
    check("t06 B row carries B's company_id", emerald_rows[0]["company_id"] == CO_EMERALD)


@case
def t07_private_rows_do_not_cross_users():
    from scout.memory import MemoryScope, store

    conn = _enabled_scope_db()
    mine = MemoryScope(CO_GOLDEN, CLERK)
    theirs = MemoryScope(CO_GOLDEN, OTHER_CLERK)
    shared = MemoryScope(CO_GOLDEN, None)

    store.remember(mine, "draft shorthand", "use AGM-short for this client", category="preference", conn=conn)
    store.remember(shared, "financial year end", "31 March", category="convention", conn=conn)
    conn.commit()

    mine_count = store.count(mine, conn=conn)
    theirs_count = store.count(theirs, conn=conn)
    check("t07 author sees shared + own = 2", mine_count == 2, f"got {mine_count}")
    check("t07 colleague sees shared only = 1", theirs_count == 1, f"got {theirs_count}")
    theirs_keys = [r["memory_key"] for r in store.recall(theirs, conn=conn)]
    check("t07 colleague cannot see the private key", "draft shorthand" not in theirs_keys, str(theirs_keys))


@case
def t08_history_is_scoped():
    from scout.memory import MemoryScope, store

    conn = _enabled_scope_db()
    golden = MemoryScope(CO_GOLDEN, CLERK)
    emerald = MemoryScope(CO_EMERALD, CLERK)
    store.remember(golden, "auditor", "Shwe Pyi Audit Services", conn=conn)
    conn.commit()
    check("t08 A history has 1", len(store.history(golden, "auditor", conn=conn)) == 1)
    check("t08 B history has 0", len(store.history(emerald, "auditor", conn=conn)) == 0)


@case
def t09_forget_cannot_reach_another_company():
    from scout.memory import MemoryScope, store

    conn = _enabled_scope_db()
    golden = MemoryScope(CO_GOLDEN, CLERK)
    emerald = MemoryScope(CO_EMERALD, CLERK)
    store.remember(golden, "auditor", "Shwe Pyi Audit Services", conn=conn)
    conn.commit()

    retired = store.forget(emerald, "auditor", conn=conn)
    conn.commit()
    check("t09 forget as B retires nothing", retired == 0, f"got {retired}")
    check("t09 A's memory still live", store.count(golden, conn=conn) == 1)

    retired = store.forget(golden, "auditor", conn=conn)
    conn.commit()
    check("t09 forget as A retires 1", retired == 1, f"got {retired}")
    check("t09 A count drops to 0", store.count(golden, conn=conn) == 0)


@case
def t10_remember_cannot_overwrite_another_company():
    """A write under B must never touch A's row for the same key."""
    from scout.memory import MemoryScope, store

    conn = _enabled_scope_db()
    golden = MemoryScope(CO_GOLDEN, CLERK)
    emerald = MemoryScope(CO_EMERALD, CLERK)
    store.remember(golden, "registered office", "No. 12, Pyay Road, Yangon", conn=conn)
    conn.commit()
    store.remember(emerald, "registered office", "No. 88, Strand Road, Yangon", conn=conn)
    conn.commit()

    golden_rows = store.recall(golden, key="registered office", conn=conn)
    check("t10 A value untouched", golden_rows[0]["memory_value"] == "No. 12, Pyay Road, Yangon", str(golden_rows))
    check("t10 A still at revision 1", golden_rows[0]["revision"] == 1, str(golden_rows))
    check("t10 A history still length 1", len(store.history(golden, "registered office", conn=conn)) == 1)


@case
def t11_deleting_the_company_takes_its_memories():
    """The scope key is a real FK, not a loose integer."""
    from scout.memory import MemoryScope, store

    conn = _enabled_scope_db()
    golden = MemoryScope(CO_GOLDEN, CLERK)
    store.remember(golden, "financial year end", "31 March", conn=conn)
    conn.commit()
    before = store.count(golden, conn=conn)

    cur = conn.cursor()
    cur.execute("DELETE FROM companies WHERE id = %s", [CO_GOLDEN])
    cur.close()
    conn.commit()

    after = store.count(golden, conn=conn)
    check("t11 before delete = 1", before == 1, f"got {before}")
    check("t11 after delete = 0 (cascade)", after == 0, f"got {after}")


@case
def t12_memory_for_unknown_company_is_refused():
    """No FK row -> the write fails rather than filing an orphan."""
    from scout.memory import MemoryScope, store

    conn = _enabled_scope_db()
    orphan = MemoryScope(999999, CLERK)
    result = store.remember(orphan, "financial year end", "31 March", conn=conn)
    check("t12 orphan write refused", result["stored"] is False, str(result))


# ===========================================================================
# revisions + provenance
# ===========================================================================


@case
def t13_reremember_supersedes_and_bumps_revision():
    from scout.memory import MemoryScope, store

    conn = _enabled_scope_db()
    golden = MemoryScope(CO_GOLDEN, CLERK)
    store.remember(golden, "auditor", "Shwe Pyi Audit Services", conn=conn)
    conn.commit()
    result = store.remember(golden, "auditor", "Ayeyar Audit Group", author_email=OTHER_CLERK, conn=conn)
    conn.commit()

    check("t13 second write reports revision 2", result["revision"] == 2, str(result))
    check("t13 second write reports superseded", result["superseded"] is True, str(result))
    check("t13 still exactly 1 live row", store.count(golden, conn=conn) == 1)

    live = store.recall(golden, key="auditor", conn=conn)
    check("t13 live value is the new one", live[0]["memory_value"] == "Ayeyar Audit Group", str(live))

    trail = store.history(golden, "auditor", conn=conn)
    check("t13 history keeps both revisions", len(trail) == 2, f"got {len(trail)}")
    check("t13 history is oldest first", trail[0]["revision"] == 1 and trail[1]["revision"] == 2, str(trail))
    check("t13 old row marked inactive", not trail[0]["active"], str(trail[0]))
    check("t13 old row records who superseded it", trail[0]["superseded_by_email"] == OTHER_CLERK, str(trail[0]))
    check("t13 old row records when", trail[0]["superseded_at"] is not None, str(trail[0]))


@case
def t14_provenance_columns_are_recorded():
    from scout.memory import MemoryScope, store

    conn = _enabled_scope_db()
    golden = MemoryScope(CO_GOLDEN, CLERK)
    store.remember(
        golden,
        "filing naming convention",
        "GLT-<form>-<yyyymmdd>",
        category="convention",
        confidence=0.9,
        source="chat",
        session_id="sess-abc",
        run_id="run-xyz",
        conn=conn,
    )
    conn.commit()
    row = store.recall(golden, key="filing naming convention", conn=conn)[0]
    check("t14 source", row["source"] == "chat", str(row))
    check("t14 session id", row["source_session_id"] == "sess-abc", str(row))
    check("t14 run id", row["source_run_id"] == "run-xyz", str(row))
    check("t14 author defaults to scope user", row["created_by_email"] == CLERK, str(row))
    check("t14 confidence", abs((row["confidence"] or 0) - 0.9) < 1e-6, str(row))
    check("t14 category", row["category"] == "convention", str(row))


@case
def t15_forget_is_soft_and_keeps_the_trail():
    from scout.memory import MemoryScope, store

    conn = _enabled_scope_db()
    golden = MemoryScope(CO_GOLDEN, CLERK)
    store.remember(golden, "auditor", "Shwe Pyi Audit Services", conn=conn)
    conn.commit()
    store.forget(golden, "auditor", conn=conn)
    conn.commit()
    check("t15 no longer live", store.count(golden, conn=conn) == 0)
    check("t15 trail survives", len(store.history(golden, "auditor", conn=conn)) == 1)


@case
def t16_unique_index_forbids_two_live_rows():
    """Belt to the supersede braces: the DB refuses a duplicate live key."""
    from scout.memory import MemoryScope, store
    from scout.memory import sql as sql_mod

    conn = _enabled_scope_db()
    golden = MemoryScope(CO_GOLDEN, CLERK)
    store.remember(golden, "auditor", "Shwe Pyi Audit Services", conn=conn)
    conn.commit()

    # Bypass remember() and insert a second live row directly.
    statement, params = sql_mod.insert(golden, "auditor", "Duplicate", "fact", None, 1, "chat", None, None, CLERK)
    duplicated = False
    try:
        cur = conn.cursor()
        cur.execute(statement, params)
        cur.close()
        conn.commit()
        duplicated = True
    except Exception:
        conn.rollback()
    check(
        "t16 duplicate live row rejected",
        duplicated is False,
        "a second active row for the same (company, owner, key) was accepted",
    )
    check("t16 still 1 live row", store.count(golden, conn=conn) == 1)


# ===========================================================================
# validation — the scope cannot be omitted or faked
# ===========================================================================


@case
def t17_bad_company_ids_are_refused():
    from scout.memory import MemoryScope, MemoryScopeError

    for bad in (None, 0, -1, "abc", "", True, False, 1.5, [], {}):
        raised = False
        try:
            MemoryScope(bad, CLERK)
        except MemoryScopeError:
            raised = True
        except Exception:
            raised = False
        check(f"t17 company_id {bad!r} refused", raised, f"MemoryScope({bad!r}) was accepted")


@case
def t18_scope_must_be_a_scope():
    from scout.memory import MemoryScopeError, flags, store

    os.environ[flags.MEMORY_FLAG_ENV] = "1"
    conn = build_db()
    for bad in (CO_GOLDEN, "101", None, {"company_id": CO_GOLDEN}):
        raised = False
        try:
            store.recall(bad, conn=conn)
        except MemoryScopeError:
            raised = True
        except Exception:
            raised = False
        check(f"t18 recall({bad!r}) refused", raised, f"a bare {type(bad).__name__} was accepted as a scope")


@case
def t19_numeric_string_company_id_is_accepted_and_coerced():
    from scout.memory import MemoryScope

    scope = MemoryScope("101", CLERK)
    check("t19 '101' coerces to int 101", scope.company_id == 101 and isinstance(scope.company_id, int))


@case
def t20_key_and_value_validation():
    from scout.memory import MemoryScope, MemoryScopeError, flags, store

    os.environ[flags.MEMORY_FLAG_ENV] = "1"
    conn = build_db()
    scope = MemoryScope(CO_GOLDEN, CLERK)

    for bad_key in ("", "   ", None, 123):
        raised = False
        try:
            store.remember(scope, bad_key, "value", conn=conn)
        except MemoryScopeError:
            raised = True
        except Exception:
            raised = False
        check(f"t20 key {bad_key!r} refused", raised)

    for bad_value in ("", "   ", None):
        raised = False
        try:
            store.remember(scope, "key", bad_value, conn=conn)
        except MemoryScopeError:
            raised = True
        except Exception:
            raised = False
        check(f"t20 value {bad_value!r} refused", raised)

    raised = False
    try:
        store.remember(scope, "key", "value", category="gossip", conn=conn)
    except MemoryScopeError:
        raised = True
    check("t20 bad category refused", raised)

    raised = False
    try:
        store.remember(scope, "key", "value", confidence=1.7, conn=conn)
    except MemoryScopeError:
        raised = True
    check("t20 confidence>1 refused", raised)


@case
def t21_keys_are_normalised():
    from scout.memory import MemoryScope, store

    conn = _enabled_scope_db()
    scope = MemoryScope(CO_GOLDEN, CLERK)
    store.remember(scope, "Financial   Year  End", "31 March", conn=conn)
    conn.commit()
    store.remember(scope, "  financial year end  ", "31 March (confirmed)", conn=conn)
    conn.commit()
    check(
        "t21 case+space variants are one key",
        store.count(scope, conn=conn) == 1,
        f"got {store.count(scope, conn=conn)}",
    )
    rows = store.recall(scope, key="FINANCIAL YEAR END", conn=conn)
    check("t21 lookup is case-insensitive", len(rows) == 1, f"got {len(rows)}")
    check("t21 stored key is normalised", rows[0]["memory_key"] == "financial year end", str(rows))


@case
def t22_oversized_value_is_truncated_not_rejected():
    from scout.memory import MemoryScope, store

    conn = _enabled_scope_db()
    scope = MemoryScope(CO_GOLDEN, CLERK)
    store.remember(scope, "long note", "x" * 9000, conn=conn)
    conn.commit()
    row = store.recall(scope, key="long note", conn=conn)[0]
    check(
        "t22 truncated to the cap", len(row["memory_value"]) == store.MAX_VALUE_CHARS, f"got {len(row['memory_value'])}"
    )


# ===========================================================================
# SQL shape — no statement can ship without the scope predicate
# ===========================================================================


@case
def t23_every_builder_carries_company_id():
    from scout.memory import MemoryScope
    from scout.memory import sql as sql_mod

    scope = MemoryScope(CO_GOLDEN, CLERK)
    built = {
        "select_active": sql_mod.select_active(scope),
        "select_history": sql_mod.select_history(scope, "k"),
        "select_owned_active": sql_mod.select_owned_active(scope, "k"),
        "supersede": sql_mod.supersede(scope, "k", CLERK),
        "insert": sql_mod.insert(scope, "k", "v", "fact", None, 1, "chat", None, None, CLERK),
        "count_active": sql_mod.count_active(scope),
    }
    check(
        "t23 every builder is covered",
        set(built) == set(sql_mod.ALL_BUILDERS),
        f"builders={sorted(sql_mod.ALL_BUILDERS)} covered={sorted(built)}",
    )
    for name, (statement, params) in built.items():
        check(f"t23 {name} names company_id", "company_id" in statement, statement[:120])
        check(f"t23 {name} binds the company id", CO_GOLDEN in list(params), f"params={params}")
    for name in ("select_active", "select_history", "count_active"):
        statement = built[name][0]
        check(f"t23 {name} equality-filters company_id", "company_id = %s" in statement, statement[:160])
    for name in ("select_owned_active", "supersede"):
        statement = built[name][0]
        check(f"t23 {name} equality-filters company_id", "company_id = %s" in statement, statement[:160])
    check(
        "t23 insert supplies company_id as a column",
        "company_id" in built["insert"][0].split("VALUES")[0],
        built["insert"][0][:160],
    )


@case
def t24_read_columns_match_the_select():
    from scout.memory import MemoryScope
    from scout.memory import sql as sql_mod

    statement, _ = sql_mod.select_active(MemoryScope(CO_GOLDEN, CLERK))
    selected = statement.split(" FROM ")[0].replace("SELECT ", "").split(", ")
    check(
        "t24 SELECT list == READ_COLUMNS",
        tuple(selected) == sql_mod.READ_COLUMNS,
        f"select={selected} constant={list(sql_mod.READ_COLUMNS)}",
    )


# ===========================================================================
# migration file rules
# ===========================================================================


@case
def t25_migration_file_rules():
    text = MIGRATION.read_text(encoding="utf-8")
    code = "\n".join(line for line in text.splitlines() if not line.strip().startswith("--"))

    check("t25 file exists", MIGRATION.exists())
    check("t25 table is IF NOT EXISTS", "CREATE TABLE IF NOT EXISTS company_memory" in code)
    index_count = code.count("CREATE INDEX IF NOT EXISTS") + code.count("CREATE UNIQUE INDEX IF NOT EXISTS")
    total_indexes = len(re.findall(r"CREATE (?:UNIQUE )?INDEX", code))
    check(
        "t25 every index is IF NOT EXISTS",
        index_count == total_indexes and total_indexes == 4,
        f"guarded={index_count} total={total_indexes}",
    )
    check("t25 no %s placeholders", "%s" not in code, "migrate.py executes this as raw DDL")
    check(
        "t25 does not touch schema_migrations",
        "schema_migrations" not in code,
        "the runner inserts the row; a second insert violates the unique constraint",
    )
    check("t25 company_id is NOT NULL", "company_id          INTEGER NOT NULL" in code, code[:0])
    check("t25 company_id is a FK to companies", "REFERENCES companies(id) ON DELETE CASCADE" in code)
    check(
        "t25 no DML",
        not re.search(r"^\s*(INSERT|UPDATE|DELETE)\b", code, re.MULTILINE | re.IGNORECASE),
        "pure DDL only",
    )

    # reversing DROPs present, and commented out
    for statement in ("DROP TABLE IF EXISTS company_memory", "DROP INDEX IF EXISTS uq_company_memory_active_key"):
        check(f"t25 reversing '{statement[:24]}...' documented", statement in text)
        check(f"t25 reversing '{statement[:24]}...' is commented", statement not in code)


@case
def t26_migration_number_is_free_and_ordered():
    db_dir = REPO_ROOT / "db"
    names = sorted(p.name for p in db_dir.glob("migration_*.sql"))
    same_number = [n for n in names if n.startswith("migration_023")]
    check("t26 exactly one migration_023", len(same_number) == 1, str(same_number))
    check(
        "t26 sorts before 025",
        "migration_023_memory.sql" in names
        and names.index("migration_023_memory.sql") < names.index("migration_025_people_cessation.sql"),
        str(names),
    )


# ===========================================================================
# import hygiene
# ===========================================================================


@case
def t27_package_imports_no_heavy_dependency():
    """Importing scout.memory must not need psycopg, agno or mcp.

    Uses the same namespace stub as the suite, for the reason documented
    on stub_scout_package(): scout/__init__.py boots the agent. What this
    proves is that OUR package adds no heavy import of its own — the
    parent __init__ is a separate, reported defect.
    """
    script = (
        "import sys, types\n"
        "sys.path.insert(0, {!r})\n"
        "pkg = types.ModuleType('scout'); pkg.__path__ = [{!r}]\n"
        "sys.modules['scout'] = pkg\n"
        "import scout.memory\n"
        "banned = [m for m in ('psycopg','agno','mcp','openai','docx') if m in sys.modules]\n"
        "print(','.join(banned))\n".format(str(REPO_ROOT), str(REPO_ROOT / "scout"))
    )
    proc = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True)
    check("t27 import succeeds", proc.returncode == 0, proc.stderr[-400:])
    check("t27 no heavy modules loaded", proc.stdout.strip() == "", f"loaded: {proc.stdout.strip()}")


@case
def t28_future_annotations_everywhere():
    """Local python is 3.9.6; `X | None` needs the future import."""
    modules = [*sorted(MEMORY_PKG.glob("*.py")), Path(__file__)]
    for path in modules:
        head = path.read_text(encoding="utf-8")[:1500]
        check(f"t28 {path.name} has future annotations", "from __future__ import annotations" in head, str(path))


@case
def t29_no_module_level_db_import():
    """store.py must not import db.connection at module scope."""
    source = (MEMORY_PKG / "store.py").read_text(encoding="utf-8")
    module_level = [
        line for line in source.splitlines() if re.match(r"^(import|from)\s", line) and "db.connection" in line
    ]
    check("t29 db.connection is imported lazily", module_level == [], str(module_level))
    check("t29 the lazy import exists", "from db.connection import get_db_conn" in source)


# ===========================================================================
# strict company resolution (migration 026 + scout/memory/resolve.py)
# ===========================================================================

# Two companies sharing a prefix — the shape every existing resolver in the
# tree gets wrong. Fictional.
CO_GL_TRADING = 401
CO_GL_HOLDINGS = 402
PREFIX_REGISTER = (
    (CO_GL_TRADING, "Golden Lotus Trading Company Limited", "108234567"),
    (CO_GL_HOLDINGS, "Golden Lotus Holdings Limited", "108999888"),
)


def _enabled_db(companies=DEFAULT_COMPANIES, aborting=False):
    from scout.memory import flags

    os.environ[flags.MEMORY_FLAG_ENV] = "1"
    return build_db(companies, aborting=aborting)


@case
def t30_exact_name_resolves():
    from scout.memory import resolve as r

    conn = _enabled_db()
    result = r.resolve_company("Golden Lotus Trading Company Limited", conn=conn)
    check("t30 status RESOLVED", result.status == r.RESOLVED, str(result))
    check("t30 correct id", result.company_id == CO_GOLDEN, str(result))
    check("t30 match kind", result.match_kind == r.BY_EXACT_NAME, str(result))
    check("t30 is_resolved", result.is_resolved is True)


@case
def t31_exact_name_is_case_and_space_insensitive():
    from scout.memory import resolve as r

    conn = _enabled_db()
    for variant in (
        "golden lotus trading company limited",
        "  GOLDEN LOTUS TRADING COMPANY LIMITED  ",
        "Golden  Lotus   Trading Company Limited",
    ):
        result = r.resolve_company(variant, conn=conn)
        check(
            f"t31 {variant.strip()[:22]!r} resolves", result.is_resolved and result.company_id == CO_GOLDEN, str(result)
        )


@case
def t32_registration_number_resolves():
    from scout.memory import resolve as r

    conn = _enabled_db()
    result = r.resolve_company("108765432", conn=conn)
    check("t32 status RESOLVED", result.status == r.RESOLVED, str(result))
    check("t32 correct id", result.company_id == CO_EMERALD, str(result))
    check("t32 match kind", result.match_kind == r.BY_REGISTRATION, str(result))


@case
def t33_ambiguous_must_not_collapse_to_a_pick():
    """★ The one the whole resolver exists for.

    Two companies share the prefix "Golden Lotus". Resolving the short form
    must hand back BOTH, not pick the shorter name — which is exactly what
    people_picker.py:123 does today (ILIKE ORDER BY LENGTH ASC LIMIT 1).
    """
    from scout.memory import resolve as r

    conn = _enabled_db(PREFIX_REGISTER)
    result = r.resolve_company("Golden Lotus", conn=conn)

    check("t33 status is AMBIGUOUS", result.status == r.AMBIGUOUS, str(result))
    check("t33 company_id is NOT set", result.company_id is None, str(result))
    check("t33 is_resolved is False", result.is_resolved is False, str(result))
    check("t33 exactly 2 candidates", len(result.candidates) == 2, f"got {len(result.candidates)}: {result.candidates}")
    ids = {c["company_id"] for c in result.candidates}
    check("t33 both companies offered", ids == {CO_GL_TRADING, CO_GL_HOLDINGS}, str(ids))
    # The shorter name is the one a LENGTH-ordered resolver would have picked.
    check("t33 shorter name did not win silently", result.company_id != CO_GL_HOLDINGS, str(result))


@case
def t34_a_lone_substring_match_still_does_not_resolve():
    """One candidate is a CONFIRMATION, not a resolution.

    A name that merely contains the query is not the same claim as a name
    that equals it — and a second company added tomorrow turns that lone
    match into a wrong one already written down.
    """
    from scout.memory import resolve as r

    conn = _enabled_db()
    result = r.resolve_company("Saffron River", conn=conn)
    check("t34 status is AMBIGUOUS", result.status == r.AMBIGUOUS, str(result))
    check("t34 company_id is NOT set", result.company_id is None, str(result))
    check("t34 the single candidate is offered", len(result.candidates) == 1, str(result))
    check("t34 candidate is the right company", result.candidates[0]["company_id"] == CO_SAFFRON, str(result))


@case
def t35_no_match_is_none():
    from scout.memory import resolve as r

    conn = _enabled_db()
    result = r.resolve_company("Nonexistent Trading Limited", conn=conn)
    check("t35 status NONE", result.status == r.NONE, str(result))
    check("t35 no candidates", result.candidates == [], str(result))
    check("t35 no id", result.company_id is None, str(result))


@case
def t36_like_metacharacters_are_escaped():
    """The app/main.py:5223 lesson, applied to the resolver.

    `_` matches any single character in LIKE. Unescaped, a query for
    "GOLDEN_LOTUS" matches "GOLDEN LOTUS", and "%" matches everything.
    """
    from scout.memory import resolve as r

    register = (
        (501, "GOLDEN LOTUS TRADING LIMITED", "111000111"),
        (502, "GOLDEN_LOTUS TRADING LIMITED", "111000222"),
        (503, "Sapphire Delta Limited", "111000333"),
    )
    conn = _enabled_db(register)

    # Exact match must find the underscore company only.
    exact = r.resolve_company("GOLDEN_LOTUS TRADING LIMITED", conn=conn)
    check("t36 underscore name resolves exactly", exact.is_resolved and exact.company_id == 502, str(exact))

    # A substring query containing `_` must not pull in the space sibling.
    partial = r.resolve_company("GOLDEN_LOTUS", conn=conn)
    ids = {c["company_id"] for c in partial.candidates}
    check("t36 underscore does not match a space", ids == {502}, f"got {ids} — the escape is missing")

    # A bare '%' must not return the whole register.
    wildcard = r.resolve_company("%", conn=conn)
    check(
        "t36 '%' does not match everything",
        len(wildcard.candidates) == 0,
        f"got {len(wildcard.candidates)} candidates for a bare wildcard",
    )


@case
def t37_two_rows_differing_only_by_case_are_ambiguous():
    from scout.memory import resolve as r

    register = (
        (601, "Jade Harbour Limited", "222000111"),
        (602, "JADE HARBOUR LIMITED", "222000222"),
    )
    conn = _enabled_db(register)
    result = r.resolve_company("Jade Harbour Limited", conn=conn)
    check("t37 status AMBIGUOUS", result.status == r.AMBIGUOUS, str(result))
    check("t37 both offered", len(result.candidates) == 2, str(result))
    check("t37 no silent pick", result.company_id is None, str(result))


@case
def t38_name_with_a_digit_is_not_probed_as_a_registration_number():
    from scout.memory import resolve as r

    register = ((701, "Lotus 2 Trading Limited", "333000111"),)
    conn = _enabled_db(register)
    result = r.resolve_company("Lotus 2 Trading Limited", conn=conn)
    check("t38 resolves by name", result.is_resolved and result.company_id == 701, str(result))
    check("t38 match kind is name", result.match_kind == r.BY_EXACT_NAME, str(result))


@case
def t39_resolver_is_flag_gated():
    from scout.memory import flags, store
    from scout.memory import resolve as r

    os.environ.pop(flags.MEMORY_FLAG_ENV, None)
    exploding = ExplodingFactory()
    store.connection_factory.set_override(exploding)
    try:
        check("t39 resolve NONE", r.resolve_company("Golden Lotus Trading Company Limited").status == r.NONE)
        check("t39 binding NONE", r.session_binding("sess-1").status == r.NONE)
        check("t39 for_session NONE", r.resolve_for_session("sess-1", "Golden Lotus").status == r.NONE)
        check("t39 bind is a no-op", r.bind_session("sess-1", CO_GOLDEN) is False)
        check("t39 unbind is a no-op", r.unbind_session("sess-1") == 0)
        check("t39 no connection attempted", exploding.calls == 0, f"factory called {exploding.calls}x")
    finally:
        store.connection_factory.clear_override()


# --- session binding -------------------------------------------------------


@case
def t40_bind_and_read_back():
    from scout.memory import resolve as r

    conn = _enabled_db()
    ok = r.bind_session("sess-alpha", CO_GOLDEN, bound_by=CLERK, conn=conn)
    conn.commit()
    check("t40 bind succeeded", ok is True)
    bound = r.session_binding("sess-alpha", conn=conn)
    check("t40 reads back RESOLVED", bound.status == r.RESOLVED, str(bound))
    check("t40 correct company", bound.company_id == CO_GOLDEN, str(bound))
    check("t40 match kind", bound.match_kind == r.BY_SESSION, str(bound))
    check("t40 carries the name", bound.company_name == "Golden Lotus Trading Company Limited", str(bound))


@case
def t41_unbound_session_reads_none():
    from scout.memory import resolve as r

    conn = _enabled_db()
    check("t41 no binding", r.session_binding("sess-never-bound", conn=conn).status == r.NONE)
    check("t41 blank session id", r.session_binding("", conn=conn).status == r.NONE)


@case
def t42_for_session_without_a_name_uses_the_binding():
    """The whole point: "remember their year end is 31 March" needs no name."""
    from scout.memory import resolve as r

    conn = _enabled_db()
    r.bind_session("sess-alpha", CO_EMERALD, bound_by=CLERK, conn=conn)
    conn.commit()
    result = r.resolve_for_session("sess-alpha", conn=conn)
    check("t42 resolves from the binding", result.is_resolved, str(result))
    check("t42 correct company", result.company_id == CO_EMERALD, str(result))


@case
def t43_a_name_resolving_elsewhere_beats_the_binding():
    """The user changed subject. The binding must not win."""
    from scout.memory import resolve as r

    conn = _enabled_db()
    r.bind_session("sess-alpha", CO_EMERALD, bound_by=CLERK, conn=conn)
    conn.commit()
    result = r.resolve_for_session("sess-alpha", "Saffron River Logistics Limited", conn=conn)
    check("t43 resolves to the NAMED company", result.company_id == CO_SAFFRON, str(result))
    check("t43 not the bound one", result.company_id != CO_EMERALD, str(result))


@case
def t44_ambiguous_name_including_the_bound_company_uses_the_binding():
    from scout.memory import resolve as r

    conn = _enabled_db(PREFIX_REGISTER)
    r.bind_session("sess-alpha", CO_GL_TRADING, bound_by=CLERK, conn=conn)
    conn.commit()
    result = r.resolve_for_session("sess-alpha", "Golden Lotus", conn=conn)
    check("t44 short form uses the binding", result.is_resolved, str(result))
    check("t44 correct company", result.company_id == CO_GL_TRADING, str(result))
    check("t44 via the binding", result.match_kind == r.BY_SESSION, str(result))


@case
def t45_ambiguous_name_excluding_the_bound_company_stays_ambiguous():
    """★ A mention of a DIFFERENT company must never fall back to the binding.

    Otherwise "what about Jade Harbour" while bound to Golden Lotus writes
    Jade Harbour's fact onto Golden Lotus — silently, with a perfect audit
    trail.
    """
    from scout.memory import resolve as r

    register = (
        *PREFIX_REGISTER,
        (403, "Jade Harbour Trading Limited", "444000111"),
        (404, "Jade Harbour Holdings Limited", "444000222"),
    )
    conn = _enabled_db(register)
    r.bind_session("sess-alpha", CO_GL_TRADING, bound_by=CLERK, conn=conn)
    conn.commit()
    result = r.resolve_for_session("sess-alpha", "Jade Harbour", conn=conn)
    check("t45 stays AMBIGUOUS", result.status == r.AMBIGUOUS, str(result))
    check("t45 does NOT fall back to the binding", result.company_id != CO_GL_TRADING, str(result))
    check("t45 no id at all", result.company_id is None, str(result))
    ids = {c["company_id"] for c in result.candidates}
    check("t45 offers the Jade Harbour pair", ids == {403, 404}, str(ids))


@case
def t46_rebinding_replaces():
    from scout.memory import resolve as r

    conn = _enabled_db()
    r.bind_session("sess-alpha", CO_GOLDEN, bound_by=CLERK, conn=conn)
    conn.commit()
    r.bind_session("sess-alpha", CO_SAFFRON, bound_by=OTHER_CLERK, conn=conn)
    conn.commit()
    bound = r.session_binding("sess-alpha", conn=conn)
    check("t46 now the new company", bound.company_id == CO_SAFFRON, str(bound))
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM session_company WHERE session_id = %s", ["sess-alpha"])
    rows = cur.fetchone()[0]
    cur.close()
    check("t46 still exactly one row", rows == 1, f"got {rows}")


@case
def t47_unbind_removes():
    from scout.memory import resolve as r

    conn = _enabled_db()
    r.bind_session("sess-alpha", CO_GOLDEN, conn=conn)
    conn.commit()
    removed = r.unbind_session("sess-alpha", conn=conn)
    conn.commit()
    check("t47 removed 1", removed == 1, f"got {removed}")
    check("t47 gone", r.session_binding("sess-alpha", conn=conn).status == r.NONE)
    check("t47 second unbind removes 0", r.unbind_session("sess-alpha", conn=conn) == 0)


@case
def t48_binding_to_an_unknown_company_is_refused():
    from scout.memory import resolve as r

    conn = _enabled_db()
    ok = r.bind_session("sess-alpha", 999999, conn=conn)
    check("t48 FK refuses the bind", ok is False, "an orphan binding was accepted")


@case
def t49_deleting_the_company_takes_the_binding():
    from scout.memory import resolve as r

    conn = _enabled_db()
    r.bind_session("sess-alpha", CO_GOLDEN, conn=conn)
    conn.commit()
    before = r.session_binding("sess-alpha", conn=conn).status
    cur = conn.cursor()
    cur.execute("DELETE FROM companies WHERE id = %s", [CO_GOLDEN])
    cur.close()
    conn.commit()
    after = r.session_binding("sess-alpha", conn=conn).status
    check("t49 bound before", before == r.RESOLVED, before)
    check("t49 gone after (cascade)", after == r.NONE, after)


@case
def t50_bind_validates_company_id():
    from scout.memory import MemoryScopeError
    from scout.memory import resolve as r

    conn = _enabled_db()
    for bad in (None, 0, -1, True, "abc", 1.5):
        raised = False
        try:
            r.bind_session("sess-alpha", bad, conn=conn)
        except MemoryScopeError:
            raised = True
        except Exception:
            raised = False
        check(f"t50 company_id {bad!r} refused", raised, f"bind accepted {bad!r}")
    raised = False
    try:
        r.bind_session("", CO_GOLDEN, conn=conn)
    except MemoryScopeError:
        raised = True
    check("t50 blank session_id refused", raised)


@case
def t51_resolve_then_bind_then_remember_end_to_end():
    """The real flow, asserting a NUMBER MOVED on both companies."""
    from scout.memory import MemoryScope, store
    from scout.memory import resolve as r

    conn = _enabled_db(PREFIX_REGISTER)

    # A short name cannot be written against.
    ambiguous = r.resolve_for_session("sess-alpha", "Golden Lotus", conn=conn)
    check("t51 short name is ambiguous", ambiguous.status == r.AMBIGUOUS, str(ambiguous))

    # The user picks; we bind.
    settled = r.resolve_for_session("sess-alpha", "Golden Lotus Trading Company Limited", conn=conn)
    check("t51 full name resolves", settled.is_resolved, str(settled))
    r.bind_session("sess-alpha", settled.company_id, bound_by=CLERK, conn=conn)
    conn.commit()

    # Later turn, no name at all.
    later = r.resolve_for_session("sess-alpha", conn=conn)
    check("t51 later turn resolves from the binding", later.company_id == CO_GL_TRADING, str(later))

    scope = MemoryScope(later.company_id, CLERK)
    store.remember(scope, "financial year end", "31 March", category="convention", session_id="sess-alpha", conn=conn)
    conn.commit()

    trading = store.count(MemoryScope(CO_GL_TRADING, CLERK), conn=conn)
    holdings = store.count(MemoryScope(CO_GL_HOLDINGS, CLERK), conn=conn)
    check("t51 the resolved company has 1", trading == 1, f"got {trading}")
    check("t51 the sibling has 0", holdings == 0, f"got {holdings}")


@case
def t52_resolver_sql_never_limits_an_ambiguity():
    from scout.memory import sql as sql_mod

    built = {
        "select_by_registration_number": sql_mod.select_by_registration_number("1"),
        "select_by_exact_name": sql_mod.select_by_exact_name("x"),
        "select_name_candidates": sql_mod.select_name_candidates("x"),
        "select_session_binding": sql_mod.select_session_binding("s"),
        "upsert_session_binding": sql_mod.upsert_session_binding("s", 1, None),
        "delete_session_binding": sql_mod.delete_session_binding("s"),
    }
    check(
        "t52 every resolver builder covered",
        set(built) == set(sql_mod.RESOLVER_BUILDERS),
        f"declared={sorted(sql_mod.RESOLVER_BUILDERS)} covered={sorted(built)}",
    )

    # The two that decide identity must be able to see a second row.
    for name in ("select_by_registration_number", "select_by_exact_name"):
        check(f"t52 {name} has no LIMIT", "LIMIT" not in built[name][0].upper(), built[name][0])
    # The candidate query is allowed a LIMIT — it offers, it does not pick —
    # but it must be a bound parameter, not a hardcoded 1.
    candidates_sql = built["select_name_candidates"][0]
    check("t52 candidate LIMIT is parameterised", "LIMIT %s" in candidates_sql, candidates_sql)
    check("t52 candidate query escapes LIKE", "ESCAPE" in candidates_sql, candidates_sql)
    check(
        "t52 candidate query is not length-ordered",
        "LENGTH" not in candidates_sql.upper(),
        "ORDER BY LENGTH is how people_picker.py:123 silently picks",
    )


@case
def t53_like_escape_is_correct():
    from scout.memory import sql as sql_mod

    check("t53 percent escaped", sql_mod.like_escape("a%b") == "a\\%b", sql_mod.like_escape("a%b"))
    check("t53 underscore escaped", sql_mod.like_escape("a_b") == "a\\_b", sql_mod.like_escape("a_b"))
    check("t53 backslash doubled first", sql_mod.like_escape("a\\b") == "a\\\\b", sql_mod.like_escape("a\\b"))
    check("t53 plain text untouched", sql_mod.like_escape("Golden Lotus") == "Golden Lotus")


@case
def t54_migration_026_file_rules():
    text = MIGRATION_SESSION.read_text(encoding="utf-8")
    code = "\n".join(line for line in text.splitlines() if not line.strip().startswith("--"))

    check("t54 file exists", MIGRATION_SESSION.exists())
    check("t54 table is IF NOT EXISTS", "CREATE TABLE IF NOT EXISTS session_company" in code)
    total_indexes = len(re.findall(r"CREATE (?:UNIQUE )?INDEX", code))
    guarded = code.count("CREATE INDEX IF NOT EXISTS") + code.count("CREATE UNIQUE INDEX IF NOT EXISTS")
    check(
        "t54 every index is IF NOT EXISTS",
        guarded == total_indexes and total_indexes == 1,
        f"guarded={guarded} total={total_indexes}",
    )
    check("t54 no %s placeholders", "%s" not in code)
    check("t54 does not touch schema_migrations", "schema_migrations" not in code)
    check("t54 company_id NOT NULL", "company_id  INTEGER NOT NULL" in code, "")
    check("t54 company_id is a FK", "REFERENCES companies(id) ON DELETE CASCADE" in code)
    check("t54 session_id is the PK", "session_id  TEXT PRIMARY KEY" in code)
    check("t54 no DML", not re.search(r"^\s*(INSERT|UPDATE|DELETE)\b", code, re.MULTILINE | re.IGNORECASE))
    for statement in ("DROP TABLE IF EXISTS session_company", "DROP INDEX IF EXISTS idx_session_company_company"):
        check(f"t54 reversing '{statement[:26]}...' documented", statement in text)
        check(f"t54 reversing '{statement[:26]}...' is commented", statement not in code)


@case
def t55_migration_026_number_is_free_and_ordered():
    db_dir = REPO_ROOT / "db"
    names = sorted(p.name for p in db_dir.glob("migration_*.sql"))
    same = [n for n in names if n.startswith("migration_026")]
    check("t55 exactly one migration_026", len(same) == 1, str(same))
    check(
        "t55 sorts after 025",
        names.index("migration_026_session_company.sql") > names.index("migration_025_people_cessation.sql"),
        str(names),
    )
    check("t55 023 untouched by this change", "migration_023_memory.sql" in names)


# ===========================================================================
# borrowed-connection safety
# ===========================================================================
# ★★★ A swallowed exception does not protect the caller. Memory is a SIDE
# record — written while somebody else's work is in flight. On PostgreSQL a
# failed statement aborts the whole transaction, so the caller's later
# statements fail and psycopg turns their COMMIT into a ROLLBACK: green
# light, work discarded.
#
# ★ HONEST LIMIT OF THIS HARNESS: sqlite does NOT poison a transaction on a
# constraint violation, so these tests CANNOT reproduce the PostgreSQL
# failure mode. What they do prove is that the SAVEPOINT statements really
# execute, that they scope the rollback to our rows only, and that the
# caller's in-flight work survives and commits. The PG half needs the live
# database.


@case
def t56_failed_write_on_a_borrowed_connection_spares_the_caller():
    from scout.memory import MemoryScope, store

    conn = _enabled_db(aborting=True)

    # The caller has work in flight on this connection, uncommitted.
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO companies (id, company_name_english, company_registration_number) VALUES (%s, %s, %s)",
        [808, "Cobalt Ridge Limited", "555000111"],
    )
    cur.close()

    # Our side record fails: no such company.
    result = store.remember(MemoryScope(999999, CLERK), "year end", "31 March", conn=conn)
    check("t56 our write reported failure", result["stored"] is False, str(result))

    # The caller's work must still be there and still committable.
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM companies WHERE id = %s", [808])
    survived = cur.fetchone()[0]
    cur.close()
    check("t56 caller's in-flight row survived", survived == 1, f"got {survived}")

    conn.commit()
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM companies WHERE id = %s", [808])
    committed = cur.fetchone()[0]
    cur.close()
    check("t56 caller's work committed", committed == 1, f"got {committed}")


@case
def t57_savepoint_rollback_is_scoped_to_our_rows():
    """A failed second write must not undo our own earlier committed one."""
    from scout.memory import MemoryScope, store

    conn = _enabled_db(aborting=True)
    scope = MemoryScope(CO_GOLDEN, CLERK)
    store.remember(scope, "financial year end", "31 March", conn=conn)
    conn.commit()

    before = store.count(scope, conn=conn)
    store.remember(MemoryScope(999999, CLERK), "orphan", "value", conn=conn)
    after = store.count(scope, conn=conn)

    check("t57 good memory present before", before == 1, f"got {before}")
    check("t57 good memory survives the failure", after == 1, f"got {after}")

    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM company_memory WHERE company_id = %s", [999999])
    orphans = cur.fetchone()[0]
    cur.close()
    check("t57 no orphan row left behind", orphans == 0, f"got {orphans}")


@case
def t58_failed_bind_on_a_borrowed_connection_spares_the_caller():
    from scout.memory import resolve as r

    conn = _enabled_db(aborting=True)

    cur = conn.cursor()
    cur.execute(
        "INSERT INTO companies (id, company_name_english, company_registration_number) VALUES (%s, %s, %s)",
        [909, "Indigo Field Limited", "666000111"],
    )
    cur.close()

    ok = r.bind_session("sess-alpha", 999999, conn=conn)
    check("t58 bind reported failure", ok is False, "an orphan binding was accepted")

    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM companies WHERE id = %s", [909])
    survived = cur.fetchone()[0]
    cur.close()
    check("t58 caller's in-flight row survived", survived == 1, f"got {survived}")
    conn.commit()


@case
def t59_owning_the_connection_uses_no_savepoint():
    """When we open the connection there is no caller to protect.

    A savepoint on our own single-statement transaction would be noise;
    a plain rollback is correct and cheaper. Asserted by watching the
    helpers rather than by reading the code.
    """
    from scout.memory import store

    calls = []
    real_enter = store._enter_savepoint
    store._enter_savepoint = lambda conn, borrowed: calls.append(borrowed)
    try:
        conn = _enabled_db()
        from scout.memory import MemoryScope

        store.remember(MemoryScope(CO_GOLDEN, CLERK), "k", "v", conn=conn)
        check("t59 borrowed connection asks for a savepoint", calls == [True], str(calls))
    finally:
        store._enter_savepoint = real_enter


@case
def t60_savepoint_helpers_use_a_fixed_identifier():
    """The savepoint name must never be built from input."""
    source = (MEMORY_PKG / "store.py").read_text(encoding="utf-8")
    check("t60 name is a module constant", '_SAVEPOINT_NAME = "ls_memory_write"' in source)
    check(
        "t60 no format interpolation into SAVEPOINT",
        not re.search(r"SAVEPOINT\s*[%{]", source),
        "savepoint name is interpolated",
    )
    for fragment in (
        '"SAVEPOINT " + _SAVEPOINT_NAME',
        '"RELEASE SAVEPOINT " + _SAVEPOINT_NAME',
        '"ROLLBACK TO SAVEPOINT " + _SAVEPOINT_NAME',
    ):
        check(f"t60 {fragment[:26]}... is a literal concat", fragment in source)


@case
def t62_the_aborting_harness_really_poisons():
    """★ POSITIVE CONTROL ON THE FAKE.

    A control that only rules out my CHANGE and not my HARNESS proves
    nothing. This drives the aborting connection directly, with NO
    savepoint anywhere, and asserts all three PostgreSQL behaviours fire.
    If this test ever goes quiet, t56-t58 are green for the wrong reason.
    """
    conn = build_db(aborting=True)
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO companies (id, company_name_english, company_registration_number) VALUES (%s, %s, %s)",
        [700, "Vermilion Coast Limited", "777000111"],
    )
    cur.close()

    raised = False
    cur = conn.cursor()
    try:
        cur.execute(
            "INSERT INTO company_memory (company_id, memory_key, memory_value,"
            " category, revision, source) VALUES (%s, %s, %s, %s, %s, %s)",
            [999999, "k", "v", "fact", 1, "chat"],
        )
    except Exception:
        raised = True
    cur.close()
    check("t62 the bad statement failed", raised, "the FK was not enforced")
    check("t62 transaction is now aborted", conn.aborted is True)

    died = False
    try:
        cur = conn.cursor()
        cur.execute("SELECT 1")
        cur.close()
    except InFailedSqlTransaction:
        died = True
    check("t62 caller's next statement raises", died, "the harness is inert — it does not model the abort")

    conn.commit()
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM companies WHERE id = %s", [700])
    survived = cur.fetchone()[0]
    cur.close()
    check(
        "t62 commit reported success but DISCARDED the work",
        survived == 0,
        f"got {survived} — the harness does not model the silent rollback",
    )


@case
def t61_every_write_path_is_savepoint_guarded():
    """Structural: a new write that forgets the guard fails here."""
    for module in ("store.py", "resolve.py"):
        source = (MEMORY_PKG / module).read_text(encoding="utf-8")
        enters = source.count("_enter_savepoint(conn, not owns_connection)")
        releases = source.count("_release_savepoint(conn, not owns_connection)")
        rollbacks = source.count("_rollback_savepoint(conn, True)")
        check(f"t61 {module} enter/release balanced", enters == releases, f"enter={enters} release={releases}")
        check(
            f"t61 {module} every guarded write has a rollback",
            enters == rollbacks,
            f"enter={enters} rollback={rollbacks}",
        )
        check(f"t61 {module} has guarded writes", enters >= 2, f"got {enters}")


# ===========================================================================
# main
# ===========================================================================


def run_suite():
    # t12 deliberately provokes a FK violation; the store logs it, correctly.
    # Silence it so a green run has clean output. TRACKER_MEMORY_TRACE=1 to see it.
    import logging

    if not os.environ.get("TRACKER_MEMORY_TRACE"):
        logging.getLogger("legalscout.memory").setLevel(logging.CRITICAL)

    if BREAK:
        apply_break(BREAK)
    for test in CASES:
        test()
    return len(PASSED), len(FAILED)


def print_report(passed, failed):
    print()
    print("=" * 74)
    header = "tracker_memory"
    if BREAK:
        header += f"  [BREAK={BREAK}]"
    print(f"{header}: {passed} PASS  {failed} FAIL")
    print("=" * 74)
    for label, detail in FAILED:
        print(f"  FAIL  {label}")
        if detail:
            print(f"        {detail}")
    print()


def run_negative_controls():
    """Re-run the suite once per injected defect; each must go red."""
    env = dict(os.environ)
    env.pop("TRACKER_MEMORY_BREAK", None)

    baseline = subprocess.run([sys.executable, str(Path(__file__))], capture_output=True, text=True, env=env)
    base_pass, base_fail = _parse_counts(baseline.stdout)

    print()
    print("NEGATIVE CONTROLS")
    print("-" * 74)
    print(f"{'defect injected':<22} {'PASS':>6} {'FAIL':>6}   verdict")
    print("-" * 74)
    print(
        f"{'(none — baseline)':<22} {base_pass:>6} {base_fail:>6}   {'OK' if base_fail == 0 else 'BASELINE ALREADY RED'}"
    )

    all_good = base_fail == 0
    for name in BREAKS:
        env["TRACKER_MEMORY_BREAK"] = name
        proc = subprocess.run([sys.executable, str(Path(__file__))], capture_output=True, text=True, env=env)
        broken_pass, broken_fail = _parse_counts(proc.stdout)
        caught = broken_fail > 0
        all_good = all_good and caught
        print(f"{name:<22} {broken_pass:>6} {broken_fail:>6}   {'caught' if caught else 'NOT CAUGHT'}")
    print("-" * 74)
    print("Every defect must move FAIL off zero. A defect that does not is a test to delete.")
    print()
    return 0 if all_good else 1


def _parse_counts(output):
    match = re.search(r":\s*(\d+) PASS\s+(\d+) FAIL", output)
    if not match:
        return (-1, -1)
    return int(match.group(1)), int(match.group(2))


def main():
    if "--negative-controls" in sys.argv:
        return run_negative_controls()
    passed, failed = run_suite()
    print_report(passed, failed)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
