"""Feature flag for the durable memory layer.

Default OFF. With the flag unset the store opens no connection, reads
nothing and writes nothing, so the product behaves exactly as it did
before migration 023 existed.
"""

from __future__ import annotations

import os

#: Environment variable that turns the memory layer on.
MEMORY_FLAG_ENV = "LEGAL_SCOUT_MEMORY"

#: Values that count as "on". Anything else — including unset, "", "0",
#: "false", "off", "no" and any typo — is off.
_TRUTHY = frozenset({"1", "true", "yes", "on", "enabled"})


def memory_enabled() -> bool:
    """Return True only when the memory flag is explicitly set truthy.

    Read at call time, never cached at import time: a test (or an operator
    with a restart) must be able to flip it without reloading the module.
    """
    raw = os.environ.get(MEMORY_FLAG_ENV)
    if raw is None:
        return False
    return raw.strip().lower() in _TRUTHY
