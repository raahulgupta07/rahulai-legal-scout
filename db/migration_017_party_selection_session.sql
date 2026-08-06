-- Scope picker selections to the conversation that made them.
--
-- Without this column the read-back in slot_resolver._parties_from_picker_log
-- matched on company + picker + slot_kind inside a 30-minute window, with no
-- notion of WHICH conversation the pick belonged to. Measured consequence
-- (2026-08-06): a director chosen in one chat reappeared, unasked, in a
-- different chat 24 minutes later. The second conversation was asked for the
-- name as free text, the answer was left blank, and the generated minutes still
-- read "It is proposed that SOE MOE THU ... be appointed as a Director" —
-- a person nobody in that conversation had named, in a legal document, with no
-- warning. The name came from the stale row; the NRC came from the blank
-- answer, so the two halves of one person's identity resolved from different
-- sources.
--
-- The earlier slot_kind column closed cross-ROLE bleed. This closes
-- cross-SESSION bleed.
--
-- Existing rows get '' and will no longer resolve. That is deliberate: the
-- correct fallback is for the agent to ask again. They age out of the
-- 30-minute window shortly after deploy in any case.

ALTER TABLE party_selections
    ADD COLUMN IF NOT EXISTS session_id TEXT NOT NULL DEFAULT '';

-- Read-back is always "the newest pick for this company, picker and kind
-- WITHIN THIS SESSION".
CREATE INDEX IF NOT EXISTS idx_party_selections_session
    ON party_selections (LOWER(company_name), picker, session_id, created_at DESC);
