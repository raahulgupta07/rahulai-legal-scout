"""Context builders for Scout's system prompt."""

from scout.context.intent_routing import (
    INTENT_ROUTING,
    INTENT_ROUTING_CONTEXT,
    build_intent_routing,
    load_intent_rules,
)
from scout.context.source_registry import (
    SOURCE_REGISTRY,
    SOURCE_REGISTRY_STR,
    build_source_registry,
    format_source_registry,
    load_source_metadata,
)

__all__ = [
    "INTENT_ROUTING",
    "INTENT_ROUTING_CONTEXT",
    "SOURCE_REGISTRY",
    "SOURCE_REGISTRY_STR",
    "build_intent_routing",
    "build_source_registry",
    "format_source_registry",
    "load_intent_rules",
    "load_source_metadata",
]
