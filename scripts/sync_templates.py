"""Sync filesystem templates to database on startup."""

import json
import sys

try:
    from pathlib import Path

    from db.connection import get_db_conn

    conn = get_db_conn()
    conn.autocommit = True
    cur = conn.cursor()

    templates_dir = Path("/documents/legal/templates")
    if not templates_dir.exists():
        print("No templates directory")
        sys.exit(0)

    existing = {f.name for f in templates_dir.glob("*.docx")}
    cur.execute("SELECT name FROM templates")
    in_db = {r[0] for r in cur.fetchall()}

    added = 0
    for name in existing - in_db:
        try:
            from scout.tools.smart_doc import extract_placeholders_from_template

            fields = extract_placeholders_from_template(templates_dir / name).get("fields", [])
            cur.execute(
                "INSERT INTO templates (name, path, fields, total_fields) VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                (name, str(templates_dir / name), json.dumps(fields), len(fields)),
            )
            added += 1
            print(f"  Added: {name} ({len(fields)} fields)")
        except Exception as e:
            print(f"  Skip: {name}: {e}")

    removed = 0
    for name in in_db - existing:
        cur.execute("DELETE FROM templates WHERE name = %s", (name,))
        cur.execute("DELETE FROM knowledge_vec WHERE source_file = %s", (f"template:{name}",))
        cur.execute("DELETE FROM knowledge_lookup WHERE source_file = %s", (f"template:{name}",))
        removed += 1
        print(f"  Removed stale: {name}")

    if added or removed:
        print(f"Synced: {added} added, {removed} removed")
    else:
        print(f"Templates in sync ({len(in_db)} in DB, {len(existing)} on disk)")

    cur.close()
    conn.close()
except Exception as e:
    print(f"Sync warning: {e}")
