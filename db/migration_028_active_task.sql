-- Migration 028: What this conversation is currently trying to produce
-- ====================================================================
--
-- WHY THIS EXISTS
-- ---------------
-- Measured on a real session (3be25e3c, 2026-08-25 03:50, on 1.2.20). The user
-- asked for a Corporate Shareholder Consent. The agent found the template,
-- previewed it, got approval, called generate_document, was correctly told to
-- pick the signing directors, ran the picker — and then, in its own words:
--
--     "Now I am trying to determine what the next logical step would be.
--      Should I proceed with the task or report this successful action?
--      I'm checking the original context..."
--
-- ...and called list_templates. It started over. Seven model calls, 754,577
-- tokens, $0.198, and no document.
--
-- Nothing on the server remembered what the conversation was for.
-- `session_state` is {}. party_selections (migration_012/017) remembers WHO was
-- chosen but not WHAT is being made, and only for person slots. Between the
-- pause and the resume, the goal lived nowhere but in the model's attention —
-- and at ~32,000 input tokens per call, that is the first thing to go.
--
-- This table is the goal itself, written when a document is prepared and read
-- back by every tool that could be the last step before generation.
--
-- IT ALSO CLOSES A SECOND HOLE.
-- `custom_data` does not accumulate between generate_document calls: whatever
-- the model omits from the next call is BLANK in the document (1.2.14/1.2.18).
-- Making the MODEL re-send every value each time is a rule that prose cannot
-- enforce — it was the direct cause of documents shipping with unnamed
-- companies. `collected` below accumulates those values SERVER-side, so a
-- second call carrying only the party names no longer loses the first call's
-- subscription amount.

CREATE TABLE IF NOT EXISTS active_task (
    -- Agno's session id. TEXT, not a FK: agno owns agno_sessions and prunes it
    -- independently. A task for a vanished session is inert, not corrupt — it
    -- is only ever read by that same session id.
    session_id    TEXT PRIMARY KEY,

    -- The document being produced. Stored as the RESOLVED template filename
    -- (smart_doc._resolve_template_name), never the caller's spelling, so a
    -- read-back cannot reintroduce the prefix-name ambiguity of 1.2.15.
    template_name TEXT NOT NULL,
    company_name  TEXT NOT NULL,

    -- Field values gathered so far, merged across calls. NOT the party slots —
    -- those stay in party_selections, which is keyed by slot_kind and already
    -- solves the "right person, right role" problem this table does not.
    collected     JSONB NOT NULL DEFAULT '{}'::jsonb,

    started_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_active_task_session_nonblank
        CHECK (length(btrim(session_id)) > 0),
    CONSTRAINT chk_active_task_template_nonblank
        CHECK (length(btrim(template_name)) > 0),
    CONSTRAINT chk_active_task_company_nonblank
        CHECK (length(btrim(company_name)) > 0)
);

-- Reads are always by session_id (the primary key), so no further index is
-- needed. This one supports the staleness sweep only.
CREATE INDEX IF NOT EXISTS idx_active_task_updated
    ON active_task (updated_at);


-- ---------------------------------------------------------------------------
-- REVERSING DDL (commented — run by hand to roll this migration back, and
-- delete the matching row from schema_migrations afterwards)
-- ---------------------------------------------------------------------------
-- DROP INDEX IF EXISTS idx_active_task_updated;
-- DROP TABLE IF EXISTS active_task;
-- DELETE FROM schema_migrations WHERE filename = 'migration_028_active_task.sql';
