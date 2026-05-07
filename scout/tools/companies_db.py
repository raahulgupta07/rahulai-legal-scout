"""
Companies Database Module
========================

Manages companies in PostgreSQL database.
"""

import json
from datetime import datetime
from typing import Any, Dict, List, Optional

from scout.tools.template_analyzer import get_db_connection


def save_company(name: str, data: Dict = None) -> bool:
    """Save or update a company in database. Delegates to knowledge_base.add_company."""
    try:
        from scout.tools.knowledge_base import add_company
        payload = data or {}
        if not payload.get("company_name_english"):
            payload["company_name_english"] = name
        result = add_company(payload)
        return result.get("success", False)
    except Exception as e:
        print(f"Error saving company: {e}")
        return False


def get_all_companies(limit: int = 100) -> List[Dict]:
    """Get all companies from database (DICA format)."""
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, company_name_english, company_registration_number,
                   registered_office_address, directors, status, company_type,
                   created_at, updated_at, members, total_shares_issued,
                   currency_of_share_capital,
                   financial_year_end_date, next_financial_year_end_date,
                   auditor_name, auditor_fee, custom_fields
            FROM companies
            ORDER BY company_name_english ASC
            LIMIT %s
        """,
            (limit,),
        )

        rows = cur.fetchall()
        cur.close()
        conn.close()

        results = []
        for row in rows:
            dirs = row[4] if isinstance(row[4], list) else []
            mems = row[9] if isinstance(row[9], list) else []
            director_names = ", ".join(d.get("name", "") for d in dirs) if dirs else ""
            shareholder_names = ", ".join(m.get("name", "") for m in mems) if mems else ""
            results.append({
                "id": row[0],
                "name": row[1] or "",
                "registration_number": row[2] or "",
                "address": row[3] or "",
                "directors": director_names,
                "directors_list": dirs,
                "shareholders": shareholder_names,
                "shareholders_list": mems,
                "total_shares": row[10] or "",
                "currency": row[11] or "",
                "status": row[5] or "",
                "company_type": row[6] or "",
                "created_at": row[7].isoformat() if row[7] else None,
                "updated_at": row[8].isoformat() if row[8] else None,
                "financial_year_end_date": row[12] or "",
                "next_financial_year_end_date": row[13] or "",
                "auditor_name": row[14] or "",
                "auditor_fee": row[15] or "",
                "custom_fields": row[16] if isinstance(row[16], dict) else {},
            })
        return results
    except Exception as e:
        print(f"Error getting companies: {e}")
        return []


def get_company_names(limit: int = 50) -> List[str]:
    """Get just company names (for dropdowns, etc)."""
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            """
            SELECT company_name_english FROM companies ORDER BY company_name_english ASC LIMIT %s
        """,
            (limit,),
        )

        rows = cur.fetchall()
        cur.close()
        conn.close()

        return [row[0] for row in rows]
    except Exception as e:
        print(f"Error getting company names: {e}")
        return []


def get_companies_info() -> Dict[str, Any]:
    """Get companies info for fast_info tool."""
    companies = get_all_companies()
    return {
        "total": len(companies),
        "companies": [c["name"] for c in companies[:50]],
    }
