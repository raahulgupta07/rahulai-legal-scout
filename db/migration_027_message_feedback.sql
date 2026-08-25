-- Migration 027: Per-message feedback (thumbs up / down)
-- ======================================================
--
-- WHY THIS EXISTS
-- ---------------
-- Nothing in this tree records whether an answer was any good. activity_logs
-- records HUMAN HTTP actions in English prose (migration 024's header
-- explains why that is not a signal), effect_log records what a turn CHANGED,
-- and agno's own ai.agno_sessions.runs JSONB records what was said. None of
-- them records what the reader thought of it. This table does, and only that.
--
-- SCOPE: STORAGE ONLY. No retraining loop, no prompt feedback, no retrieval
-- weighting reads this table. It is a ledger of opinions; wiring it into
-- anything is a separate, deliberate decision.
--
--
-- ★ WHAT IDENTIFIES A MESSAGE — MEASURED, THEN CORRECTED
-- ------------------------------------------------------
-- The obvious key is agno's own message id. It exists on the wire:
-- GET /sessions/{id}/runs returns runs[].run_id and runs[].messages[].id,
-- both UUIDs (verified against the running app, session
-- "E2E 1787578471 · L4 corporate consent").
--
-- It does NOT exist in the client that has to send the vote. agent-ui's
-- ChatMessage (agent-ui/src/types/os.ts:339-378) carries role, content,
-- reasoning_content, created_at, tool_calls, extra_data, attachments and
-- picker/ask_user cards — and NO id and NO run_id. The streaming path builds
-- those objects itself; the ids agno returns are dropped on the floor at parse
-- time. A schema keyed on AGNO's message id would be keyed on a value the only
-- caller cannot produce, and every vote would arrive with it NULL.
--
-- ★ The first cut of this table concluded from that "so the key must be the
-- array position" and made message_index the identity. That was wrong, and the
-- client author said so: MessageFeedback.tsx sends a message_id it DERIVES from
-- the fields ChatMessage does have. That string went through three shapes in
-- one afternoon and settled at TWO forms:
--
--     "<role>-<run_id>-<ordinal>"      "agent-ee31ccb8-…-0"  — the normal case
--     "<role>-<created_at>-<index>"    "agent-1787578850-3"  — fallback, now
--                                                              UNREACHABLE
--                                                              from the UI
--
-- Both parts of the normal form are load-bearing, and each was added because
-- the other one alone is wrong:
--   * run_id, not created_at, because created_at is stamped by whoever built
--     the message — a streamed message and its reloaded self can carry
--     different stamps, so a vote cast live stops restoring after a refresh.
--   * plus the ordinal, because a run is a whole TURN, and an ask_questions
--     pause RESUMES UNDER THE SAME run_id, so one run can produce two agent
--     bubbles. role+run_id alone would collide across them — verified against
--     this table: agent-<run>-0 and agent-<run>-1 insert as two rows, while
--     the same pair twice is refused by uq_message_feedback_vote.
--
-- Either way it beats the bare index: two messages at the same position in two
-- different renderings of a transcript get different ids, so a re-derived
-- transcript mismatches loudly (the vote simply does not restore) instead of
-- silently attaching to the wrong bubble. Identity is
--
--     (session_id, user_id, message_id)
--
-- ★★★ THE THIRD SEGMENT IS A RUN-LOCAL ORDINAL, NOT A TRANSCRIPT POSITION,
-- AND THE DIFFERENCE IS THE WHOLE POINT. It counts within one run_id AND role,
-- from 0. It was briefly the global transcript index, which is broken, because
-- the live and reloaded transcripts are DIFFERENT LENGTHS. Measured on this
-- tree:
--
--   useSessionLoader.tsx:319,389   pushes EXACTLY 2 messages per run —
--                                  one 'user', one 'agent'. Unconditional.
--   useAIStreamHandler.tsx:1070    the HITL resume adds a THIRD message,
--                                  role 'agent', with no user message, under
--                                  the same run_id.
--   MessageItem.tsx:151            buildMessageIds() — one counter per
--                                  (role, run_id) bucket, which is where the
--                                  ordinal now comes from. It was briefly
--                                  `messages.map((message, index) =>` in
--                                  Messages.tsx, i.e. the whole transcript.
--
-- So a turn containing one ask_questions pause is 3 messages live and 2 after
-- reload, and under a GLOBAL index every message after it shifted by one:
-- every later vote silently failed to restore (data LOSS, not mis-attachment —
-- run_id is in the key, so a shifted id cannot match another run's message).
-- Scoping the ordinal to (run_id, role) removes that cascade entirely: an
-- unpaused run now keys identically live and reloaded.
--
-- ★ THE RUN-LOCAL ORDINAL ALONE DOES NOT REMOVE MIS-ATTRIBUTION — it takes a
-- SECOND, client-side fix, and this was measured rather than reasoned. Live, a
-- paused run has two agent bubbles (ordinals 0 and 1); reloaded it has one
-- (ordinal 0), because the loader merges the pause and the resumption. So a
-- vote cast on the PAUSED bubble (0) restores onto the reloaded merged answer,
-- also ordinal 0, whose content is DIFFERENT — a vote attached to text the
-- reader never rated. Measured across the live-3/reload-2 transition on a
-- transcript with a run AFTER the paused turn:
--
--                    | global index          | run-local ordinal
--   -----------------+-----------------------+---------------------
--   card-skip OFF    | 1/3, 1 mis-attached   | 2/3, 1 MIS-ATTACHED
--   card-skip ON     | 1/3, 0 mis-attached   | 2/3, 0 mis-attached
--
-- The ordinal fixes the CASCADE (column 1 -> 2: later runs restore again). The
-- card-skip fixes the MIS-ATTRIBUTION (row 1 -> 2). Neither substitutes for
-- the other, and the cascade only shows up at all if the transcript contains a
-- run after the paused one — with just the paused run present, the broken
-- formula looks fine, which is a trap for anyone testing with one conversation.
--
-- BOTH ARE SHIPPED. Verified in the tree, not taken on trust:
--   MessageItem.tsx:151-167   buildMessageIds() — `ordinals` keyed on
--                             `${role}::${run_id ?? ''}`, so nothing outside
--                             that pair can move a message's ordinal.
--   Messages.tsx:549-551      isQuestionTurn = ask_user_requests.length > 0
--                             || picker_requests.length > 0
--   Messages.tsx:613,616      the control is inside
--                             `!isStillStreaming && hasContent` AND
--                             `{!isQuestionTurn && ( <MessageFeedback …> )}`,
--                             so a paused bubble never holds a vote and the
--                             ordinal-0 collision cannot be reached.
--
-- Remaining and accepted: `agent-<run>-1`, the bubble produced by resuming a
-- pause, has no rehydrated counterpart, so a vote on it is stored and never
-- found again. It fails as LOSS, never as a wrong answer, and is contained to
-- that one bubble. Irreducible without changing the loader, which is not worth
-- changing for this.
--
-- Nothing here can detect any of it: every row is present and well-formed.
-- Left recorded rather than worked around, because inventing a server-side
-- repair for a client-owned key is how the key stops being opaque.
--
-- ★ THE FALLBACK FORM IS NOT A STABLE KEY — GATED, NOT FIXED.
-- MessageFeedback.tsx:171 is `if (!sessionId || !runId) return null`, so
-- nothing renders without a run id and nothing can be stored under a
-- created_at key.
-- The form is kept in this comment because the column would happily accept one
-- if that gate is ever removed. It is used exactly when there is no run_id
-- yet — i.e. during streaming — and it keys on the created_at that the bullet
-- above rejects as unstable. A vote cast mid-stream is therefore stored under
-- the fallback id and looked up under the run_id id after the next reload: it
-- silently fails to restore, and nothing errors. The client's answer is to not
-- render the control until a run_id exists. Recorded here because from the
-- database's side this is invisible — the row is present and well-formed, it
-- is simply never read again.
--
-- ★ THE COLUMN IS OPAQUE. Nothing in this schema or in app/main.py parses,
-- splits, or validates the shape of message_id beyond non-blank and a length
-- cap — deliberately, because it has two forms today and its format belongs to
-- the frontend. Do not add a UUID cast, a regex CHECK, or a split_part() view:
-- the fallback form is not a UUID and would fail all three.
--
-- ★ WHY NOT KEY ON (session_id, run_id, role) INSTEAD, which the client also
-- has? Two reasons, either one sufficient. (1) The fallback form exists
-- precisely for messages that have NO run_id yet; keyed that way, every
-- run_id-less message in a session collapses to one key — one vote covering
-- all of them, each new vote overwriting the last. (2) An ask_questions pause
-- resumes under the same run_id, so even WITH a run_id that tuple collides
-- across the two agent bubbles of one turn. The composite absorbs both cases
-- because it carries the index; the tuple cannot.
--
-- Its remaining weakness, stated plainly: message_id is CLIENT-DERIVED, so its
-- meaning is a frontend convention this table cannot enforce. Change the
-- formula in MessageFeedback.tsx and every stored vote is orphaned — they will
-- not restore, and nothing will error. Treat that string as a contract. (The
-- run_id change above cost nothing only because the table was still empty when
-- it landed — measured, 0 rows.)
--
-- message_index and run_id are still stored, NULLABLE, for ordering and for
-- tracing a vote back to the turn that produced it. They are recorded, never
-- required, and never part of the identity.
--
--
-- WHY A FOREIGN KEY HERE, WHEN migration_024 REFUSED THEM
-- -------------------------------------------------------
-- effect_log takes no FKs because it is written from inside the caller's
-- transaction and an aborted insert would poison the thing it describes.
-- This table is the opposite: it is written by its own HTTP handler, in its
-- own transaction, and nothing depends on it succeeding. A vote by a deleted
-- user is not worth keeping, so users(id) ON DELETE CASCADE is right.
--
-- session_id is TEXT and NOT foreign-keyed, matching migration 026: agno owns
-- ai.agno_sessions in a different schema and prunes it independently.

CREATE TABLE IF NOT EXISTS message_feedback (
    id             SERIAL PRIMARY KEY,

    -- Agno's session id (ai.agno_sessions.session_id). TEXT, no FK — see above.
    session_id     TEXT NOT NULL,

    -- ★ THE identity column. Client-derived, two forms (see header). Opaque to
    -- this table — never parse it in SQL, the format is the frontend's to
    -- change.
    message_id     TEXT NOT NULL,

    -- Ordering and provenance. Nullable: the client sends neither today, and a
    -- vote is complete without them.
    message_index  INTEGER,
    run_id         TEXT,

    -- ★ Taken from the JWT by the handler, NEVER from the request body.
    -- A vote whose author the client got to choose is not attributable.
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Exactly two values. A third value ('meh', '', 'up ') would be invisible
    -- to every counting query while still occupying the unique slot for that
    -- message, so the vote would look cast and count for nothing.
    vote           VARCHAR(4) NOT NULL,

    -- Optional free text: "wrong company", "made up the section number".
    comment        TEXT,

    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_message_feedback_vote CHECK (vote IN ('up', 'down')),
    CONSTRAINT chk_message_feedback_session_nonblank
        CHECK (length(btrim(session_id)) > 0),
    -- ★ Non-blank AND capped. The cap is not tidiness: message_id is the third
    -- column of a btree UNIQUE index, and Postgres refuses an index entry over
    -- 1/3 of a page. Measured on this database — a 6,400-byte value gives
    --   ERROR: index row size 6432 exceeds btree version 4 maximum 2704
    -- which reaches the handler as a bare 500. Worse, the failure depends on
    -- COMPRESSIBILITY: repeat('x', 5000) stored fine because TOAST squashed it,
    -- while 6,400 bytes of md5 did not. A limit that only sometimes applies is
    -- not a limit. 255 is far above both real forms ("agent-" + a 36-char UUID
    -- is 42 characters).
    CONSTRAINT chk_message_feedback_message_nonblank
        CHECK (length(btrim(message_id)) > 0 AND length(message_id) <= 255),
    -- NULL is allowed (the client does not send it); a present value must be
    -- a real position.
    CONSTRAINT chk_message_feedback_index_nonneg
        CHECK (message_index IS NULL OR message_index >= 0)
);

-- ★ THE POINT OF THE TABLE. Changing your mind must UPDATE, not append: two
-- rows for one reader on one message would double-count in every aggregate and
-- leave no way to tell which one is current. This constraint is what the
-- handler's ON CONFLICT targets, so it is load-bearing, not defensive.
--
-- Named explicitly rather than declared inline as UNIQUE(...) because
-- ON CONFLICT ON CONSTRAINT needs the name, and a generated name
-- ("message_feedback_session_id_user_id_message_id_key") is not a name to
-- depend on. Guarded so a re-run is a no-op — ALTER TABLE ADD CONSTRAINT has
-- no IF NOT EXISTS.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'uq_message_feedback_vote'
          AND table_name = 'message_feedback'
    ) THEN
        ALTER TABLE message_feedback ADD CONSTRAINT uq_message_feedback_vote
            UNIQUE (session_id, user_id, message_id);
    END IF;
