"""
Effects ledger — the side effects one agent turn actually caused.
=================================================================

WHAT THIS ANSWERS
    "What did the bot actually change when it produced that resignation
    letter?" — without reading logs. One turn, every consequence, in order,
    each with the record it touched and the value that record held before.

WHY IT IS NOT activity_logs
    ``activity_logs`` is one row per human HTTP action, with an English prose
    ``details`` column and no turn id, no target identity and no before value.
    More decisively, the agent's own write paths never call it: neither
    ``smart_doc.record_document`` nor ``people_sync.sync_company_people`` nor
    ``save_discovery`` logs anything there, so the effects that most need
    explaining are the ones it does not contain. The full argument, including
    what extending it would have cost, is in
    ``db/migration_024_effects.sql``.

FLAG
    ``SCOUT_EFFECTS_LEDGER=1``. Default OFF. With it unset, ``record`` returns
    on its first line, ``turn_scope`` yields None without minting an id, and no
    module in this package imports psycopg or opens a connection.

USE
    from scout.effects import record, turn_scope

    with turn_scope(session_id=sid, actor_email=email):
        path = generate(...)
        record(
            "document.generated", "insert",
            target_table="documents", target_id=doc_id,
            target_label=f"{template} — {company}",
            after={"file_name": name, "file_path": path},
            tool_name="generate_document",
        )

GUARANTEE
    ``record`` never raises and never touches the caller's transaction. See
    ``recorder.py`` and ``sink.py`` — both halves are needed and neither alone
    is sufficient.
"""

from __future__ import annotations

from scout.effects.flag import FLAG_ENV, ledger_enabled
from scout.effects.model import (
    MAX_IMAGE_BYTES,
    OPS,
    Effect,
    EffectError,
    build_effect,
    decide_reversibility,
    diff_images,
    is_truncated,
)
from scout.effects.recorder import record
from scout.effects.sink import (
    MemorySink,
    NullSink,
    PostgresSink,
    get_sink,
    reset_sink,
    set_sink,
)
from scout.effects.turn import (
    TurnContext,
    ambient_session,
    bind_session,
    current_turn,
    current_turn_id,
    new_turn_id,
    turn_scope,
)

__all__ = [
    "FLAG_ENV",
    "MAX_IMAGE_BYTES",
    "OPS",
    "Effect",
    "EffectError",
    "MemorySink",
    "NullSink",
    "PostgresSink",
    "TurnContext",
    "ambient_session",
    "bind_session",
    "build_effect",
    "current_turn",
    "current_turn_id",
    "decide_reversibility",
    "diff_images",
    "get_sink",
    "is_truncated",
    "ledger_enabled",
    "new_turn_id",
    "record",
    "reset_sink",
    "set_sink",
    "turn_scope",
]
