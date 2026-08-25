"""
Effects ledger feature flag.
============================

One env var, default OFF: ``SCOUT_EFFECTS_LEDGER``.

Read live on every call rather than cached at import. Caching would mean the
flag's value is fixed by whichever module imported this first, which under
``uvicorn --workers 2`` is not reliably the same moment in both workers, and
makes the flag untestable without reloading modules. The read is a dict lookup
on ``os.environ``; it is not worth caching.
"""

from __future__ import annotations

import os

FLAG_ENV = "SCOUT_EFFECTS_LEDGER"

# Anything else — unset, "", "0", "false", "off", "no" — is OFF. The default is
# OFF, so an unrecognised value must fall to OFF, never to ON.
_TRUE = frozenset({"1", "true", "yes", "on"})


def ledger_enabled() -> bool:
    """True only when SCOUT_EFFECTS_LEDGER is explicitly set to a true value."""
    return (os.environ.get(FLAG_ENV) or "").strip().lower() in _TRUE
