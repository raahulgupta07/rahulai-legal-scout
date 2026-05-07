"""
Document Tracker - Database Version
===================================

Tracks generated documents in PostgreSQL database.
"""

import json
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional
from pathlib import Path

from scout.tools.template_analyzer import get_db_connection


def record_document(
    template_name: str,
    company_name: str,
    file_name: str,
    file_path: str,
    download_url: str,
    preview_url: str,
    validation_result: Optional[Dict] = None,
    custom_data: Optional[Dict] = None,
) -> bool:
    """Record a generated document to database."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()

        cur.execute(
            """
            INSERT INTO documents
            (template_name, company_name, file_name, file_path, download_url, preview_url, validation_result, custom_data, version, created_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 1, %s)
        """,
            (
                template_name,
                company_name,
                file_name,
                file_path,
                download_url,
                preview_url,
                json.dumps(validation_result, default=str) if validation_result else None,
                json.dumps(custom_data, default=str) if custom_data else None,
                datetime.now(),
            ),
        )

        conn.commit()
        cur.close()
        return True
    except Exception as e:
        logging.getLogger("legalscout").warning(f"DB error in record_document: {e}")
        return False
    finally:
        if conn:
            conn.close()


def get_all_documents(limit: int = 100) -> List[Dict]:
    """Get all documents from database."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, template_name, company_name, file_name, download_url, preview_url, version, created_at
            FROM documents
            ORDER BY created_at DESC
            LIMIT %s
        """,
            (limit,),
        )

        rows = cur.fetchall()
        cur.close()

        return [
            {
                "id": str(row[0]),
                "template_name": row[1],
                "company_name": row[2],
                "file_name": row[3],
                "download_url": row[4],
                "preview_url": row[5],
                "version": row[6],
                "created_at": row[7].isoformat() if row[7] else None,
            }
            for row in rows
        ]
    except Exception as e:
        logging.getLogger("legalscout").warning(f"DB error in get_all_documents: {e}")
        return []
    finally:
        if conn:
            conn.close()


def get_documents_by_company(company_name: str) -> List[Dict]:
    """Get documents for a specific company."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, template_name, company_name, file_name, download_url, preview_url, version, created_at
            FROM documents
            WHERE company_name = %s
            ORDER BY created_at DESC
        """,
            (company_name,),
        )

        rows = cur.fetchall()
        cur.close()

        return [
            {
                "id": str(row[0]),
                "template_name": row[1],
                "company_name": row[2],
                "file_name": row[3],
                "download_url": row[4],
                "preview_url": row[5],
                "version": row[6],
                "created_at": row[7].isoformat() if row[7] else None,
            }
            for row in rows
        ]
    except Exception as e:
        logging.getLogger("legalscout").warning(f"DB error in get_documents_by_company: {e}")
        return []
    finally:
        if conn:
            conn.close()


def get_document_stats() -> Dict[str, Any]:
    """Get document statistics from database."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()

        cur.execute("SELECT COUNT(*) FROM documents")
        row = cur.fetchone()
        total = row[0] if row else 0

        cur.execute("""
            SELECT company_name, COUNT(*) as count
            FROM documents
            GROUP BY company_name
            ORDER BY count DESC
        """)
        company_rows = cur.fetchall()
        by_company = {r[0]: r[1] for r in company_rows}

        cur.execute("""
            SELECT template_name, COUNT(*) as count
            FROM documents
            GROUP BY template_name
            ORDER BY count DESC
        """)
        template_rows = cur.fetchall()
        by_template = {r[0]: r[1] for r in template_rows}

        cur.execute("""
            SELECT id, template_name, company_name, file_name, download_url, preview_url, version, created_at
            FROM documents
            ORDER BY created_at DESC
            LIMIT 5
        """)
        recent_rows = cur.fetchall()
        recent = [
            {
                "id": str(r[0]),
                "template_name": r[1],
                "company_name": r[2],
                "file_name": r[3],
                "download_url": r[4],
                "preview_url": r[5],
                "version": r[6],
                "created_at": r[7].isoformat() if r[7] else None,
            }
            for r in recent_rows
        ]

        cur.close()

        return {
            "total_documents": total,
            "by_company": by_company,
            "by_template": by_template,
            "recent_documents": recent,
        }
    except Exception as e:
        logging.getLogger("legalscout").warning(f"DB error in get_document_stats: {e}")
        return {
            "total_documents": 0,
            "by_company": {},
            "by_template": {},
            "recent_documents": [],
        }
    finally:
        if conn:
            conn.close()


def create_document_tracker_tool(host: str = ""):
    """Create the document tracker tool."""

    def list_documents(limit: int = 50):
        """List all tracked documents."""
        return {"documents": get_all_documents(limit)}

    def get_document(doc_id: str):
        """Get a specific document."""
        docs = get_all_documents(100)
        for doc in docs:
            if doc["id"] == doc_id:
                return {"document": doc}
        return {"error": "Document not found"}

    def get_stats():
        """Get document statistics."""
        return get_document_stats()

    return {
        "list_documents": list_documents,
        "get_document": get_document,
        "get_stats": get_stats,
    }
