"""Every SQL statement the memory layer runs, as builders.

Kept apart from store.py for one reason: the tests execute THESE EXACT
STRINGS. A scope test that asserts against a hand-written query proves
nothing about the query production runs, so there is only one copy.

Each builder returns ``(sql, params)``. Nothing here opens a connection
or imports a driver.
"""

from __future__ import annotations

TABLE = "company_memory"

VALID_CATEGORIES = ("fact", "convention", "correction", "preference")

#: Columns a read hands back, in order. Shared so store.py's row->dict
#: mapping and the SELECT text can never drift apart.
READ_COLUMNS = (
    "id",
    "company_id",
    "user_email",
    "memory_key",
    "memory_value",
    "category",
    "confidence",
    "revision",
    "active",
    "source",
    "source_session_id",
    "source_run_id",
    "created_by_email",
    "superseded_at",
    "superseded_by_email",
    "created_at",
    "updated_at",
)

_COLS = ", ".join(READ_COLUMNS)

# ---------------------------------------------------------------------------
# The scope predicate
# ---------------------------------------------------------------------------
# ★ This fragment is the security boundary. It is defined ONCE and every
# read and write concatenates it, so there is no query in this module that
# can be shipped without it. `company_id = %s` is an equality on the NOT
# NULL foreign key; the user clause widens visibility to company-wide rows
# but never past the company.
_SCOPE_WHERE = "company_id = %s AND (user_email IS NULL OR user_email = %s)"

# Writes address exactly one owner slot, not "mine plus everyone's".
_OWNER_WHERE = "company_id = %s AND COALESCE(user_email, '') = COALESCE(%s, '')"


def _scope_params(scope):
    return [scope.company_id, scope.user_email]


def _owner_params(scope):
    return [scope.company_id, scope.user_email]


def select_active(scope, key=None, category=None, limit=50):
    """Live memories visible in this scope."""
    sql = "SELECT %s FROM %s WHERE %s AND active" % (_COLS, TABLE, _SCOPE_WHERE)
    params = _scope_params(scope)
    if key is not None:
        sql += " AND memory_key = %s"
        params.append(key)
    if category is not None:
        sql += " AND category = %s"
        params.append(category)
    sql += " ORDER BY memory_key ASC, id ASC LIMIT %s"
    params.append(int(limit))
    return sql, params


def select_history(scope, key):
    """Every revision of one key, oldest first, superseded rows included."""
    sql = (
        "SELECT %s FROM %s WHERE %s AND memory_key = %%s "
        "ORDER BY revision ASC, id ASC" % (_COLS, TABLE, _SCOPE_WHERE)
    )
    params = _scope_params(scope)
    params.append(key)
    return sql, params


def select_owned_active(scope, key):
    """The one live row a write is about to supersede, if it exists."""
    sql = "SELECT id, revision FROM %s WHERE %s AND memory_key = %%s AND active" % (
        TABLE,
        _OWNER_WHERE,
    )
    params = _owner_params(scope)
    params.append(key)
    return sql, params


def supersede(scope, key, actor_email):
    """Retire the live row for this key. Scope-bound like every other write."""
    sql = (
        "UPDATE %s SET active = FALSE, superseded_at = CURRENT_TIMESTAMP, "
        "superseded_by_email = %%s, updated_at = CURRENT_TIMESTAMP "
        "WHERE %s AND memory_key = %%s AND active" % (TABLE, _OWNER_WHERE)
    )
    params = [actor_email]
    params.extend(_owner_params(scope))
    params.append(key)
    return sql, params


def insert(scope, key, value, category, confidence, revision, source,
           session_id, run_id, author_email):
    """Insert a new live revision.

    company_id is a positional column, never defaulted — the INSERT does
    not compile without it.
    """
    sql = (
        "INSERT INTO %s ("
        "company_id, user_email, memory_key, memory_value, category, confidence, "
        "revision, active, source, source_session_id, source_run_id, created_by_email"
        ") VALUES (%%s, %%s, %%s, %%s, %%s, %%s, %%s, TRUE, %%s, %%s, %%s, %%s)" % TABLE
    )
    params = [
        scope.company_id,
        scope.user_email,
        key,
        value,
        category,
        confidence,
        revision,
        source,
        session_id,
        run_id,
        author_email,
    ]
    return sql, params


def count_active(scope):
    """Row count visible in this scope — what the scope tests assert on."""
    sql = "SELECT COUNT(*) FROM %s WHERE %s AND active" % (TABLE, _SCOPE_WHERE)
    return sql, _scope_params(scope)