END $$;

-- "Show me my votes for this conversation" — the read the UI does on every
-- session load to restore highlighted thumbs. Covers the unique key's columns
-- from the other direction (user first), which is how the query filters.
CREATE INDEX IF NOT EXISTS idx_message_feedback_session_user
    ON message_feedback (user_id, session_id);

-- "What did people dislike lately" — the only aggregate this table is for
-- until something is actually built on top of it.
CREATE INDEX IF NOT EXISTS idx_message_feedback_vote_created
    ON message_feedback (vote, created_at DESC);


-- ---------------------------------------------------------------------------
-- ★ SESSION OWNERSHIP BACKFILL (Task 1) — deliberately in this migration
-- ---------------------------------------------------------------------------
-- ai.agno_sessions.user_id IS populated for sessions started from the browser:
-- agent-ui posts user_id as a form field (useAIStreamHandler.tsx:1259) and
-- agno persists it. Measured on this database before this migration:
--
--     user_id | count
--     --------+-------
--     1       |    57
--     (null)  |    13
--
-- The 13 NULLs are sessions created OUTSIDE the browser — e2e-*, test-slotfix-*,
-- routines-*, ledger-* driven by scripts that never sent a user_id, plus two
-- raw-UUID sessions predating that frontend line.
--
-- app/main.py now pins the session list to the authenticated caller
-- (AuthMiddleware sets request.state.user_id, which agno's session router
-- honours over the query parameter). Without this backfill those 13 rows would
-- belong to nobody and disappear from every sidebar — which would look exactly
-- like the ownership bug being fixed.
--
-- DECISION: backfill to the admin user rather than making NULL rows visible to
-- everyone. This deployment has exactly one account
-- (users: id=1, admin@legalscout.com, role=admin), so "created by someone who
-- was not logged in" and "created by user 1" describe the same human, and the
-- claim the backfill makes is true rather than merely convenient. The tradeoff:
-- on a future multi-user install a NULL row would be assigned to the lowest-id
-- admin, who may not have created it. That is why this is scoped to the row set
-- that exists NOW (it only touches rows already in the table) and why the
-- alternative — treating NULL as "visible to all" — was rejected: it would make
-- every unattributed session readable by every future user, permanently, which
-- is the more expensive mistake in a tree where a session title is a client's
-- literal company and director names.
--
-- Idempotent: after the first run there are no NULLs left, so the second run
-- updates 0 rows. Safe if ai.agno_sessions does not exist yet (a fresh install
-- that has not booted the app), because agno creates it on first start.
DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'ai' AND table_name = 'agno_sessions'
    ) THEN
        UPDATE ai.agno_sessions
           SET user_id = (
               SELECT id::text FROM users
                WHERE role = 'admin' AND is_active
                ORDER BY id LIMIT 1
           )
         WHERE user_id IS NULL
           AND EXISTS (SELECT 1 FROM users WHERE role = 'admin' AND is_active);
    END IF;
END $$;


-- ---------------------------------------------------------------------------
-- REVERSING DDL (commented — run by hand to roll this migration back, and
-- delete the matching row from schema_migrations afterwards). Note the
-- backfill above is NOT reversible: the pre-migration NULLs are not recorded
-- anywhere, and re-nulling every user_id = '1' row would unown 57 sessions
-- that were correctly owned before this migration ran.
-- ---------------------------------------------------------------------------
-- DROP INDEX IF EXISTS idx_message_feedback_vote_created;
-- DROP INDEX IF EXISTS idx_message_feedback_session_user;
-- ALTER TABLE message_feedback DROP CONSTRAINT IF EXISTS uq_message_feedback_vote;
-- DROP TABLE IF EXISTS message_feedback;
-- DELETE FROM schema_migrations WHERE filename = 'migration_027_message_feedback.sql';
