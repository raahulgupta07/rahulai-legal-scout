"""
Database Module
===============

Lazy exports — heavy imports (agno) are deferred so `python -m db.migrate`
works without loading the full app graph.
"""

__all__ = ["create_knowledge", "db_url", "get_postgres_db"]


def __getattr__(name: str):
    if name in {"create_knowledge", "get_postgres_db"}:
        from db.session import create_knowledge, get_postgres_db

        return {"create_knowledge": create_knowledge, "get_postgres_db": get_postgres_db}[name]
    if name == "db_url":
        from db.url import db_url

        return db_url
    raise AttributeError(f"module 'db' has no attribute {name!r}")
