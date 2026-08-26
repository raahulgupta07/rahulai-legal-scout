"""
Persistence for routines. Every DB import is LAZY and every entry point is
flag-gated.

`import scout.routines.store` must succeed on a laptop with no psycopg, no
database and no agno — that is why `db.connection` is imported inside each
function rather than at module top. The tests in tests/tracker_routines.py
import this module and assert exactly that.

With LEGAL_SCOUT_ROUTINES off, every function here returns without opening a
connection. A layer that is switched off should not be holding a connection
from the pool to discover it has nothing to do.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from scout.routines.engine import routines_enabled
from scout.routines.model import Routine, RoutineInput, RoutineStep

_log = logging.getLogger("legalscout")


def _conn():
    """Open a connection. Imported here, not at module scope — see the header."""
    from db.connection import get_db_conn

    return get_db_conn()


# ---------------------------------------------------------------------------
# Catalogue sync
# ---------------------------------------------------------------------------
def sync_catalog(routines: list[Routine] | None = None) -> dict[str, Any]:
    """UPSERT the source catalogue into the routine tables.

    Idempotent: routines are matched by `name`, steps and inputs by
    (routine_id, key). Steps and inputs are DELETEd and rewritten rather than
    merged, because a step removed from the source catalogue must disappear
    from the DB — an UPSERT-only sync leaves a deleted step in place forever,
    still ordered into the sequence, and no read path would ever show it as
    stale.

    `enabled` is NOT overwritten on an existing row. An admin who turned a
    routine on must not have it turned off again by the next deploy; the
    catalogue owns the DEFINITION, the database owns the DECISION. New rows
    take the catalogue's `enabled`, which is False for every routine that
    ships.
    """
    if not routines_enabled():
        return {"synced": 0, "skipped": "flag off"}

    if routines is None:
        from scout.routines.catalog import CATALOG

        routines = CATALOG

    conn = None
    synced = 0
    try:
        conn = _conn()
        cur = conn.cursor()
        for routine in routines:
            cur.execute(
                """
                INSERT INTO routines
                    (name, title, description, skill_name, version, enabled, source, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, now())
                ON CONFLICT (name) DO UPDATE SET
                    title       = EXCLUDED.title,
                    description = EXCLUDED.description,
                    skill_name  = EXCLUDED.skill_name,
                    version     = EXCLUDED.version,
                    source      = EXCLUDED.source,
                    updated_at  = now()
                RETURNING id
                """,
                (
                    routine.name,
                    routine.title,
                    routine.description,
                    routine.skill,
                    routine.version,
                    routine.enabled,
                    routine.source,
                ),
            )
            routine_id = cur.fetchone()[0]

            cur.execute("DELETE FROM routine_inputs WHERE routine_id = %s", (routine_id,))
            for inp in routine.inputs:
                cur.execute(
                    """
                    INSERT INTO routine_inputs
                        (routine_id, input_key, label, kind, required, source_hint, notes)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        routine_id,
                        inp.key,
                        inp.label,
                        inp.kind,
                        inp.required,
                        inp.source_hint,
                        inp.notes,
                    ),
                )

            cur.execute("DELETE FROM routine_steps WHERE routine_id = %s", (routine_id,))
            for step in routine.ordered_steps():
                cur.execute(
                    """
                    INSERT INTO routine_steps
                        (routine_id, step_no, step_key, title, tool_name, tool_args,
                         requires, produces, done_when, optional, notes)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        routine_id,
                        step.no,
                        step.key,
                        step.title,
                        step.tool,
                        json.dumps(step.args or {}),
                        json.dumps(list(step.requires)),
                        json.dumps(list(step.produces)),
                        json.dumps({"kind": step.done_when}),
                        step.optional,
                        step.notes,
                    ),
                )
            synced += 1
        conn.commit()
        return {"synced": synced}
    except Exception as e:  # pragma: no cover - needs a database
        if conn:
            conn.rollback()
        _log.warning("routines: sync_catalog failed: %s", e)
        return {"synced": 0, "error": str(e)}
    finally:
        if conn:
            conn.close()


# ---------------------------------------------------------------------------
# Reading routines back
# ---------------------------------------------------------------------------
def load_routines(enabled_only: bool = True) -> list[Routine]:
    """Rebuild Routine objects from the tables.

    Returns [] — never raises — when routines are off, the tables do not exist,
    or the database is unreachable. A read path that raises on a missing
    optional table turns a switched-off feature into a 500.

    Triggers are not persisted (they live in the source catalogue), so a
    routine loaded from the DB matches nothing by phrase. That is deliberate:
    the DB is the record of DEFINITION and PROGRESS, and the matcher's phrase
    list is source-controlled where it can be reviewed in a diff.
    """
    if not routines_enabled():
        return []

    conn = None
    try:
        conn = _conn()
        cur = conn.cursor()
        where = "WHERE enabled = TRUE" if enabled_only else ""
        cur.execute(
            f"""
            SELECT id, name, title, description, skill_name, version, enabled, source
            FROM routines {where} ORDER BY name
            """
        )
        rows = cur.fetchall()

        out: list[Routine] = []
        for rid, name, title, desc, skill, version, enabled, source in rows:
            cur.execute(
                """
                SELECT input_key, label, kind, required, source_hint, notes
                FROM routine_inputs WHERE routine_id = %s ORDER BY id
                """,
                (rid,),
            )
            inputs = [
                RoutineInput(
                    key=r[0],
                    label=r[1],
                    kind=r[2],
                    required=bool(r[3]),
                    source_hint=r[4],
                    notes=r[5] or "",
                )
                for r in cur.fetchall()
            ]

            cur.execute(
                """
                SELECT step_no, step_key, title, tool_name, tool_args,
                       requires, produces, done_when, optional, notes
                FROM routine_steps WHERE routine_id = %s ORDER BY step_no
                """,
                (rid,),
            )
            steps = []
            for r in cur.fetchall():
                done_when = r[7] or {}
                if isinstance(done_when, str):
                    done_when = json.loads(done_when)
                steps.append(
                    RoutineStep(
                        key=r[1],
                        no=float(r[0]),
                        title=r[2],
                        tool=r[3],
                        args=_as_json(r[4], {}),
                        requires=_as_json(r[5], []),
                        produces=_as_json(r[6], []),
                        done_when=str(done_when.get("kind") or "produced"),
                        optional=bool(r[8]),
                        notes=r[9] or "",
                    )
                )

            out.append(
                Routine(
                    name=name,
                    title=title,
                    description=desc or "",
                    skill=skill,
                    version=version,
                    enabled=bool(enabled),
                    source=source,
                    inputs=inputs,
                    steps=steps,
                )
            )
        cur.close()
        return out
    except Exception as e:  # pragma: no cover - needs a database
        _log.warning("routines: load_routines failed: %s", e)
        return []
    finally:
        if conn:
            conn.close()


def _as_json(value: Any, default: Any) -> Any:
    """psycopg returns JSONB already decoded; a text column arrives as str."""
    if value is None:
        return default
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return default
    return value


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------
def start_run(
    routine: Routine,
    session_id: str = "",
    company_name: str = "",
    state: dict[str, Any] | None = None,
) -> int | None:
    """Open a run row and return its id, or None when routines are off."""
    if not routines_enabled():
        return None
    conn = None
    try:
        conn = _conn()
        cur = conn.cursor()
        cur.execute("SELECT id FROM routines WHERE name = %s", (routine.name,))
        row = cur.fetchone()
        if not row:
            return None
        cur.execute(
            """
            INSERT INTO routine_runs
                (routine_id, routine_name, session_id, company_name, status, state)
            VALUES (%s, %s, %s, %s, 'running', %s)
            RETURNING id
            """,
            (row[0], routine.name, session_id or "", company_name or "", json.dumps(state or {})),
        )
        run_id = cur.fetchone()[0]
        conn.commit()
        return run_id
    except Exception as e:  # pragma: no cover - needs a database
        if conn:
            conn.rollback()
        _log.warning("routines: start_run failed: %s", e)
        return None
    finally:
        if conn:
            conn.close()


def record_event(
    run_id: int,
    step: RoutineStep,
    status: str,
    detail: dict[str, Any] | None = None,
    state: dict[str, Any] | None = None,
) -> bool:
    """Append one step event and move the run's cursor.

    Append-only: a retried step writes a second row rather than overwriting the
    first, so "this was attempted three times" stays visible.
    """
    if not routines_enabled():
        return False
    conn = None
    try:
        conn = _conn()
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO routine_step_events
                (run_id, step_no, step_key, status, tool_name, detail)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (run_id, step.no, step.key, status, step.tool, json.dumps(detail or {})),
        )
        if state is None:
            cur.execute(
                "UPDATE routine_runs SET current_step = %s, updated_at = now() WHERE id = %s",
                (step.key, run_id),
            )
        else:
            cur.execute(
                """
                UPDATE routine_runs
                SET current_step = %s, state = %s, updated_at = now()
                WHERE id = %s
                """,
                (step.key, json.dumps(state), run_id),
            )
        conn.commit()
        return True
    except Exception as e:  # pragma: no cover - needs a database
        if conn:
            conn.rollback()
        _log.warning("routines: record_event failed: %s", e)
        return False
    finally:
        if conn:
            conn.close()


def finish_run(run_id: int, status: str = "done", error: str = "") -> bool:
    if not routines_enabled():
        return False
    conn = None
    try:
        conn = _conn()
        cur = conn.cursor()
        cur.execute(
            """
            UPDATE routine_runs
            SET status = %s, error = %s, finished_at = now(), updated_at = now()
            WHERE id = %s
            """,
            (status, error or "", run_id),
        )
        conn.commit()
        return True
    except Exception as e:  # pragma: no cover - needs a database
        if conn:
            conn.rollback()
        _log.warning("routines: finish_run failed: %s", e)
        return False
    finally:
        if conn:
            conn.close()


def load_run(run_id: int) -> dict[str, Any] | None:
    """Read a run back, state included — the resume path."""
    if not routines_enabled():
        return None
    conn = None
    try:
        conn = _conn()
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, routine_name, session_id, company_name, status,
                   current_step, state, error
            FROM routine_runs WHERE id = %s
            """,
            (run_id,),
        )
        row = cur.fetchone()
        cur.close()
        if not row:
            return None
        return {
            "id": row[0],
            "routine_name": row[1],
            "session_id": row[2],
            "company_name": row[3],
            "status": row[4],
            "current_step": row[5],
            "state": _as_json(row[6], {}),
            "error": row[7],
        }
    except Exception as e:  # pragma: no cover - needs a database
        _log.warning("routines: load_run failed: %s", e)
        return None
    finally:
        if conn:
            conn.close()
