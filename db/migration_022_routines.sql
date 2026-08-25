-- Migration 022 — routines: the executable half of a legal skill
--
-- WHAT ALREADY EXISTS, AND WHY THIS IS NOT A PARALLEL CONCEPT
-- ----------------------------------------------------------
-- `legal_skills` (migration 013, seeded by 014, repaired by 021) is already
-- half of what a routine is, and the half it has is the half that is hard to
-- get right: WHEN a sequence applies. Its `description` column is the L1
-- trigger text injected into the system prompt, its `body` is the L2 playbook
-- the model reads after load_skill(name), and its `enabled` flag is the switch
-- the admin UI already exposes. None of that is rebuilt here.
--
-- What `legal_skills` does NOT have is structure. A body says, in prose:
--
--     ## Workflow (Scout tools)
--     1. `get_company`, then `get_directors` to show the current board.
--     2. Identify the resigning director from the board list.
--     ...
--     5. Generate the chain: `find_matching_templates` -> `prepare_document` ->
--        `preview_doc` -> `generate_document`, letter first.
--
-- That is a five-step sequence with named tools and an ordering constraint, and
-- nothing in the system can read it as one. It cannot be enumerated, so no UI
-- can show progress. Its tool names cannot be checked against the registry,
-- which is exactly how `preview_document` and `list_tracked_documents` sat dead
-- inside six bodies until migration 021 rewrote them by regex. Its required
-- inputs cannot be collected up front, so the model asks for them one at a time
-- as it discovers them. And because "step 3 happened" exists nowhere but in the
-- conversation transcript, an interrupted sequence can only be resumed by a
-- model re-reading its own history and guessing.
--
-- So: routines are the same objects, given a spine.
--
--   legal_skills.name        the trigger, the description, the prose rationale
--   routines.skill_name  ->  points AT that row; a routine formalises a skill
--   routine_steps            the numbered list inside the body, as rows
--   routine_inputs           what the body asks the user to confirm, as rows
--   routine_runs / _events   what actually happened, so it can be resumed
--
-- `routines.skill_name` is a soft reference (a plain VARCHAR, no FK) on
-- purpose. `legal_skills.name` is user-editable from the admin Skills tab and
-- skills can be disabled; a hard FK would either block a skill rename or
-- cascade-delete a routine's whole run history when a skill is tidied away. A
-- routine whose skill is gone is inspectable and reportable; a routine that was
-- silently deleted is not. The reader resolves it by name and tolerates NULL.
--
-- DEFAULT OFF
-- -----------
-- `routines.enabled` defaults to FALSE, and separately the whole layer is gated
-- by the LEGAL_SCOUT_ROUTINES environment flag (scout/routines/engine.py:
-- routines_enabled()). Two switches, because they answer different questions:
-- the flag says "does this product have routines at all", the column says
-- "is THIS routine ready". Creating these tables changes nothing on its own —
-- with no rows and the flag unset, every read path returns empty and the prompt
-- is byte-identical to today.
--
-- IDEMPOTENT: every object is IF NOT EXISTS and this file inserts no rows.
-- Pure DDL by design — the catalogue lives in scout/routines/catalog.py as
-- Python data and is UPSERTed into these tables by store.sync_catalog(). Seed
-- INSERTs were considered and rejected: migration 014 seeds skill bodies and
-- migration 021 then had to rewrite them by regex, because a row seeded once by
-- a migration can never be corrected except by another migration.
--
-- `schema_migrations` is stamped by the runner (db/migrate.py:apply_migration
-- inserts the filename after cur.execute(sql)), never by the migration itself:
-- a file that stamped its own row would double-insert and violate
-- UNIQUE(filename) when re-run by hand.


