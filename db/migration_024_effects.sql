-- ============================================================================
-- Migration 024: Effects Ledger — what a turn actually changed
-- ============================================================================
--
-- Today nobody can answer "what did the bot change when it produced that
-- resignation letter?" without reading logs. The pieces exist but none of them
-- answers the question:
--
--   activity_logs      one row per HUMAN HTTP action, written only from
--                      app/main.py handlers. `details` is English prose
--                      ("Updated person id=5"), there is no turn id, no target
--                      identity and no before value. Critically, the agent's
--                      own write paths — smart_doc.record_document,
--                      people_sync.sync_company_people, save_discovery — never
--                      call log_activity at all, so the effects that most need
--                      explaining are absent from it.
--   email_logs         one outbound email, already turn-adjacent via session_id
--   document_versions  one generated .docx
--   template_versions  one uploaded template
--
-- WHY A NEW TABLE RATHER THAN EXTENDING activity_logs
-- ---------------------------------------------------
-- Extending it is technically viable — turn_id, target_table, target_id, op,
-- before_image, after_image, reversible could all be added additively as
-- nullable columns and this migration would be shorter. It was rejected for
-- three reasons, in order of weight:
--
--   1. DIFFERENT RETENTION. activity_logs is an audit trail: append-only,
--      never rewritten, kept indefinitely. before-images are bulk — a
--      companies row carries JSONB directors/members — and must be purgeable
--      on a timer. Purging them would mean a scheduled UPDATE that nulls
--      columns of the audit table, which is exactly the operation an audit
--      table is supposed to forbid. Two lifecycles, two tables.
--   2. DIFFERENT GRAIN. activity_logs is one row per request. The ledger is
--      N rows per turn with an ordering (seq) that undo must replay in
--      reverse. Adding a seq to a table where ~30 existing call sites would
--      write NULL makes the column meaningless for every one of them.
--   3. DIFFERENT FAILURE BUDGET. activity_logs carries an FK to users(id).
--      Any FK is a way for an insert to abort, and this ledger must never be
--      able to abort the thing it is describing (see below). The ledger takes
--      no foreign keys at all — deliberately, not by omission.
--
-- activity_logs is left exactly as it is. This migration adds nothing to it.
--
-- NO FOREIGN KEYS, ANYWHERE
-- -------------------------
-- effect_log.turn_id is NOT foreign-keyed to effect_turns, and actor_email is
-- text rather than a users(id) reference. An FK means a missing or late parent
-- row turns a ledger insert into an error, and an errored ledger insert inside
-- a caller's transaction poisons that transaction: Postgres marks it aborted
-- and every subsequent statement the CALLER issues fails with "current
-- transaction is aborted". That is the ledger breaking the thing it records.
-- The writer also opens its own connection for the same reason; the schema
-- here just removes the second way it could have happened.
--
-- There is deliberately no UNIQUE (turn_id, seq) either. Ordering integrity is
-- worth less than never dropping an effect: a retry that reused a seq would
-- hit the constraint, and since the writer swallows its own errors by design
-- the row would vanish silently. A duplicate seq is legible; a missing effect
-- is not.
--
-- BEFORE-IMAGES ARE STORED, FIELD-SCOPED AND CAPPED
-- -------------------------------------------------
-- An effect row that says only "person 42 updated" is a notification, not a
-- record — it can be read but never reversed, which defeats the stated point
-- of the table. So before_image is stored, with two limits that keep the cost
-- bounded:
--   * field-scoped: for an UPDATE only the columns the write actually touched
--     appear in before_image/after_image, not the whole row. The dominant
--     effect by volume — document generation — is an INSERT, whose before
--     image is NULL, so the common case costs nothing.
--   * capped: the writer refuses to store an image over 64 KB. It substitutes
--     a truncation marker AND sets reversible = FALSE. A truncated before
--     image that still claimed to be reversible would produce a WRONG undo,
--     which is worse than no undo at all.
-- Deletes are the one place a full row is stored: there is no smaller image
-- that is still correct, and deletes are rare.
--
-- Everything below is inert until SCOUT_EFFECTS_LEDGER=1. With the flag unset
-- these tables exist and stay empty.
-- ============================================================================

