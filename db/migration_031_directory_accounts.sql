-- Let an account exist without a Legal Scout password.
--
-- `hashed_password` has been NOT NULL since the first schema, which was right
-- while the only way to sign in was a password this application stored. It
-- stops being right the moment a directory can prove who somebody is: the
-- entire point of LDAP sign-in is that the person's password lives in Active
-- Directory and NOT here, so an administrator creating a directory-only account
-- has no password to type and no business inventing one.
--
-- Working around it by generating a random password would be worse than it
-- looks. That value is a real, valid local credential — it authenticates, it is
-- never rotated because nobody knows it exists, and it quietly re-opens the
-- local sign-in path for an account whose whole purpose was to close it.
--
-- ⚠ Dropping NOT NULL is only safe because the local path was hardened in the
-- same change. `verify_password` refuses a NULL or empty hash outright, and
-- `auth_login` refuses a row with no local hash before it ever reaches bcrypt.
-- Without those two, a NULL here means "bcrypt.checkpw(pw, None)" — a
-- TypeError caught by the surrounding handler, which is a 500 on a wrong
-- password at best, and at worst an exception path nobody has read. The column
-- change and the guards belong to each other; do not port one without the
-- other.

ALTER TABLE users ALTER COLUMN hashed_password DROP NOT NULL;

-- Nothing is backfilled. Every existing row has a real hash and keeps it: this
-- migration widens what is ALLOWED, and changes no account that exists.
