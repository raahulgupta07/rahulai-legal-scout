"""
Turn scope.
===========

The unit this ledger is organised around is the TURN — one user message and
everything the agent did in response — not the individual action. That is the
difference between this and ``activity_logs``: "what did the bot change when it
produced that letter?" is a question about a turn, and answering it means the
document row, the S3 upload, the two people rows the sync filled in and the
queued email all have to carry the same identifier.

The turn boundary lives in HTTP middleware, because the agent loop itself is
Agno's (``app = agent_os.get_app()`` mounts ``/agents/{id}/runs``) and is not
ours to edit. Middleware enters the scope; every tool the turn calls reads it
from a ContextVar without being passed anything.

ContextVar, not thread-local: the app is async, several turns are in flight in
one thread, and a thread-local would let them overwrite each other's turn id.
ContextVars are per-task and are copied into ``asyncio.to_thread`` workers, so
a tool that does blocking DB work off the loop still sees the right turn.

Nothing here touches the database or imports psycopg.
"""

from __future__ import annotations

import contextlib
import threading
import uuid
from contextvars import ContextVar
from typing import Any, Dict, Iterator, Optional

from scout.effects.flag import ledger_enabled


class TurnContext:
    """Identity and ordering state for one agent turn.

    ``seq`` is handed out under a lock. Tools inside a turn can run
    concurrently (an ``asyncio.gather`` over two generations is enough), and
    two effects sharing a seq would make the undo order ambiguous.
    """

    __slots__ = ("turn_id", "session_id", "actor_email", "_seq", "_lock", "meta")

    def __init__(
        self,
        turn_id: str,
        session_id: Optional[str] = None,
        actor_email: Optional[str] = None,
        meta: Optional[Dict[str, Any]] = None,
    ) -> None:
        self.turn_id = turn_id
        self.session_id = session_id
        self.actor_email = actor_email
        self.meta = meta or {}
        self._seq = 0
        self._lock = threading.Lock()

    def next_seq(self) -> int:
        with self._lock:
            self._seq += 1
            return self._seq

    @property
    def effect_count(self) -> int:
        return self._seq

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            "TurnContext(turn_id={!r}, session_id={!r}, effects={})".format(
                self.turn_id, self.session_id, self._seq
            )
        )


_current: ContextVar[Optional[TurnContext]] = ContextVar(
    "scout_effects_turn", default=None
)


def new_turn_id() -> str:
    return uuid.uuid4().hex


def current_turn() -> Optional[TurnContext]:
    """The turn in scope, or None outside a turn / when the flag is off."""
    return _current.get()


def current_turn_id() -> Optional[str]:
    turn = _current.get()
    return turn.turn_id if turn else None


@contextlib.contextmanager
def turn_scope(
    session_id: Optional[str] = None,
    actor_email: Optional[str] = None,
    turn_id: Optional[str] = None,
    meta: Optional[Dict[str, Any]] = None,
) -> Iterator[Optional[TurnContext]]:
    """Enter a turn scope. Yields the TurnContext, or None when the flag is off.

    Flag off is a true no-op: no uuid is minted, no ContextVar is set, no turn
    header is written. Callers must therefore not assume the yielded value is
    non-None.

    The scope is reset in a ``finally`` so an exception raised by the request it
    wraps still unwinds the turn — otherwise a failed turn would leak its id
    into the next request served on the same task.
    """
    if not ledger_enabled():
        yield None
        return

    ctx = TurnContext(
        turn_id=turn_id or new_turn_id(),
        session_id=session_id,
        actor_email=actor_email,
        meta=meta,
    )
    token = _current.set(ctx)

    # ★ _safe_open sits INSIDE the try, not before it. It swallows its own
    # errors, so in principle it cannot raise — but "in principle" is not the
    # standard here. If anything between setting the token and entering the
    # body ever throws, the finally is the only thing that resets the
    # ContextVar, and without it a failed turn leaks its id into every later
    # request served on the same task: effects would be filed under a turn
    # nobody took, and `record` outside a turn would silently start writing.
    # This exact leak was caught by the negative-control run (M03), not by
    # reading the code.
    try:
        # The turn header is best-effort in both directions. Failing to open it
        # must not fail the request, and effect rows do not depend on it
        # existing — effect_log has no FK to effect_turns precisely so this can
        # be lossy.
        _safe_open(ctx)
        yield ctx
    finally:
        _safe_close(ctx)
        _current.reset(token)


def bind_session(session_id: Optional[str]) -> None:
    """Attach a conversation id to the turn already in scope.

    The turn boundary is HTTP middleware, which cannot cheaply learn the agno
    session id: it arrives in the multipart body of ``POST /agents/{id}/runs``,
    and reading a request body in middleware means buffering and re-injecting
    the receive channel — fragile against uploads and SSE. So the middleware
    opens the turn without a session and this fills it in later, from wherever
    the session IS known.
    """
    turn = _current.get()
    if turn is not None and session_id:
        turn.session_id = str(session_id).strip() or None


def ambient_session() -> Optional[str]:
    """The conversation id the tools layer already tracks, if any.

    ``scout.tools.slot_resolver`` sets a ContextVar at every tool entry point
    that has agno's RunContext (``session_scope``), because a director picked
    in one chat was bleeding into another. That ContextVar is the session id
    this ledger wants, already correct and already scoped, so the ledger reads
    it rather than asking the tools layer to call anything new — which is why
    wiring the ledger needs no edit under ``scout/tools/`` at all.

    Imported lazily and inside a try: slot_resolver pulls in psycopg, which is
    absent in local test runs, and a missing session must degrade to None
    rather than cost an effect row.
    """
    try:
        from scout.tools.slot_resolver import current_session_scope

        return (current_session_scope() or "").strip() or None
    except Exception:
        return None


def _safe_open(ctx: TurnContext) -> None:
    try:
        from scout.effects.sink import get_sink

        get_sink().open_turn(ctx)
    except Exception:  # pragma: no cover - exercised via the isolation test
        _log_swallowed("open_turn")


def _safe_close(ctx: TurnContext) -> None:
    try:
        from scout.effects.sink import get_sink

        get_sink().close_turn(ctx)
    except Exception:  # pragma: no cover - exercised via the isolation test
        _log_swallowed("close_turn")


def _log_swallowed(where: str) -> None:
    try:
        import logging

        logging.getLogger("legalscout").warning(
            "effects ledger: %s failed and was ignored", where, exc_info=True
        )
    except Exception:
        pass