-- One row per agent turn. A header, not a parent: effect rows are complete on
-- their own and are never blocked by this row being absent.
CREATE TABLE IF NOT EXISTS effect_turns (
    turn_id      VARCHAR(64) PRIMARY KEY,
    session_id   VARCHAR(255),
    actor_email  VARCHAR(255),
    started_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ended_at     TIMESTAMP,

    -- ★ A HINT, NEVER THE ANSWER. Agent turns stream: under BaseHTTPMiddleware
    -- `call_next` returns once the response headers are ready, so the turn
    -- scope closes while the agent is still emitting tokens and still calling
    -- tools. Effects recorded during that tail DO carry the right turn_id —
    -- the ContextVar was copied into the downstream task — but they land after
    -- close_turn has already stamped this column. Any per-turn audit view must
    -- read COUNT(*) FROM effect_log WHERE turn_id = ..., not this. Kept only
    -- because a cheap lower bound is useful for a list view.
    effect_count INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_effect_turns_session
    ON effect_turns (session_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_effect_turns_started
    ON effect_turns (started_at DESC);

-- One row per side effect.
CREATE TABLE IF NOT EXISTS effect_log (
    id                  BIGSERIAL PRIMARY KEY,

    -- Turn scope. turn_id groups the effects of one agent turn; seq orders
    -- them so an undo can replay in reverse. session_id joins to
    -- email_logs.session_id, which is the same conversation identifier the
    -- email approval gate (migration 019) already records.
    turn_id             VARCHAR(64) NOT NULL,
    seq                 INTEGER NOT NULL DEFAULT 0,
    session_id          VARCHAR(255),
    actor_email         VARCHAR(255),
    tool_name           VARCHAR(128),

    -- What happened, in a vocabulary a UI can group on rather than prose:
    -- 'document.generated', 'email.queued', 'person.created',
    -- 'person.updated', 'company.updated', 'template.uploaded', ...
    kind                VARCHAR(64) NOT NULL,

    -- How it happened, which is what decides whether it can be reversed:
    --   insert   — a row was created; undo deletes it
    --   update   — a row was modified; undo restores before_image
    --   delete   — a row was removed; undo re-inserts before_image
    --   external — something outside this database moved: a file written, an
    --              S3 object uploaded, an email queued for a human to send.
    --              Never reversible from this table alone.
    op                  VARCHAR(16) NOT NULL,

    -- Which record. target_id is TEXT, not INTEGER, because targets are not
    -- all integer keys — a generated .docx is identified by its path.
    target_table        VARCHAR(63),
    target_id           TEXT,
    target_label        TEXT,

    -- Field-scoped, capped. NULL before_image on an insert is correct and
    -- expected, and does not mean "unknown".
    before_image        JSONB,
    after_image         JSONB,

    -- Set by the writer, not inferred at read time. FALSE is the default
    -- because an effect nothing has proven reversible must not read as
    -- reversible.
    reversible          BOOLEAN NOT NULL DEFAULT FALSE,
    irreversible_reason TEXT,

    -- The ledger records its own reversals too, rather than deleting the row.
    undone_at           TIMESTAMP,
    undone_by_email     VARCHAR(255),

    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- op is a closed set; a typo'd op would make an effect invisible to every
-- reversibility query. This is the one constraint worth an insert failing on,
-- and it can only fail on a code bug, never on data or ordering.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'chk_effect_log_op' AND table_name = 'effect_log'
    ) THEN
        ALTER TABLE effect_log ADD CONSTRAINT chk_effect_log_op
            CHECK (op IN ('insert', 'update', 'delete', 'external'));
    END IF;
END $$;

-- The per-turn audit view: every effect of one turn, in order.
CREATE INDEX IF NOT EXISTS idx_effect_log_turn
    ON effect_log (turn_id, seq);

-- "What happened recently", and the conversation view.
CREATE INDEX IF NOT EXISTS idx_effect_log_created
    ON effect_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_effect_log_session
    ON effect_log (session_id, created_at DESC);

-- "What has ever touched person 42" — the question an admin asks when a
-- register entry looks wrong.
CREATE INDEX IF NOT EXISTS idx_effect_log_target
    ON effect_log (target_table, target_id);

-- The undo candidate list. Partial, because the rows that can still be
-- reversed are a small and shrinking fraction of the table.
CREATE INDEX IF NOT EXISTS idx_effect_log_undoable
    ON effect_log (created_at DESC)
    WHERE reversible AND undone_at IS NULL;

-- ============================================================================
-- RETENTION (no job is scheduled by this migration; recorded here so the
-- purge, when it is written, nulls the bulk columns and keeps the audit line
-- rather than deleting the row):
--
--   UPDATE effect_log
--      SET before_image = NULL, after_image = NULL,
--          reversible = FALSE,
--          irreversible_reason = 'images purged by retention policy'
--    WHERE created_at < NOW() - INTERVAL '90 days'
--      AND (before_image IS NOT NULL OR after_image IS NOT NULL);
--
-- Note it clears `reversible` in the same statement. A row whose image has
-- been purged but still reads reversible = TRUE would offer an undo that
-- cannot be performed.
-- ============================================================================

-- ============================================================================
-- REVERSE (commented; run by hand only):
--
--   DROP INDEX IF EXISTS idx_effect_log_undoable;
--   DROP INDEX IF EXISTS idx_effect_log_target;
--   DROP INDEX IF EXISTS idx_effect_log_session;
--   DROP INDEX IF EXISTS idx_effect_log_created;
--   DROP INDEX IF EXISTS idx_effect_log_turn;
--   ALTER TABLE effect_log DROP CONSTRAINT IF EXISTS chk_effect_log_op;
--   DROP TABLE IF EXISTS effect_log;
--   DROP INDEX IF EXISTS idx_effect_turns_started;
--   DROP INDEX IF EXISTS idx_effect_turns_session;
--   DROP TABLE IF EXISTS effect_turns;
--   DELETE FROM schema_migrations WHERE filename = 'migration_024_effects.sql';
-- ============================================================================
