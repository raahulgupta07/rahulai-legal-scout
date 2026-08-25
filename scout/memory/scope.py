"""The scope key, and the one place it is validated.

Every public store function takes a :class:`MemoryScope` as its FIRST
positional argument. There is no keyword-with-a-default form and no
"global company" fallback, so a caller cannot reach the table without
having said which company it is asking about.
"""

from __future__ import annotations


class MemoryScopeError(ValueError):
    """Raised when a scope is missing, malformed or unusable.

    Deliberately an error and not a silent empty result: a read that
    quietly returns [] for a broken scope reads as "this company knows
    nothing", which is the wrong answer and an invisible one.
    """


def _clean_email(value):
    if value is None:
        return None
    if not isinstance(value, str):
        raise MemoryScopeError(f"user_email must be a string or None, got {type(value).__name__}")
    cleaned = value.strip().lower()
    return cleaned or None


class MemoryScope(object):
    """(company_id, user_email) — the key every row is filed under.

    ``company_id`` is required and must be a positive integer; it maps to
    the NOT NULL foreign key ``company_memory.company_id``.

    ``user_email`` is the reader/writer identity. It is NOT a filter the
    caller may omit to see everything: a read returns company-wide rows
    (user_email IS NULL) plus this user's own private rows, and nothing
    else.
    """

    __slots__ = ("company_id", "user_email")

    def __init__(self, company_id, user_email=None):
        self.company_id = _coerce_company_id(company_id)
        self.user_email = _clean_email(user_email)

    def __repr__(self):
        return "MemoryScope(company_id=%r, user_email=%r)" % (self.company_id, self.user_email)

    def __eq__(self, other):
        if not isinstance(other, MemoryScope):
            return NotImplemented
        return (self.company_id, self.user_email) == (other.company_id, other.user_email)

    def __hash__(self):
        return hash((self.company_id, self.user_email))


def _coerce_company_id(value):
    """Accept an int or an all-digit string; reject everything else.

    bool is rejected explicitly — ``True`` is an int in Python and would
    otherwise scope every write to company 1.
    """
    if value is None:
        raise MemoryScopeError("company_id is required — memory is never company-less")
    if isinstance(value, bool):
        raise MemoryScopeError("company_id must be an integer, not a bool")
    if isinstance(value, int):
        company_id = value
    elif isinstance(value, str):
        text = value.strip()
        if not text.isdigit():
            raise MemoryScopeError(f"company_id must be a positive integer, got {value!r}")
        company_id = int(text)
    else:
        raise MemoryScopeError(f"company_id must be an integer, got {type(value).__name__}")
    if company_id <= 0:
        raise MemoryScopeError(f"company_id must be positive, got {company_id}")
    return company_id


def require_scope(scope):
    """Validate and return a scope, or raise.

    Called at the top of every store function. Accepts an already-built
    MemoryScope; anything else — including a bare int, which would be an
    easy way to lose the user axis by accident — is refused.
    """
    if not isinstance(scope, MemoryScope):
        raise MemoryScopeError(
            "scope must be a MemoryScope, got %s — build one with "
            "MemoryScope(company_id=..., user_email=...)" % type(scope).__name__
        )
    # Re-validate: __slots__ attributes are writable, so a scope could have
    # been mutated after construction.
    _coerce_company_id(scope.company_id)
    return scope
