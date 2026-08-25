-- Migration 026: Session -> company binding
-- =========================================
--
-- WHY THIS EXISTS
-- ---------------
-- migration_023 filed memories under companies.id, a real key. Nothing in the
-- product can supply that key from a chat turn.
--
-- Measured on this tree: the only conversation-scoped binding is
-- slot_resolver.session_scope (scout/tools/slot_resolver.py:52-69), and it
-- carries session_id and NOTHING else — its source is agno's RunContext
-- (`getattr(run_context, "session_id", "")`, smart_doc.py:59), which has no
-- company on it. A company reaches a tool only as a string the model typed,
-- and that string is re-resolved 8 separate times across 6 files, 4 different
-- ways, none of them agreeing:
--
--   smart_doc.py:1385        all ILIKE matches, tiered exact -> prefix -> all
--   people_picker.py:123     exact, else ILIKE ORDER BY LENGTH ASC LIMIT 1
--   knowledge_tools.py       ILIKE LIMIT 1, NO ORDER BY — nondeterministic
--     (:63, :101, :120, :214 — three of these back registered agent tools)
--   slot_resolver.py:702     ILIKE LIMIT 1, no ordering
--   party_selections         no resolution at all; the key is LOWER(name)
--
-- This table is the durable answer to "which company is this conversation
-- about", written ONCE per session by a strict resolver that refuses to guess
-- (scout/memory/resolve.py), and read on every turn after.
--
-- ★ THE CHEAP VERSION OF THIS WHOLE FEATURE ALREADY EXISTS AND IS DISCARDED.
--   people_picker._company_row returns companies.id as its first column
--   (:127), the caller unpacks it (:330), and the picker card payload ships it
--   to the frontend as {"company": {"id": ...}} (:337, :383). Then
--   _record_selection (:723-770) persists company_name as TEXT and drops the
--   id on the floor. Any session that has used a picker has already had the
--   correct key in hand. Keeping it there — one INSERT into this table at
--   :826 — would bind most real conversations for free. Not done here:
--   people_picker.py is not this agent's file.
--
-- Flag-gated by LEGAL_SCOUT_MEMORY like everything else in scout/memory.
-- Applying this migration alone changes no behaviour: nothing reads or writes
-- this table with the flag off.

CREATE TABLE IF NOT EXISTS session_company (
    -- Agno's session id. TEXT, not a FK: agno owns agno_sessions and rows can
    -- be pruned there independently. A binding for a vanished session is inert,
    -- not corrupt — it is only ever read by that same session id.
    session_id  TEXT PRIMARY KEY,

    -- ---- THE KEY THIS WHOLE FEATURE EXISTS TO CARRY ----------------------
    -- NOT NULL + FK + CASCADE, matching company_memory.company_id. A binding
    -- to a deleted company is deleted, never left dangling at an id that a
    -- later SERIAL could reissue to a different client.
    company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

    bound_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    bound_by    TEXT,

    CONSTRAINT chk_session_company_session_nonblank
        CHECK (length(btrim(session_id)) > 0)
);

-- "Which sessions are bound to this company" — used when a company is being
-- deleted or merged, and by the cascade above.
CREATE INDEX IF NOT EXISTS idx_session_company_company
    ON session_company (company_id);


-- ---------------------------------------------------------------------------
-- REVERSING DDL (commented — run by hand to roll this migration back, and
-- delete the matching row from schema_migrations afterwards)
-- ---------------------------------------------------------------------------
-- DROP INDEX IF EXISTS idx_session_company_company;
-- DROP TABLE IF EXISTS session_company;
-- DELETE FROM schema_migrations WHERE filename = 'migration_026_session_company.sql';
