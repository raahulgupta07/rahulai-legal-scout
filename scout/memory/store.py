"""Durable per-company memory — read and write.

Contract
--------
* Flag OFF (the default) is a hard stop at the top of every function. No
  connection is opened, so this module is inert on a database that has
  never seen migration 023.
* Every function takes a :class:`MemoryScope` FIRST and positionally.
* Every statement carries the scope predicate — see scout/memory/sql.py.
* psycopg is imported lazily, inside the connection helper, so importing
  this package costs nothing and works on a machine with no driver.
"""

from __future__ import annotations

import logging

from scout.memory.flags import memory_enabled
from scout.memory.scope import MemoryScope, MemoryScopeError, require_scope
from scout.memory import sql as _sql

log = logging.getLogger("legalscout.memory")

#: Longest value we will store. A memory is a fact, not a document; the
#: agent has a knowledge base for the latter.
MAX_VALUE_CHARS = 4000
MAX_KEY_CHARS = 200

#: Result returned by every write path when the flag is off. `stored` is
#: the field callers branch on; `disabled` says why it is False.
DISABLED_WRITE = {"success": False, "stored": False, "disabled": True}


class _ConnectionFactory(object):
    """Indirection so tests can supply their own connection.

    Production leaves this alone and gets db.connection.get_db_conn,
    imported lazily on first use.
    """

    def __init__(self):
        self._override = None

    def set_override(self, factory):
        self._override = factory

    def clear_override(self):
        self._override = None

    def __call__(self):
        if self._override is not None:
            return self._override()
        # Lazy: psycopg is not installed on every machine that imports this
        # package, and nothing above this line needs it.
        from db.connection import get_db_conn

        return get_db_conn()


connection_factory = _ConnectionFactory()


# ---------------------------------------------------------------------------
# Borrowed-connection safety
# ---------------------------------------------------------------------------
# ★★★ A SWALLOWED EXCEPTION DOES NOT PROTECT THE CALLER.
#
# Memory is a SIDE RECORD: it is written while somebody else's work is in
# flight. If a memory write fails on the CALLER's connection, PostgreSQL
# marks that transaction aborted, and every later statement the caller
# issues fails with InFailedSqlTransaction — no matter how thoroughly this
# module catches its own error. Worse, psycopg turns the caller's COMMIT
# on an aborted transaction into a ROLLBACK, so they see a green light and
# lose their work.
#
# Returning {"success": False} would be a lie in that situation: the
# caller's data is gone and nothing here said so.
#
# Two defences, in order:
#   1. conn=None (the default, and what the API endpoints use) — we open
#      our own connection, so a failure cannot touch anyone else.
#   2. A borrowed conn — every write is wrapped in a SAVEPOINT. ROLLBACK
#      TO SAVEPOINT is legal inside an aborted transaction and restores it
#      to a usable state, so the caller's earlier work survives our
#      failure and their commit still means something.
#
# The name is a fixed identifier, never interpolated from input.
_SAVEPOINT_NAME = "ls_memory_write"


def _enter_savepoint(conn, borrowed):
    """Open a savepoint when writing on someone else's transaction."""
    if not borrowed:
        return
    cur = conn.cursor()
    try:
        cur.execute("SAVEPOINT " + _SAVEPOINT_NAME)
    finally:
        cur.close()


def _release_savepoint(conn, borrowed):
    if not borrowed:
        return
    cur = conn.cursor()
    try:
        cur.execute("RELEASE SAVEPOINT " + _SAVEPOINT_NAME)
    finally:
        cur.close()


def _rollback_savepoint(conn, borrowed):
    """Undo only our statements, leaving the caller's transaction usable.

    A fresh cursor deliberately: the one that hit the error may be in a
    state the driver will not reuse.
    """
    if not borrowed:
        return
    try:
        cur = conn.cursor()
        try:
            cur.execute("ROLLBACK TO SAVEPOINT " + _SAVEPOINT_NAME)
        finally:
            cur.close()
    except Exception as exc:
        # Nothing left to salvage here, but the caller must be able to see
        # in the log that their transaction may be poisoned.
        log.error(
            "memory could not roll back to its savepoint; the calling "
            "transaction may be aborted: %s", exc
        )


