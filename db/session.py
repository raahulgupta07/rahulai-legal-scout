"""
Database Session
================

PostgreSQL database connection for AgentOS.
"""

from os import getenv

from agno.db.postgres import PostgresDb
from agno.knowledge import Knowledge
from agno.knowledge.embedder.openai import OpenAIEmbedder
from agno.vectordb.pgvector import PgVector, SearchType

from db.url import db_url

DB_ID = "scout-db"


def get_postgres_db(contents_table: str | None = None) -> PostgresDb:
    """Create a PostgresDb instance.

    Args:
        contents_table: Optional table name for storing knowledge contents.

    Returns:
        Configured PostgresDb instance.
    """
    if contents_table is not None:
        return PostgresDb(id=DB_ID, db_url=db_url, knowledge_table=contents_table)
    return PostgresDb(id=DB_ID, db_url=db_url)


def create_knowledge(name: str, table_name: str) -> Knowledge:
    """Create a Knowledge instance with PgVector hybrid search.

    Args:
        name: Display name for the knowledge base.
        table_name: PostgreSQL table name for vector storage.

    Returns:
        Configured Knowledge instance.
    """
    # Imported here, not at module scope: db.session -> app.model_config pulls in
    # app/__init__ -> app.main -> `from db import ...`, which re-enters this
    # module while it is still executing. Whether that cycle actually breaks
    # depended on which module got imported first, so it survived for months and
    # then surfaced the moment an import sorter reordered these two lines
    # alphabetically. Deferring it to call time removes the cycle outright.
    from app.model_config import OPENROUTER_BASE_URL as _OPENROUTER_BASE_URL

    return Knowledge(
        name=name,
        vector_db=PgVector(
            db_url=db_url,
            table_name=table_name,
            search_type=SearchType.hybrid,
            embedder=OpenAIEmbedder(
                id=getenv("EMBEDDING_MODEL", "openai/text-embedding-3-small"),
                api_key=getenv("OPENROUTER_API_KEY") or getenv("OPENAI_API_KEY"),
                base_url=_OPENROUTER_BASE_URL,
            ),
        ),
        contents_db=get_postgres_db(contents_table=f"{table_name}_contents"),
    )
