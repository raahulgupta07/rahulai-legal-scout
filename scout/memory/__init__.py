"""Durable per-company memory for Legal Scout.

Facts that outlive a chat session, filed under a company (and optionally
a user), with a provenance trail and revision history.

Flag-gated by LEGAL_SCOUT_MEMORY, default OFF. With the flag off every
function here short-circuits before touching a connection.

Importing this package pulls in no driver, no agno and no mcp.

    from scout.memory import MemoryScope, remember, recall

    scope = MemoryScope(company_id=7, user_email="clerk@firm.example")
    remember(scope, "financial year end", "31 March", category="convention")
    recall(scope)
"""

from __future__ import annotations

from scout.memory.flags import MEMORY_FLAG_ENV, memory_enabled
from scout.memory.scope import MemoryScope, MemoryScopeError, require_scope
from scout.memory.resolve import (
    AMBIGUOUS,
    BY_EXACT_NAME,
    BY_REGISTRATION,
    BY_SESSION,
    NONE,
    RESOLVED,
    Resolution,
    bind_session,
    resolve_company,
    resolve_for_session,
    session_binding,
    unbind_session,
)
from scout.memory.store import (
    MAX_KEY_CHARS,
    MAX_VALUE_CHARS,
    connection_factory,
    count,
    forget,
    history,
    recall,
    remember,
    render_for_prompt,
)

__all__ = [
    "AMBIGUOUS",
    "BY_EXACT_NAME",
    "BY_REGISTRATION",
    "BY_SESSION",
    "MEMORY_FLAG_ENV",
    "MAX_KEY_CHARS",
    "MAX_VALUE_CHARS",
    "MemoryScope",
    "MemoryScopeError",
    "NONE",
    "RESOLVED",
    "Resolution",
    "bind_session",
    "connection_factory",
    "count",
    "forget",
    "history",
    "memory_enabled",
    "recall",
    "remember",
    "render_for_prompt",
    "require_scope",
    "resolve_company",
    "resolve_for_session",
    "session_binding",
    "unbind_session",
]