def _normalise_key(key):
    if not isinstance(key, str):
        raise MemoryScopeError(f"memory_key must be a string, got {type(key).__name__}")
    cleaned = " ".join(key.strip().lower().split())
    if not cleaned:
        raise MemoryScopeError("memory_key must not be blank")
    if len(cleaned) > MAX_KEY_CHARS:
        raise MemoryScopeError(f"memory_key exceeds {MAX_KEY_CHARS} characters")
    return cleaned


def _normalise_value(value):
    if value is None:
        raise MemoryScopeError("memory_value must not be None — use forget() to remove a memory")
    text = value if isinstance(value, str) else str(value)
    text = text.strip()
    if not text:
        raise MemoryScopeError("memory_value must not be blank")
    if len(text) > MAX_VALUE_CHARS:
        text = text[:MAX_VALUE_CHARS]
    return text


def _row_to_dict(row):
    record = dict(zip(_sql.READ_COLUMNS, row))
    for stamp in ("created_at", "updated_at", "superseded_at"):
        value = record.get(stamp)
        if value is not None and hasattr(value, "isoformat"):
            record[stamp] = value.isoformat()
    return record


def remember(scope, key, value, category="fact", confidence=None, source="chat",
             session_id=None, run_id=None, author_email=None, conn=None):
    """Store or update one fact about the scope's company.

    Re-remembering an existing key does NOT overwrite in place: the live
    row is retired (active=FALSE, superseded_at/by set) and a new row is
    inserted at revision+1, so the provenance trail survives the edit.

    Returns a dict with ``stored``, ``revision`` and ``superseded``.
    """
    if not memory_enabled():
        return dict(DISABLED_WRITE)

    scope = require_scope(scope)
    key = _normalise_key(key)
    value = _normalise_value(value)

    if category not in _sql.VALID_CATEGORIES:
        raise MemoryScopeError(
            "category must be one of %s, got %r" % (", ".join(_sql.VALID_CATEGORIES), category)
        )
    if confidence is not None:
        confidence = float(confidence)
        if not 0.0 <= confidence <= 1.0:
            raise MemoryScopeError(f"confidence must be between 0 and 1, got {confidence}")

    actor = author_email or scope.user_email
    owns_connection = conn is None
    if owns_connection:
        conn = connection_factory()
    _enter_savepoint(conn, not owns_connection)
    try:
        cur = conn.cursor()

        statement, params = _sql.select_owned_active(scope, key)
        cur.execute(statement, params)
        existing = cur.fetchone()

        revision = 1
        superseded = False
        if existing:
            revision = int(existing[1]) + 1
            statement, params = _sql.supersede(scope, key, actor)
            cur.execute(statement, params)
            superseded = True

        statement, params = _sql.insert(
            scope, key, value, category, confidence, revision, source,
            session_id, run_id, actor,
        )
        cur.execute(statement, params)

        cur.close()
        _release_savepoint(conn, not owns_connection)
        if owns_connection:
            conn.commit()
        return {
            "success": True,
            "stored": True,
            "disabled": False,
            "company_id": scope.company_id,
            "memory_key": key,
            "revision": revision,
            "superseded": superseded,
        }
    except Exception as exc:
        if owns_connection:
            try:
                conn.rollback()
            except Exception as rollback_exc:
                log.warning("memory rollback failed: %s", rollback_exc)
        else:
            # Undo only our statements. Without this the caller's whole
            # transaction is aborted and their commit silently discards
            # their work — see the savepoint note above.
            _rollback_savepoint(conn, True)
        # Re-raise validation problems; a caller passing junk should hear
        # about it. Everything else is logged and reported, never swallowed
        # into a silent empty success.
        if isinstance(exc, MemoryScopeError):
            raise
        log.warning("memory write failed for company %s key %r: %s", scope.company_id, key, exc)
        return {"success": False, "stored": False, "disabled": False, "error": str(exc)}
    finally:
        if owns_connection:
            try:
                conn.close()
            except Exception as close_exc:
                log.warning("memory connection close failed: %s", close_exc)


