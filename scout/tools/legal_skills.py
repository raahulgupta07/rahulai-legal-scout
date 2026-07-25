"""
Legal Skills Tools for Agent
============================

Anthropic Agent-Skills pattern ported to Agno:
  - L1 (metadata) is injected into the system prompt at import/startup.
  - L2 (the full playbook body) is loaded on demand via load_skill(name).

Tools:
  - list_skills()      → enabled skills as "name — description" lines
  - load_skill(name)   → full body for an enabled skill + a trailing
                         instruction telling the agent to follow it now
"""

import logging
from typing import Any, Dict

from db.connection import get_db_conn


def create_legal_skills_tools():
    """Create the legal-skills tools for the agent."""

    def list_skills() -> Dict[str, Any]:
        """
        List the legal playbooks (skills) available to load.

        Returns each enabled skill as a "name — description" line. When a
        user request matches one of these descriptions, call
        load_skill(name) FIRST and follow the returned playbook.

        Returns:
            A dict with the formatted skill lines and a count.
        """
        conn = None
        try:
            conn = get_db_conn()
            cur = conn.cursor()
            cur.execute(
                """
                SELECT name, description
                FROM legal_skills
                WHERE enabled = TRUE
                ORDER BY name
                """
            )
            rows = cur.fetchall()
            cur.close()

            lines = [f"{r[0]} — {r[1]}" for r in rows]
            return {
                "skills": "\n".join(lines) if lines else "No skills available.",
                "count": len(lines),
            }
        except Exception as e:
            logging.getLogger("legalscout").warning(f"Error in list_skills: {e}")
            return {"skills": "Skills unavailable.", "count": 0, "error": str(e)}
        finally:
            if conn:
                conn.close()

    def load_skill(name: str) -> Dict[str, Any]:
        """
        Load a legal playbook (skill) by name and follow it now.

        Call this FIRST when a user request matches a skill's description.
        Returns the full step-by-step body of the playbook. Follow it for
        the current request.

        Args:
            name: The exact skill name (kebab-case), e.g. "agm-minutes".

        Returns:
            A dict with the skill body, or a helpful error listing the
            available skill names if the name was not found.
        """
        conn = None
        try:
            conn = get_db_conn()
            cur = conn.cursor()
            cur.execute(
                """
                SELECT name, description, body, version
                FROM legal_skills
                WHERE name = %s AND enabled = TRUE
                """,
                (name,),
            )
            row = cur.fetchone()

            if not row:
                cur.execute(
                    "SELECT name FROM legal_skills WHERE enabled = TRUE ORDER BY name"
                )
                available = [r[0] for r in cur.fetchall()]
                cur.close()
                return {
                    "success": False,
                    "error": f"No enabled skill named '{name}'.",
                    "available_skills": available,
                    "hint": "Call load_skill with one of the available names above.",
                }

            cur.close()
            body = row[2] or ""
            return {
                "success": True,
                "name": row[0],
                "description": row[1],
                "version": row[3],
                "body": body
                + "\n\nFollow this playbook now for the current request.",
            }
        except Exception as e:
            logging.getLogger("legalscout").warning(f"Error in load_skill: {e}")
            return {"success": False, "error": str(e)}
        finally:
            if conn:
                conn.close()

    return {
        "list_skills": list_skills,
        "load_skill": load_skill,
    }
