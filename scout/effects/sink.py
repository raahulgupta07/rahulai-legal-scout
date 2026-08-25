"""
Where effect rows go.
=====================

THE RULE THIS MODULE EXISTS TO ENFORCE: the ledger writes on its OWN
connection, always. It never accepts a caller's connection and there is no
parameter through which one could be passed.

Swallowing the Python exception in ``recorder.record`` is necessary but not
sufficient. If a ledger INSERT ran inside the caller's transaction and failed —
a constraint, a type mismatch, a dropped column after a partial migration —
Postgres marks that transaction aborted. Every subsequent statement the CALLER
issues then fails with "current transaction is aborted, commands ignored until
end of transaction block", no matter how thoroughly the ledger caught its own
error. The caller's work is destroyed by a logging table.

That is not hypothetical here. ``people_sync.sync_company_people`` is
documented as running on the caller's connection and deliberately not
committing, so the caller owns a long transaction spanning many writes; a
ledger insert borrowing it would take the whole company sync down. Hence: own
connection, autocommit, closed immediately.

psycopg is imported lazily inside the method, never at module import: the local
dev/test environment has no psycopg, and the flag-off path must not need one.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Protocol

from scout.effects.model import Effect
from scout.effects.turn import TurnContext

logger = logging.getLogger("legalscout")

_INSERT_SQL = """
INSERT INTO effect_log (
    turn_id, seq, session_id, actor_email, tool_name,
    kind, op, target_table, target_id, target_label,
    before_image, after_image, reversible, irreversible_reason
) VALUES (
    %s, %s, %s, %s, %s,
    %s, %s, %s, %s, %s,
    %s, %s, %s, %s
) RETURNING id
"""

_OPEN_TURN_SQL = """
INSERT INTO effect_turns (turn_id, session_id, actor_email)
VALUES (%s, %s, %s)
ON CONFLICT (turn_id) DO NOTHING
"""

_CLOSE_TURN_SQL = """
UPDATE effect_turns
   SET ended_at = CURRENT_TIMESTAMP, effect_count = %s
 WHERE turn_id = %s
"""


class Sink(Protocol):
    def open_turn(self, ctx: TurnContext) -> None: ...
    def close_turn(self, ctx: TurnContext) -> None: ...
    def write(self, effect: Effect) -> Optional[int]: ...


class NullSink:
    """Discards everything. The sink in force when the flag is off."""

    def open_turn(self, ctx: TurnContext) -> None:
        return None

    def close_turn(self, ctx: TurnContext) -> None:
        return None

    def write(self, effect: Effect) -> Optional[int]:
        return None


class MemorySink:
    """Collects effects in a list. For tests; never wired in production."""

    def __init__(self) -> None:
        self.turns: List[TurnContext] = []
        self.closed: List[TurnContext] = []
        self.effects: List[Effect] = []

    def open_turn(self, ctx: TurnContext) -> None:
        self.turns.append(ctx)

    def close_turn(self, ctx: TurnContext) -> None:
        self.closed.append(ctx)

    def write(self, effect: Effect) -> Optional[int]:
        self.effects.append(effect)
        return len(self.effects)

    # Convenience for assertions.
    def kinds(self) -> List[str]:
        return [e.kind for e in self.effects]

    def by_kind(self, kind: str) -> List[Effect]:
        return [e for e in self.effects if e.kind == kind]


class PostgresSink:
    """Writes to effect_log / effect_turns on a connection of its own.

    Every method opens, writes, commits and closes. That is more connection
    churn than a pool would cost, and it is the price of the isolation rule at
    the top of this file: a shared connection is a shared transaction, and a
    shared transaction is how a ledger takes down the work it describes.
    """

    def _connect(self) -> Any:
        # Lazy: psycopg is not installed in the local test environment, and
        # importing db.connection at module scope would import it.
        from db.connection import get_db_conn

        return get_db_conn(autocommit=True)

    def _json(self, value: Optional[Dict[str, Any]]) -> Optional[str]:
        if value is None:
            return None
        import json

        return json.dumps(value, default=str)

    def open_turn(self, ctx: TurnContext) -> None:
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                cur.execute(_OPEN_TURN_SQL, (ctx.turn_id, ctx.session_id, ctx.actor_email))
        finally:
            conn.close()

    def close_turn(self, ctx: TurnContext) -> None:
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                cur.execute(_CLOSE_TURN_SQL, (ctx.effect_count, ctx.turn_id))
        finally:
            conn.close()

    def write(self, effect: Effect) -> Optional[int]:
        row = effect.as_row()
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    _INSERT_SQL,
                    (
                        row["turn_id"],
                        row["seq"],
                        row["session_id"],
                        row["actor_email"],
                        row["tool_name"],
                        row["kind"],
                        row["op"],
                        row["target_table"],
                        row["target_id"],
                        row["target_label"],
                        self._json(row["before_image"]),
                        self._json(row["after_image"]),
                        row["reversible"],
                        row["irreversible_reason"],
                    ),
                )
                out = cur.fetchone()
                return out[0] if out else None
        finally:
            conn.close()


_sink: Optional[Sink] = None


def get_sink() -> Sink:
    """The active sink. Postgres by default; NullSink when the flag is off."""
    global _sink
    if _sink is not None:
        return _sink
    from scout.effects.flag import ledger_enabled

    if not ledger_enabled():
        return NullSink()
    _sink = PostgresSink()
    return _sink


def set_sink(sink: Optional[Sink]) -> None:
    """Install a sink (tests). ``None`` restores the default."""
    global _sink
    _sink = sink


def reset_sink() -> None:
    set_sink(None)