-- ---------------------------------------------------------------------------
-- routines — one row per named, inspectable sequence
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS routines (
    id           SERIAL PRIMARY KEY,
    name         VARCHAR(64) UNIQUE NOT NULL,
    title        VARCHAR(200) NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    -- The legal_skills.name this routine formalises. Soft reference: NULL is
    -- allowed, a dangling name is allowed, and neither is an error.
    skill_name   VARCHAR(64),
    version      VARCHAR(16) NOT NULL DEFAULT '1.0.0',
    enabled      BOOLEAN NOT NULL DEFAULT FALSE,
    source       VARCHAR(16) NOT NULL DEFAULT 'catalog',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_routines_enabled ON routines (enabled);
CREATE INDEX IF NOT EXISTS idx_routines_skill_name ON routines (skill_name);


-- ---------------------------------------------------------------------------
-- routine_inputs — what the sequence needs BEFORE it can run
-- ---------------------------------------------------------------------------
-- Declaring these is the point. Today the model discovers a missing input at
-- the step that needs it, which is why new-company setup asks for the meeting
-- date once per template (CLAUDE.md, "Known open"). A routine can be asked
-- "what do you still need" before step 1.
CREATE TABLE IF NOT EXISTS routine_inputs (
    id           SERIAL PRIMARY KEY,
    routine_id   INTEGER NOT NULL REFERENCES routines (id) ON DELETE CASCADE,
    input_key    VARCHAR(64) NOT NULL,
    label        VARCHAR(200) NOT NULL,
    -- company | template | person | date | choice | text
    kind         VARCHAR(24) NOT NULL DEFAULT 'text',
    required     BOOLEAN NOT NULL DEFAULT TRUE,
    -- Where the value is expected to come from: register | company | user |
    -- derived. A hint for the UI and for the ask step, never an authority.
    source_hint  VARCHAR(24) NOT NULL DEFAULT 'user',
    notes        TEXT NOT NULL DEFAULT '',
    UNIQUE (routine_id, input_key)
);

CREATE INDEX IF NOT EXISTS idx_routine_inputs_routine ON routine_inputs (routine_id);


-- ---------------------------------------------------------------------------
-- routine_steps — the numbered list inside a skill body, as rows
-- ---------------------------------------------------------------------------
-- step_no is NUMERIC(6,2), not INTEGER, for the same reason the training
-- pipeline has a step 5.5: a step gets inserted between two others and the
-- numbers in every stored log and every screenshot must not shift underneath
-- it. `step_key` is the stable identity; `step_no` is only the order.
CREATE TABLE IF NOT EXISTS routine_steps (
    id           SERIAL PRIMARY KEY,
    routine_id   INTEGER NOT NULL REFERENCES routines (id) ON DELETE CASCADE,
    step_no      NUMERIC(6,2) NOT NULL,
    step_key     VARCHAR(64) NOT NULL,
    title        VARCHAR(200) NOT NULL,
    -- The tool this step calls, spelled exactly as the live registry spells it
    -- (scout/agent.py:_registered_tool_names). NULL for a step that is an ask,
    -- a confirmation or a human gate rather than a tool call.
    tool_name    VARCHAR(64),
    -- Argument template: {"company_name": "$company_name"} — a "$key" value is
    -- read from run state, anything else is a literal.
    tool_args    JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Input keys that must be present in run state before this step may run.
    requires     JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- State keys this step writes when it succeeds.
    produces     JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- What counts as done. {"kind":"produced"} = every key in `produces` is
    -- present in state. {"kind":"manual"} = a human confirmed it.
    -- {"kind":"always"} = informational, never blocks.
    done_when    JSONB NOT NULL DEFAULT '{"kind": "produced"}'::jsonb,
    optional     BOOLEAN NOT NULL DEFAULT FALSE,
    notes        TEXT NOT NULL DEFAULT '',
    UNIQUE (routine_id, step_no),
    UNIQUE (routine_id, step_key)
);

CREATE INDEX IF NOT EXISTS idx_routine_steps_routine ON routine_steps (routine_id, step_no);


-- ---------------------------------------------------------------------------
-- routine_runs — one attempt at a routine
-- ---------------------------------------------------------------------------
-- session_id scopes a run to a conversation for the same reason migration 017
-- scoped party_selections to one: without it, a run started in one chat is
-- resumable from another, and the measured consequence of getting that wrong
-- was a director chosen in one conversation landing in another's minutes.
CREATE TABLE IF NOT EXISTS routine_runs (
    id              SERIAL PRIMARY KEY,
    routine_id      INTEGER NOT NULL REFERENCES routines (id) ON DELETE CASCADE,
    routine_name    VARCHAR(64) NOT NULL,
    session_id      VARCHAR(128) NOT NULL DEFAULT '',
    company_name    VARCHAR(255) NOT NULL DEFAULT '',
    -- pending | running | done | failed | abandoned
    status          VARCHAR(16) NOT NULL DEFAULT 'pending',
    current_step    VARCHAR(64) NOT NULL DEFAULT '',
    -- Resolved inputs plus everything the steps have produced. This is what
    -- makes a run resumable without a model: the plan is recomputed from the
    -- routine definition and this dict, not recovered from a transcript.
    state           JSONB NOT NULL DEFAULT '{}'::jsonb,
    error           TEXT NOT NULL DEFAULT '',
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_routine_runs_session ON routine_runs (session_id, status);
CREATE INDEX IF NOT EXISTS idx_routine_runs_routine ON routine_runs (routine_id, started_at DESC);


-- ---------------------------------------------------------------------------
-- routine_step_events — append-only record of what each step did
-- ---------------------------------------------------------------------------
-- Append-only on purpose. A retried step writes a second row rather than
-- overwriting the first, so "this was attempted three times" is visible. The
-- run's current position lives on routine_runs; this table is the history.
CREATE TABLE IF NOT EXISTS routine_step_events (
    id           SERIAL PRIMARY KEY,
    run_id       INTEGER NOT NULL REFERENCES routine_runs (id) ON DELETE CASCADE,
    step_no      NUMERIC(6,2) NOT NULL,
    step_key     VARCHAR(64) NOT NULL,
    -- started | done | skipped | failed | blocked
    status       VARCHAR(16) NOT NULL,
    tool_name    VARCHAR(64),
    detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_routine_step_events_run ON routine_step_events (run_id, occurred_at);


-- ---------------------------------------------------------------------------
-- REVERSE — exact DROP statements, run in this order
-- ---------------------------------------------------------------------------
-- The child tables are dropped first even though every FK carries ON DELETE
-- CASCADE: cascade governs row deletes, not DROP TABLE, so dropping `routines`
-- first fails with "cannot drop table routines because other objects depend on
-- it". The indexes go with their tables and need no separate DROP.
--
--   DROP TABLE IF EXISTS routine_step_events;
--   DROP TABLE IF EXISTS routine_runs;
--   DROP TABLE IF EXISTS routine_steps;
--   DROP TABLE IF EXISTS routine_inputs;
--   DROP TABLE IF EXISTS routines;
--   DELETE FROM schema_migrations WHERE filename = 'migration_022_routines.sql';
--
-- The last line is required. db/migrate.py:get_pending_migrations() reads
-- schema_migrations, so dropping the tables without clearing the row leaves the
-- runner believing 022 is applied and it will never be re-run.
