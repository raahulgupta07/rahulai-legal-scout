"""
record() — the only function callers use, and the only one that must never
raise.
=========================================================================

THE CONTRACT: writing to the ledger can never break the thing it records.
Whatever goes wrong — flag misread, malformed effect, database down, schema not
migrated, disk full — ``record`` returns None and the caller continues as if it
had never been called. A caller must be able to write

    result = generate_the_document(...)
    record("document.generated", "insert", ...)
    return result

and know that line three cannot cost it line four.

Two things make that true, and only one of them is here:
  * this module catches Exception around everything (below), and
  * ``sink.PostgresSink`` uses its own connection, so a failed INSERT cannot
    put the CALLER's transaction into Postgres's aborted state. Catching the
    Python exception alone would not have been enough. See sink.py.

BaseException is deliberately NOT caught. KeyboardInterrupt and SystemExit mean
the process is going away; swallowing them inside a logging call would make the
app unkillable during a write, which is a worse failure than a lost effect row.
"""

from __future__ import annotations

import logging
from typing import Any, Mapping, Optional

from scout.effects.flag import ledger_enabled
from scout.effects.turn import ambient_session, current_turn

logger = logging.getLogger("legalscout")


def _session_for(turn: Any) -> Optional[str]:
    """Resolve and memoise the turn's session id from the tools layer."""
    sid = ambient_session()
    if sid:
        turn.session_id = sid
    return sid


def record(
    kind: str,
    op: str,
    target_table: Optional[str] = None,
    target_id: Optional[Any] = None,
    target_label: Optional[str] = None,
    before: Optional[Mapping[str, Any]] = None,
    after: Optional[Mapping[str, Any]] = None,
    tool_name: Optional[str] = None,
    diff: bool = True,
    meta: Optional[Mapping[str, Any]] = None,
) -> Optional[int]:
    """Record one side effect of the current turn. Returns the row id or None.

    Returns None — never raises — when the flag is off, when no turn is in
    scope, or when anything at all fails. Callers must not branch on the
    return value for correctness; it is for tests and for the audit view.
    """
    # Flag check first, before any work: this is the byte-identical path.
    if not ledger_enabled():
        return None

    try:
        turn = current_turn()
        if turn is None:
            # An effect outside a turn has nothing to group it. Dropping it is
            # correct: a ledger row with a synthesised turn id would claim a
            # turn boundary that never existed, and the per-turn audit view
            # would show a turn nobody took.
            logger.debug("effects ledger: %s outside a turn scope, dropped", kind)
            return None

        from scout.effects.model import build_effect
        from scout.effects.sink import get_sink

        effect = build_effect(
            kind=kind,
            op=op,
            turn_id=turn.turn_id,
            seq=turn.next_seq(),
            # The middleware opens the turn before the session id is knowable;
            # the tools layer's own session ContextVar is the fallback. Once a
            # session is seen it is bound to the turn so later effects in the
            # same turn do not each pay the lookup, and so a turn whose session
            # became unavailable mid-way keeps the id it already had.
            session_id=turn.session_id or _session_for(turn),
            actor_email=turn.actor_email,
            tool_name=tool_name,
            target_table=target_table,
            target_id=target_id,
            target_label=target_label,
            before=before,
            after=after,
            diff=diff,
            meta=dict(meta) if meta else None,
        )
        return get_sink().write(effect)
    except Exception:
        # Deliberately broad, deliberately silent to the caller. WARNING, not
        # ERROR: a lost effect row is a degraded audit trail, not a degraded
        # product, and paging on it would train people to ignore the page.
        try:
            logger.warning(
                "effects ledger: recording %r failed and was ignored", kind, exc_info=True
            )
        except Exception:
            pass
        return None
