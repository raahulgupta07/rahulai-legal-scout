"""What this conversation is currently trying to produce.

Measured on session 3be25e3c (2026-08-25, on 1.2.20): the agent found the right
template, previewed it, took approval, was correctly told to pick the signing
directors, ran the picker — and then lost the thread and called
`list_templates`, starting over. Its own reasoning said so: "Now I am trying to
determine what the next logical step would be... I'm checking the original
context". Seven model calls, 754,577 tokens, and no document.

The goal lived nowhere but in the model's attention, and at ~32,000 input
tokens per call that is the first thing to go. This module puts it on the
server (db/migration_028_active_task.sql).

Two jobs:

1. `recall_task` lets any tool that could be the last step before generation
   end its result with the pending goal, so "what was I doing" is answered by
   the tool output rather than by memory.

2. `collected` accumulates field values across calls. `custom_data` does NOT
   accumulate between generate_document calls — whatever the model omits is
   BLANK in the document — and requiring the model to re-send everything is a
   rule prose cannot enforce; it was the direct cause of documents shipping
   with unnamed companies (1.2.14, 1.2.18). Accumulating server-side removes
   the requirement instead of restating it.

Every function is best-effort: a failure here degrades to today's behaviour
(the model carries its own context) and must never break a generation. The DB
error is logged, not raised.
"""

import json
import logging

_logger = logging.getLogger("legalscout")

# A conversation that has not touched its task in this long has moved on. The
# same backstop party_selections uses, and for the same reason: it is a
# staleness bound, not the guard. Session scope is the guard.
_TASK_TTL_MINUTES = 60

# Never carried in `collected`. Company identity comes from the record, and
# letting it round-trip through here would let a stale value outlive a
# correction (the PROTECTED_FIELDS reasoning in smart_doc, applied to storage).
_NEVER_COLLECT = frozenset(
    {
        "company_name",
        "company_name_english",
        "company_registration_number",
        "registered_office",
        "registered_office_address",
        "status",
        "company_type",
        # Party slots belong to party_selections, which is keyed by slot_kind and
        # already solves the right-person-right-role problem this table does not.
        "directors",
        "members",
        "shareholders",
    }
)


def _conn():
    from db.connection import get_db_conn

    return get_db_conn()


def remember_task(
    session_id: str,
    template_name: str,
    company_name: str,
    values: dict | None = None,
) -> None:
    """Record (or refresh) what this conversation is producing.

    `template_name` must be the RESOLVED filename, never the caller's spelling,
    so a read-back cannot reintroduce the prefix ambiguity of 1.2.15.

    Values MERGE into whatever is already stored — a later call that carries
    only the party names must not erase an earlier call's subscription amount.
    """
    session_id = str(session_id or "").strip()
    template_name = str(template_name or "").strip()
    company_name = str(company_name or "").strip()
    if not (session_id and template_name and company_name):
        return

    merged = {
        str(k): v
        for k, v in (values or {}).items()
        if str(k).lower() not in _NEVER_COLLECT and not isinstance(v, (list, dict))
    }

    conn = None
    try:
        conn = _conn()
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO active_task (session_id, template_name, company_name, collected)
                 VALUES (%s, %s, %s, %s::jsonb)
            ON CONFLICT (session_id) DO UPDATE
                    SET template_name = EXCLUDED.template_name,
                        company_name  = EXCLUDED.company_name,
                        -- || merges right over left: newer values win, older
                        -- keys survive. That is the whole point.
                        collected     = active_task.collected || EXCLUDED.collected,
                        updated_at    = CURRENT_TIMESTAMP
            """,
            (session_id, template_name, company_name, json.dumps(merged)),
        )
        conn.commit()
        cur.close()
    except Exception as e:
        _logger.warning(f"[TASK] remember failed for session {session_id}: {e}")
    finally:
        if conn is not None:
            conn.close()


def merge_collected(session_id: str, values: dict) -> int:
    """Add answers to an EXISTING task. Returns the number of rows updated.

    UPDATE-only on purpose. `active_task` requires a template and a company, and
    the card that produced these answers knows neither — it only knows what the
    user typed. If no task has been recorded yet there is nothing to attach the
    answers to, and inventing a row with placeholder values would be worse than
    holding nothing.
    """
    session_id = str(session_id or "").strip()
    if not session_id or not isinstance(values, dict):
        return 0
    clean = {
        str(k): v
        for k, v in values.items()
        if str(k).lower() not in _NEVER_COLLECT and not isinstance(v, (list, dict)) and str(v or "").strip()
    }
    if not clean:
        return 0

    conn = None
    try:
        conn = _conn()
        cur = conn.cursor()
        cur.execute(
            """
            UPDATE active_task
               SET collected  = collected || %s::jsonb,
                   updated_at = CURRENT_TIMESTAMP
             WHERE session_id = %s
            """,
            (json.dumps(clean), session_id),
        )
        n = cur.rowcount
        conn.commit()
        cur.close()
        return n
    except Exception as e:
        _logger.warning(f"[TASK] merge_collected failed for {session_id}: {e}")
        return 0
    finally:
        if conn is not None:
            conn.close()


def recall_task(session_id: str) -> dict | None:
    """The pending task for this conversation, or None."""
    session_id = str(session_id or "").strip()
    if not session_id:
        return None

    conn = None
    try:
        conn = _conn()
        cur = conn.cursor()
        cur.execute(
            f"""
            SELECT template_name, company_name, collected
              FROM active_task
             WHERE session_id = %s
               AND updated_at > NOW() - INTERVAL '{_TASK_TTL_MINUTES} minutes'
            """,
            (session_id,),
        )
        row = cur.fetchone()
        cur.close()
    except Exception as e:
        _logger.warning(f"[TASK] recall failed for session {session_id}: {e}")
        return None
    finally:
        if conn is not None:
            conn.close()

    if not row:
        return None
    collected = row[2]
    if isinstance(collected, str):
        try:
            collected = json.loads(collected)
        except (ValueError, TypeError):
            collected = {}
    return {
        "template_name": row[0],
        "company_name": row[1],
        "collected": collected if isinstance(collected, dict) else {},
    }


def clear_task(session_id: str) -> None:
    """Forget the task. Called once the document exists."""
    session_id = str(session_id or "").strip()
    if not session_id:
        return
    conn = None
    try:
        conn = _conn()
        cur = conn.cursor()
        cur.execute("DELETE FROM active_task WHERE session_id = %s", (session_id,))
        conn.commit()
        cur.close()
    except Exception as e:
        _logger.warning(f"[TASK] clear failed for session {session_id}: {e}")
    finally:
        if conn is not None:
            conn.close()


def pending_task_instruction(session_id: str) -> str:
    """One sentence naming the unfinished goal, for a tool result to end with.

    Empty string when there is no task — the caller appends unconditionally and
    an empty string adds nothing. This is addressed to the MODEL, so it names
    the tool and the arguments rather than describing the situation.
    """
    task = recall_task(session_id)
    if not task:
        return ""
    return (
        " STILL PENDING IN THIS CONVERSATION: produce "
        f'"{task["template_name"]}" for {task["company_name"]}. That is what '
        "the user asked for and it is NOT done. Do not call list_templates, "
        "find_matching_templates or any other search tool — the template is "
        "already chosen. Your next call is generate_document(template_name="
        f'"{task["template_name"]}", company_name="{task["company_name"]}") '
        "with the selection you just made. Values already collected are "
        "remembered on the server; you do not need to re-send them."
    )
