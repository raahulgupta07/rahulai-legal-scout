-- Migration 023: Durable per-company memory
-- ==========================================
--
-- WHY A NEW TABLE (and not a fourth parallel store)
-- -------------------------------------------------
-- Four stores already hold "things the agent knows". None of them can answer
-- "what do we know about company X" without a free-text convention:
--
--   knowledge_raw / knowledge_lookup / knowledge_vec
--       Ingest-derived rows from uploaded Excel/CSV/Word. The only scope
--       column is `source_file VARCHAR(255)`, and company scope is smuggled
--       into it as the STRING "company:<name>" by add_company()
--       (scout/tools/knowledge_base.py:685). It is a naming convention, not a
--       key: nothing constrains it, a rename orphans every row, and
--       search_knowledge() (knowledge_base.py:461) filters on key_value ONLY
--       — it never restricts source_file at all.
--
--   company_field_registry + companies.custom_fields  (migration 010)
--       Typed TEMPLATE FIELD values discovered by training. Correct for
--       "what goes in the {{auditor_name}} blank"; it has no room for a fact,
--       no provenance, and no revision history.
--
--   agno_memories / scout_learnings  (created by Agno, enable_agentic_memory=True)
--       Scoped by user_id and NOTHING ELSE. scout/agent.py:1240-1275 tells the
--       model to save company-specific quirks here ("City Holdings Limited is
--       stored as ..."), and search_learnings then serves that row back while
--       the same user works on a different client. Agno owns the schema, so a
--       company scope cannot be added to it.
--
-- So: the scope key this feature needs does not exist anywhere. One new table,
-- with the scope key as a NOT NULL foreign key rather than an optional filter.
--
-- Flag-gated: nothing reads or writes this table unless LEGAL_SCOUT_MEMORY is
-- set truthy. Applying this migration alone changes no behaviour.

CREATE TABLE IF NOT EXISTS company_memory (
    id                  BIGSERIAL PRIMARY KEY,

    -- ---- SCOPE KEY -------------------------------------------------------
    -- NOT NULL + FK, deliberately. A memory cannot exist unattached to a
    -- company, a caller cannot forget to supply it, and deleting the company
    -- takes its memories with it.
    company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

    -- Second scope axis. NULL = visible to everyone working on this company.
    -- Non-NULL = private to that one user. Never cross-company either way.
    user_email          TEXT,

    memory_key          TEXT NOT NULL,
    memory_value        TEXT NOT NULL,
    category            TEXT NOT NULL DEFAULT 'fact',
    confidence          REAL,

    -- ---- REVISION / SOFT SUPERSEDE ---------------------------------------
    -- Re-remembering a key does not UPDATE. The old row flips active=FALSE and
    -- stays put, so the trail of what was believed, when, and on whose word is
    -- readable. History is inactive rows in this table — no second table.
    active              BOOLEAN NOT NULL DEFAULT TRUE,
    revision            INTEGER NOT NULL DEFAULT 1,

    -- ---- PROVENANCE ------------------------------------------------------
    source              TEXT NOT NULL DEFAULT 'chat',
    source_session_id   TEXT,
    source_run_id       TEXT,
    created_by_email    TEXT,
    superseded_at       TIMESTAMP,
    superseded_by_email TEXT,

    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_company_memory_category
        CHECK (category IN ('fact', 'convention', 'correction', 'preference')),
    CONSTRAINT chk_company_memory_key_nonblank
        CHECK (length(btrim(memory_key)) > 0)
);

-- One live value per (company, owner, key). COALESCE because NULL never
-- equals NULL in a unique index, so without it a company-wide key could be
-- written twice. Partial on `active` so superseded revisions can pile up.
CREATE UNIQUE INDEX IF NOT EXISTS uq_company_memory_active_key
    ON company_memory (company_id, (COALESCE(user_email, '')), memory_key)
    WHERE active;

-- Every read path leads with company_id.
CREATE INDEX IF NOT EXISTS idx_company_memory_scope
    ON company_memory (company_id, active);

CREATE INDEX IF NOT EXISTS idx_company_memory_key
    ON company_memory (company_id, memory_key);

-- History reads walk one key's revisions oldest-first.
CREATE INDEX IF NOT EXISTS idx_company_memory_history
    ON company_memory (company_id, memory_key, revision);


-- ---------------------------------------------------------------------------
-- REVERSING DDL (commented — run by hand to roll this migration back, and
-- delete the matching row from schema_migrations afterwards)
-- ---------------------------------------------------------------------------
-- DROP INDEX IF EXISTS idx_company_memory_history;
-- DROP INDEX IF EXISTS idx_company_memory_key;
-- DROP INDEX IF EXISTS idx_company_memory_scope;
-- DROP INDEX IF EXISTS uq_company_memory_active_key;
-- DROP TABLE IF EXISTS company_memory;
-- DELETE FROM schema_migrations WHERE filename = 'migration_023_memory.sql';
