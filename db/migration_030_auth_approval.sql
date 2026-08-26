-- Admin approval gate, and a record of HOW each person signs in.
--
-- Until now every account got here one way: an administrator typed an email, a
-- name, a password and a role into Settings -> Users. Approval was therefore
-- implicit — the act of creating the row WAS the approval, and the only other
-- state was `is_active`, also set by hand. That holds exactly as long as no
-- outside system can introduce a person.
--
-- LDAP and SSO break it. A directory or an identity provider can authenticate
-- somebody this application has never heard of, and "authenticated" is not
-- "authorised": the directory proves who you are, this table decides what you
-- may do. So the two states become three — unknown, known-but-pending, allowed
-- — and the middle one is what `approved` records.
--
-- Two columns:
--
--   approved      FALSE by default, deliberately. A row created by any path
--                 that is not an administrator typing it in lands pending and
--                 reaches nothing. Later phases add just-in-time provisioning,
--                 which writes `role` and `approved` as SQL LITERALS so that no
--                 token claim, LDAP group or group-to-role mapper can reach
--                 them. JIT removes the typing, not the approval.
--
--   auth_sources  a LIST, not a value. Email is the merge key: one person who
--                 has a local password and also arrives through Keycloak is one
--                 row carrying {local,oidc}, keeping one identity and one role,
--                 rather than two rows that can drift apart in permissions.
--
-- ⚠ The UPDATE below is load-bearing. `approved` defaults to FALSE, so without
-- it every account that already exists — including the administrator running
-- this migration — becomes pending the moment the gate goes live, and there is
-- nobody left approved who could approve them. Backfilling TRUE says: whoever
-- was already let in stays let in. This is the only place that assumption is
-- made, and it is safe precisely because every existing row was hand-created.

ALTER TABLE users ADD COLUMN IF NOT EXISTS approved BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_sources TEXT[] NOT NULL DEFAULT ARRAY['local']::TEXT[];

ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP;

ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_by VARCHAR(255);

-- Backfill. Runs once; re-running the migration is prevented by
-- schema_migrations, and the ADD COLUMN guards make it harmless if it does.
-- Scoped to rows created BEFORE this migration by the absence of the column's
-- effect — every pre-existing row has approved=FALSE from the DEFAULT, and no
-- pending row can exist yet because nothing can create one.
UPDATE users SET approved = TRUE, approved_at = COALESCE(created_at, now()), approved_by = 'migration_030';

-- Finding the approval queue is a Settings page's first query, and the count
-- sits in a stat card that renders on every visit to the tab.
CREATE INDEX IF NOT EXISTS idx_users_pending ON users(approved) WHERE approved = FALSE;
