"""
Database Migration Runner
=========================

Applies SQL migration files in order, tracking which have been applied.

Usage:
    python -m db.migrate           # Apply pending migrations
    python -m db.migrate --status  # Show migration status
"""

import glob
import os
import sys
from pathlib import Path

import psycopg


def get_connection():
    """Create a database connection from environment variables."""
    host = os.getenv("DB_HOST", "localhost")
    port = os.getenv("DB_PORT", "5432")
    user = os.getenv("DB_USER", "scout")
    password = os.getenv("DB_PASS")
    if not password:
        raise ValueError("DB_PASS environment variable is required")
    database = os.getenv("DB_DATABASE", "legalscout")
    return psycopg.connect(f"host={host} port={port} dbname={database} user={user} password={password}")


def ensure_migrations_table(conn):
    """Create the migrations tracking table if it doesn't exist."""
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS schema_migrations (
                id SERIAL PRIMARY KEY,
                filename VARCHAR(255) UNIQUE NOT NULL,
                applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
    conn.commit()


def get_applied_migrations(conn):
    """Get set of already-applied migration filenames."""
    with conn.cursor() as cur:
        cur.execute("SELECT filename FROM schema_migrations ORDER BY filename")
        return {row[0] for row in cur.fetchall()}


def get_pending_migrations(conn):
    """Get list of migration files that haven't been applied yet."""
    db_dir = Path(__file__).parent
    all_migrations = sorted(glob.glob(str(db_dir / "migration_*.sql")))
    applied = get_applied_migrations(conn)
    return [m for m in all_migrations if Path(m).name not in applied]


def apply_migration(conn, filepath):
    """Apply a single migration file."""
    filename = Path(filepath).name
    print(f"  Applying: {filename} ...", end=" ", flush=True)

    with open(filepath) as f:
        sql = f.read()

    try:
        with conn.cursor() as cur:
            cur.execute(sql)
            cur.execute("INSERT INTO schema_migrations (filename) VALUES (%s)", (filename,))
        conn.commit()
        print("OK")
    except Exception as e:
        conn.rollback()
        print(f"FAILED: {e}")
        raise


def show_status(conn):
    """Print migration status."""
    applied = get_applied_migrations(conn)
    db_dir = Path(__file__).parent
    all_migrations = sorted(glob.glob(str(db_dir / "migration_*.sql")))

    print(f"\nMigration Status ({len(applied)}/{len(all_migrations)} applied):")
    print("-" * 50)
    for m in all_migrations:
        name = Path(m).name
        status = "applied" if name in applied else "PENDING"
        print(f"  {'[x]' if name in applied else '[ ]'} {name} — {status}")
    print()


def main():
    """Run pending migrations."""
    status_only = "--status" in sys.argv

    conn = get_connection()
    ensure_migrations_table(conn)

    if status_only:
        show_status(conn)
        conn.close()
        return

    pending = get_pending_migrations(conn)

    if not pending:
        print("No pending migrations.")
        conn.close()
        return

    print(f"\nApplying {len(pending)} migration(s):")
    for filepath in pending:
        apply_migration(conn, filepath)

    print(f"\nDone. {len(pending)} migration(s) applied.")
    conn.close()


if __name__ == "__main__":
    main()
