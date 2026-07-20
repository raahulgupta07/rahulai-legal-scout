"""
Placeholder Pattern
===================

Single definition of the template placeholder syntax used across template
analysis and document filling.

Supported forms: ``{{field}}``, ``{field}``, ``[field]`` and the bare ``[]``
slot. Bare slots carry no name, so they are given a positional identity
(``_empty_1``, ``_empty_2``, ...) in document order.
"""

import itertools
import re
from typing import Iterator

PLACEHOLDER_PATTERN = re.compile(r"\{\{([^}]+)\}\}|\{([^}]+)\}|\[([^\]]*)\]")

EMPTY_PLACEHOLDER_PREFIX = "_empty_"


def new_empty_counter() -> Iterator[int]:
    """Counter for naming bare ``[]`` slots in document order."""
    return itertools.count(1)


def placeholder_name(groups, empty_counter=None) -> str:
    """Resolve a regex match's groups to a placeholder name.

    Returns "" for a bare slot when no counter is supplied, preserving the
    previous behaviour for callers that only handle named placeholders.
    """
    name = (groups[0] or groups[1] or groups[2] or "").strip()
    if name:
        return name
    if empty_counter is None:
        return ""
    return f"{EMPTY_PLACEHOLDER_PREFIX}{next(empty_counter)}"


def is_empty_placeholder(name: str) -> bool:
    """True when the name was generated for a bare ``[]`` slot."""
    return str(name).startswith(EMPTY_PLACEHOLDER_PREFIX)