def recall(scope, key=None, category=None, limit=50, conn=None):
    """Live memories visible in this scope, oldest key first.

    Visibility is company-wide rows (user_email IS NULL) plus the scope
    user's own private rows. Never another company's, never another
    user's private rows.
    """
    if not memory_enabled():
        return []

    scope = require_scope(scope)
    if key is not None:
        key = _normalise_key(key)
    if category is not None and category not in _sql.VALID_CATEGORIES:
        raise MemoryScopeError(
            "category must be one of %s, got %r" % (", ".join(_sql.VALID_CATEGORIES), category)
        )
    limit = max(1, min(int(limit), 500))

    owns_connection = conn is None
    if owns_connection:
        conn = connection_factory()
    try:
        cur = conn.cursor()
        statement, params = _sql.select_active(scope, key=key, category=category, limit=limit)
        cur.execute(statement, params)
        rows = cur.fetchall()
        cur.close()
        return [_row_to_dict(row) for row in rows]
    except Exception as exc:
        if isinstance(exc, MemoryScopeError):
            raise
        log.warning("memory read failed for company %s: %s", scope.company_id, exc)
        return []
    finally:
        if owns_connection:
            try:
                conn.close()
            except Exception as close_exc:
                log.warning("memory connection close failed: %s", close_exc)


def count(scope, conn=None):
    """Number of live memories visible in this scope.

    The number the scope tests assert moved.
    """
    if not memory_enabled():
        return 0

    scope = require_scope(scope)
    owns_connection = conn is None
    if owns_connection:
        conn = connection_factory()
    try:
        cur = conn.cursor()
        statement, params = _sql.count_active(scope)
        cur.execute(statement, params)
        row = cur.fetchone()
        cur.close()
        return int(row[0]) if row else 0
    except Exception as exc:
        if isinstance(exc, MemoryScopeError):
            raise
        log.warning("memory count failed for company %s: %s", scope.company_id, exc)
        return 0
    finally:
        if owns_connection:
            try:
                conn.close()
            except Exception as close_exc:
                log.warning("memory connection close failed: %s", close_exc)


def forget(scope, key, author_email=None, conn=None):
    """Retire the live memory for one key. Returns rows retired (0 or 1).

    A soft retire — the row stays readable through history().
    """
    if not memory_enabled():
        return 0

    scope = require_scope(scope)
    key = _normalise_key(key)
    actor = author_email or scope.user_email

    owns_connection = conn is None
    if owns_connection:
        conn = connection_factory()
    _enter_savepoint(conn, not owns_connection)
    try:
        cur = conn.cursor()
        statement, params = _sql.supersede(scope, key, actor)
        cur.execute(statement, params)
        retired = cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
        cur.close()
        _release_savepoint(conn, not owns_connection)
        if owns_connection:
            conn.commit()
        return retired
    except Exception as exc:
        if owns_connection:
            try:
                conn.rollback()
            except Exception as rollback_exc:
                log.warning("memory rollback failed: %s", rollback_exc)
        else:
            _rollback_savepoint(conn, True)
        if isinstance(exc, MemoryScopeError):
            raise
        log.warning("memory forget failed for company %s key %r: %s", scope.company_id, key, exc)
        return 0
    finally:
        if owns_connection:
            try:
                conn.close()
            except Exception as close_exc:
                log.warning("memory connection close failed: %s", close_exc)


def history(scope, key, conn=None):
    """Every revision of one key, oldest first — the provenance trail."""
    if not memory_enabled():
        return []

    scope = require_scope(scope)
    key = _normalise_key(key)

    owns_connection = conn is None
    if owns_connection:
        conn = connection_factory()
    try:
        cur = conn.cursor()
        statement, params = _sql.select_history(scope, key)
        cur.execute(statement, params)
        rows = cur.fetchall()
        cur.close()
        return [_row_to_dict(row) for row in rows]
    except Exception as exc:
        if isinstance(exc, MemoryScopeError):
            raise
        log.warning("memory history failed for company %s: %s", scope.company_id, exc)
        return []
    finally:
        if owns_connection:
            try:
                conn.close()
            except Exception as close_exc:
                log.warning("memory connection close failed: %s", close_exc)


def render_for_prompt(scope, limit=25, conn=None):
    """Memories as a compact block for the system prompt.

    Empty string when the flag is off or nothing is remembered — so the
    caller can concatenate unconditionally and change no prompt byte
    while the flag stays off.
    """
    memories = recall(scope, limit=limit, conn=conn)
    if not memories:
        return ""
    lines = ["## Remembered about this company", ""]
    for record in memories:
        lines.append("- (%s) %s: %s" % (record["category"], record["memory_key"], record["memory_value"]))
    return "\n".join(lines)
