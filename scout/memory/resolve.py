"""Strict company resolution for the memory layer.

Three states, never a best guess.

WHY THIS IS STRICTER THAN THE EIGHT RESOLVERS ALREADY IN THE TREE
-----------------------------------------------------------------
Every existing caller of a fuzzy company match fails LOUDLY. If
`get_directors` matches the wrong company, the generated document names
strangers and a lawyer catches it at review — that is exactly how the
cross-session party bleed in migration 017 was found, by a human reading
an unfamiliar name in minutes.

A mis-scoped memory WRITE fails silently and permanently. The fact lands
under the wrong client, survives every future session, and the provenance
trail in company_memory makes it MORE convincing, not less:
created_by_email, source_session_id, source_run_id and the timestamp
would all be genuinely correct. Only the company would be wrong, and
nothing in the row would say so.

So: a substring match NEVER resolves. Only an exact name, a registration
number, or an existing session binding does. Everything else is handed
back as AMBIGUOUS for a human to settle — one candidate is a
confirmation, several is a choice — and once settled, bind_session()
means the question is asked once per conversation, not once per turn.

This module does not change what any existing tool resolves to. The
eight sites in scout/tools/ are untouched; this is the strict one that
memory uses.
"""

from __future__ import annotations

import logging

from scout.memory import sql as _sql
from scout.memory.flags import memory_enabled
from scout.memory.scope import MemoryScopeError, _coerce_company_id
from scout.memory.store import (
    _enter_savepoint,
    _release_savepoint,
    _rollback_savepoint,
    connection_factory,
)

log = logging.getLogger("legalscout.memory")

#: Resolution outcomes.
RESOLVED = "resolved"
AMBIGUOUS = "ambiguous"
NONE = "none"

#: How the company was identified. Useful in a tool result so the model can
#: say WHY it is confident, and in the audit trail.
BY_SESSION = "session_binding"
BY_REGISTRATION = "registration_number"
BY_EXACT_NAME = "exact_name"

#: A name shorter than this is not worth offering candidates for — "a"
#: would return the whole register as a "choice", which is not a choice.
MIN_CANDIDATE_CHARS = 2


class Resolution:
    """The answer to "which company is this?".

    ``status`` is one of RESOLVED / AMBIGUOUS / NONE. ``company_id`` is set
    ONLY when status is RESOLVED — read it without checking and you get
    None, not a guess.
    """

    __slots__ = ("candidates", "company_id", "company_name", "match_kind", "query", "registration_number", "status")

    def __init__(
        self,
        status,
        company_id=None,
        company_name=None,
        registration_number=None,
        candidates=None,
        match_kind=None,
        query=None,
    ):
        self.status = status
        self.company_id = company_id
        self.company_name = company_name
        self.registration_number = registration_number
        self.candidates = list(candidates or [])
        self.match_kind = match_kind
        self.query = query

    @property
    def is_resolved(self):
        return self.status == RESOLVED and self.company_id is not None

    def as_dict(self):
        """Shape a tool returns to the model."""
        return {
            "status": self.status,
            "company_id": self.company_id,
            "company_name": self.company_name,
            "registration_number": self.registration_number,
            "candidates": self.candidates,
            "match_kind": self.match_kind,
            "query": self.query,
        }

    def __repr__(self):
        return f"Resolution({self.status}, company_id={self.company_id!r}, candidates={len(self.candidates)})"


def _row_to_candidate(row):
    return {
        "company_id": row[0],
        "company_name": row[1],
        "registration_number": row[2] or "",
    }


def _looks_like_registration_number(text):
    """A DICA registration number has digits and no spaces.

    Deliberately narrow: a company NAME with a digit in it (common) must
    not be probed as a registration number, or "Lotus 2 Limited" would
    query the wrong column and come back NONE instead of matching by name.
    """
    stripped = text.strip()
    if not stripped or " " in stripped:
        return False
    return any(character.isdigit() for character in stripped)


def resolve_company(name, conn=None):
    """Resolve a company NAME (or registration number) strictly.

    Returns a :class:`Resolution`. RESOLVED only on a registration-number
    match or a single exact name match. A substring match is never
    resolved — it is returned as AMBIGUOUS, even when there is exactly
    one, because a name that merely CONTAINS the query is not the same
    claim as a name that equals it, and a second company added tomorrow
    would turn that lone match into a wrong one already written down.
    """
    if not memory_enabled():
        return Resolution(NONE, query=name)

    if not isinstance(name, str):
        raise MemoryScopeError(f"company name must be a string, got {type(name).__name__}")
    query = " ".join(name.strip().split())
    if not query:
        return Resolution(NONE, query=name)

    owns_connection = conn is None
    if owns_connection:
        conn = connection_factory()
    try:
        cur = conn.cursor()

        # 1. Registration number — UNIQUE on companies, so at most one row.
        if _looks_like_registration_number(query):
            statement, params = _sql.select_by_registration_number(query)
            cur.execute(statement, params)
            rows = cur.fetchall()
            if len(rows) == 1:
                cur.close()
                return Resolution(
                    RESOLVED,
                    company_id=rows[0][0],
                    company_name=rows[0][1],
                    registration_number=rows[0][2] or "",
                    match_kind=BY_REGISTRATION,
                    query=query,
                )

        # 2. Exact, case-insensitive name. No LIMIT above this line, so two
        #    rows differing only by case are seen as two, not silently one.
        statement, params = _sql.select_by_exact_name(query)
        cur.execute(statement, params)
        rows = cur.fetchall()
        if len(rows) == 1:
            cur.close()
            return Resolution(
                RESOLVED,
                company_id=rows[0][0],
                company_name=rows[0][1],
                registration_number=rows[0][2] or "",
                match_kind=BY_EXACT_NAME,
                query=query,
            )
        if len(rows) > 1:
            cur.close()
            return Resolution(
                AMBIGUOUS,
                candidates=[_row_to_candidate(row) for row in rows],
                query=query,
            )

        # 3. Substring candidates — offered, never chosen.
        if len(query) < MIN_CANDIDATE_CHARS:
            cur.close()
            return Resolution(NONE, query=query)

        statement, params = _sql.select_name_candidates(query)
        cur.execute(statement, params)
        rows = cur.fetchall()
        cur.close()
        if not rows:
            return Resolution(NONE, query=query)
        return Resolution(
            AMBIGUOUS,
            candidates=[_row_to_candidate(row) for row in rows],
            query=query,
        )
    except Exception as exc:
        if isinstance(exc, MemoryScopeError):
            raise
        log.warning("company resolution failed for %r: %s", name, exc)
        return Resolution(NONE, query=name)
    finally:
        if owns_connection:
            try:
                conn.close()
            except Exception as close_exc:
                log.warning("resolver connection close failed: %s", close_exc)


