"""Test-only runtimes and fixtures.

Nothing in here is imported by the product. It exists so the tracker suites can
be driven without a model, a network, or a running container.
"""

from .scripted_runtime import (  # noqa: F401
    Ask,
    Complete,
    Document,
    Error,
    Pick,
    ScriptedAgentRuntime,
    ScriptedRunError,
    Text,
    ToolCall,
    candidate,
    fill_template,
)
