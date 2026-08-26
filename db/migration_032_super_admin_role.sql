-- A tier above `admin`.
--
-- The roles were user / editor / admin, with `admin` at the top. Asked for
-- repeatedly as "admin, super admin", which is a real distinction in a firm:
-- several people need to manage templates, companies and people day to day,
-- and far fewer should be able to change who can sign in at all.
--
-- `super_admin` is that second group. It is a strict superset of `admin` —
-- anything an administrator may do, a super administrator may do — so nothing
-- an existing admin account can do today stops working.
--
-- ⚠ The CHECK constraint is the reason this is a migration rather than a
-- one-line change. `chk_users_role` names the permitted values explicitly, so
-- until it is widened every attempt to create or promote a super_admin fails
-- with a constraint violation from the database, which surfaces as an opaque
-- 500 rather than anything an administrator could act on.
--
-- Nothing is promoted here. Widening what is ALLOWED and deciding who gets it
-- are separate acts, and the second one is the firm's to make: an existing
-- admin is promoted from Settings -> Users, deliberately, by a person.

ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_role;

ALTER TABLE users ADD CONSTRAINT chk_users_role
    CHECK (role IN ('user', 'editor', 'admin', 'super_admin'));
