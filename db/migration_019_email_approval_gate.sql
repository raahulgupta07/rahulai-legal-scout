-- Require a human to approve every outbound email.
--
-- send_email_tool connected to SMTP and sent, immediately, on the agent's own
-- decision. The agent chose the recipient address, the subject, the body and
-- which generated document to attach, and nothing stood between that choice and
-- delivery: no confirmation, no audit row, no record that a send had even been
-- considered. A misread instruction, or text the model picked up from a
-- document it was reading, was enough to mail a client's corporate filing to an
-- address nobody had approved. Outbound email cannot be recalled.
--
-- The tool now QUEUES. Delivery happens only from an endpoint carrying the
-- user's own JWT, triggered by the user clicking Send — an action the model
-- cannot perform, because it has no session and no token. That distinction is
-- the whole point: an approval the agent can grant itself is not an approval.
--
-- email_logs already carried the right columns, so queued rows live alongside
-- sent ones rather than in a parallel table. Three columns are added to record
-- who decided and when, and which conversation asked.

ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS session_id VARCHAR(255);
ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS decided_at TIMESTAMP;
ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS decided_by_email VARCHAR(255);

-- status was free text defaulting to 'sent'. It now carries the gate's state:
--   queued    — the agent asked; nobody has approved it yet
--   sent      — a signed-in user pressed Send and SMTP accepted it
--   failed    — a user approved it and delivery failed
--   discarded — a user rejected it
--
-- Existing rows predate the gate and were all delivered without one, so they
-- keep whatever status they have. No backfill pretends they were approved.
CREATE INDEX IF NOT EXISTS idx_email_logs_status_created
    ON email_logs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_logs_session
    ON email_logs (session_id, created_at DESC);