#: Every SCOPED builder, for the test that proves none of them can be called
#: without a scope predicate. Resolver builders are deliberately NOT here:
#: their job is to FIND a company, so they cannot already know one.
ALL_BUILDERS = (
    "select_active",
    "select_history",
    "select_owned_active",
    "supersede",
    "insert",
    "count_active",
)


# ===========================================================================
# Resolver + session binding (migration 026)
# ===========================================================================
# These answer "which company is this?", so they take a name, not a scope.
# ★ Every one of them is an EQUALITY or an ESCAPED pattern. There is no
# unescaped `ILIKE '%' || x || '%'` anywhere in this module — see
# like_escape() below for why that matters.

SESSION_TABLE = "session_company"

#: Never return an unbounded candidate list to a model.
MAX_CANDIDATES = 25

#: LIKE metacharacters. `_` matches any single character and `%` matches any
#: run, so an unescaped needle silently widens the search. This is the same
#: class of bug as the delete-by-ILIKE at app/main.py:5223, where a company
#: name containing `_` took a sibling with it.
_LIKE_ESCAPE = "\\"


def like_escape(needle):
    """Escape a user/model string for safe use inside a LIKE pattern.

    Order matters: the escape character itself must be doubled FIRST, or the
    backslashes added for % and _ get escaped a second time.
    """
    text = str(needle or "")
    text = text.replace(_LIKE_ESCAPE, _LIKE_ESCAPE * 2)
    text = text.replace("%", _LIKE_ESCAPE + "%")
    text = text.replace("_", _LIKE_ESCAPE + "_")
    return text


_COMPANY_COLS = "id, company_name_english, company_registration_number"


def select_by_registration_number(registration_number):
    """Registration number is UNIQUE on companies — the only unambiguous key."""
    sql = (
        "SELECT %s FROM companies "
        "WHERE lower(trim(company_registration_number)) = %%s" % _COMPANY_COLS
    )
    return sql, [str(registration_number or "").strip().lower()]


def select_by_exact_name(name):
    """Case-insensitive exact name match.

    No LIMIT — the caller MUST be able to tell one row from two. A LIMIT 1
    here is exactly how the existing resolvers turn an ambiguity into a
    silent pick.
    """
    sql = (
        "SELECT %s FROM companies "
        "WHERE lower(trim(company_name_english)) = %%s "
        "ORDER BY id ASC" % _COMPANY_COLS
    )
    return sql, [str(name or "").strip().lower()]


def select_name_candidates(name, limit=MAX_CANDIDATES):
    """Substring candidates — for OFFERING a choice, never for picking one.

    ESCAPE is not optional: without it a name containing `_` or `%` matches
    companies it has nothing to do with.
    """
    sql = (
        "SELECT %s FROM companies "
        "WHERE company_name_english ILIKE %%s ESCAPE '%s' "
        "ORDER BY company_name_english ASC LIMIT %%s" % (_COMPANY_COLS, _LIKE_ESCAPE)
    )
    pattern = "%" + like_escape(str(name or "").strip()) + "%"
    return sql, [pattern, int(limit)]


def select_session_binding(session_id):
    """The company this conversation is already bound to, if any."""
    sql = (
        "SELECT sc.company_id, c.company_name_english, c.company_registration_number "
        "FROM %s sc JOIN companies c ON c.id = sc.company_id "
        "WHERE sc.session_id = %%s" % SESSION_TABLE
    )
    return sql, [str(session_id or "").strip()]


def upsert_session_binding(session_id, company_id, bound_by):
    """Bind, or re-bind when the conversation changes subject."""
    sql = (
        "INSERT INTO %s (session_id, company_id, bound_by) VALUES (%%s, %%s, %%s) "
        "ON CONFLICT (session_id) DO UPDATE SET "
        "company_id = EXCLUDED.company_id, bound_by = EXCLUDED.bound_by, "
        "bound_at = CURRENT_TIMESTAMP" % SESSION_TABLE
    )
    return sql, [str(session_id or "").strip(), int(company_id), bound_by]


def delete_session_binding(session_id):
    sql = "DELETE FROM %s WHERE session_id = %%s" % SESSION_TABLE
    return sql, [str(session_id or "").strip()]


#: Resolver builders, for the test that proves none of them carries a bare
#: LIMIT 1 over an ambiguous match.
RESOLVER_BUILDERS = (
    "select_by_registration_number",
    "select_by_exact_name",
    "select_name_candidates",
    "select_session_binding",
    "upsert_session_binding",
    "delete_session_binding",
)