def session_binding(session_id, conn=None):
    """The company this conversation is bound to, or a NONE resolution."""
    if not memory_enabled():
        return Resolution(NONE)

    key = str(session_id or "").strip()
    if not key:
        return Resolution(NONE)

    owns_connection = conn is None
    if owns_connection:
        conn = connection_factory()
    try:
        cur = conn.cursor()
        statement, params = _sql.select_session_binding(key)
        cur.execute(statement, params)
        row = cur.fetchone()
        cur.close()
        if not row:
            return Resolution(NONE)
        return Resolution(
            RESOLVED,
            company_id=row[0],
            company_name=row[1],
            registration_number=row[2] or "",
            match_kind=BY_SESSION,
        )
    except Exception as exc:
        log.warning("session binding read failed for %r: %s", session_id, exc)
        return Resolution(NONE)
    finally:
        if owns_connection:
            try:
                conn.close()
            except Exception as close_exc:
                log.warning("resolver connection close failed: %s", close_exc)


def resolve_for_session(session_id, name=None, conn=None):
    """Resolve for a conversation: the binding first, then the name.

    With no name, the binding IS the answer — that is the whole point,
    so a turn that says "remember their year end is 31 March" does not
    have to re-name the company.

    With a name, an existing binding is used only when the name resolves
    to the SAME company or does not resolve at all. A name that resolves
    elsewhere wins, because the user has changed subject; the caller then
    decides whether to re-bind.
    """
    if not memory_enabled():
        return Resolution(NONE, query=name)

    bound = session_binding(session_id, conn=conn)
    if name is None or not str(name).strip():
        return bound

    named = resolve_company(name, conn=conn)
    if named.is_resolved:
        return named
    if bound.is_resolved:
        # An unresolvable name plus a bound session is the common case:
        # the model typed a short form of the company already agreed on.
        # Only trust the binding when the short form is actually one of
        # the candidates, otherwise a mention of a DIFFERENT company that
        # happens not to resolve would silently write to the bound one.
        if named.status == AMBIGUOUS:
            candidate_ids = {c["company_id"] for c in named.candidates}
            if bound.company_id in candidate_ids:
                return bound
            return named
        return bound
    return named


def bind_session(session_id, company_id, bound_by=None, conn=None):
    """Record which company a conversation is about.

    Only ever called with a company_id that came back RESOLVED. Re-binding
    is allowed and expected — a conversation can change subject.
    """
    if not memory_enabled():
        return False

    key = str(session_id or "").strip()
    if not key:
        raise MemoryScopeError("session_id is required to bind a company")
    company_id = _coerce_company_id(company_id)

    owns_connection = conn is None
    if owns_connection:
        conn = connection_factory()
    # Binding is a side record like a memory — a failure here must not
    # abort the caller's transaction. See the savepoint note in store.py.
    _enter_savepoint(conn, not owns_connection)
    try:
        cur = conn.cursor()
        statement, params = _sql.upsert_session_binding(key, company_id, bound_by)
        cur.execute(statement, params)
        cur.close()
        _release_savepoint(conn, not owns_connection)
        if owns_connection:
            conn.commit()
        return True
    except Exception as exc:
        if owns_connection:
            try:
                conn.rollback()
            except Exception as rollback_exc:
                log.warning("bind rollback failed: %s", rollback_exc)
        else:
            _rollback_savepoint(conn, True)
        if isinstance(exc, MemoryScopeError):
            raise
        log.warning("session bind failed for %r -> %s: %s", session_id, company_id, exc)
        return False
    finally:
        if owns_connection:
            try:
                conn.close()
            except Exception as close_exc:
                log.warning("resolver connection close failed: %s", close_exc)


def unbind_session(session_id, conn=None):
    """Drop a conversation's binding. Returns rows removed (0 or 1)."""
    if not memory_enabled():
        return 0

    key = str(session_id or "").strip()
    if not key:
        return 0

    owns_connection = conn is None
    if owns_connection:
        conn = connection_factory()
    _enter_savepoint(conn, not owns_connection)
    try:
        cur = conn.cursor()
        statement, params = _sql.delete_session_binding(key)
        cur.execute(statement, params)
        removed = cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
        cur.close()
        _release_savepoint(conn, not owns_connection)
        if owns_connection:
            conn.commit()
        return removed
    except Exception as exc:
        if owns_connection:
            try:
                conn.rollback()
            except Exception as rollback_exc:
                log.warning("unbind rollback failed: %s", rollback_exc)
        else:
            _rollback_savepoint(conn, True)
        log.warning("session unbind failed for %r: %s", session_id, exc)
        return 0
    finally:
        if owns_connection:
            try:
                conn.close()
            except Exception as close_exc:
                log.warning("resolver connection close failed: %s", close_exc)
