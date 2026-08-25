"""
AI Model Configuration
======================

Loads model settings from app_settings table.
Falls back to defaults if not configured.

Usage:
    from app.model_config import get_model
    model = get_model("chat")  # → "google/gemini-3.6-flash"
"""

import os
import json
import logging

# Centralized OpenRouter base URL — configurable via env var
OPENROUTER_BASE_URL = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")

# Defaults — used when DB has no config
DEFAULTS = {
    "chat": "google/gemini-3.6-flash",
    # Background UI work — chat titles and follow-up suggestions. Kept separate
    # from "chat" so it can be pointed at a cheaper, faster model without
    # touching the model that writes legal documents. Defaults to the same
    # model, so nothing changes until an admin sets one: naming a model ID that
    # may not exist on OpenRouter would break these features silently, which is
    # exactly how follow-ups died once before.
    "task": "google/gemini-3.6-flash",
    "training": "google/gemini-3.6-flash",
    "classification": "google/gemini-3.6-flash",
    "embedding": "openai/text-embedding-3-small",
}

_cache = {}


def _load_from_db():
    """Load model config from app_settings table."""
    global _cache
    conn = None
    try:
        from db.connection import get_db_conn
        conn = get_db_conn()
        cur = conn.cursor()
        cur.execute("SELECT value FROM app_settings WHERE key = 'ai_models'")
        row = cur.fetchone()
        cur.close()
        if row and row[0]:
            _cache = json.loads(row[0]) if isinstance(row[0], str) else row[0]
    except Exception as e:
        logging.getLogger("legalscout").warning(f"DB error: {e}")
    finally:
        if conn:
            conn.close()


def get_model(purpose: str) -> str:
    """Get model ID for a purpose (chat, training, classification, embedding)."""
    if not _cache:
        _load_from_db()
    return _cache.get(purpose, DEFAULTS.get(purpose, ""))


def get_all_models() -> dict:
    """Get all model configs with defaults filled in."""
    if not _cache:
        _load_from_db()
    result = {}
    for key, default in DEFAULTS.items():
        result[key] = _cache.get(key, default)
    return result


def save_models(config: dict):
    """Save model config to app_settings table."""
    global _cache
    conn = None
    try:
        from db.connection import get_db_conn
        conn = get_db_conn()
        cur = conn.cursor()
        value = json.dumps(config)
        cur.execute(
            "INSERT INTO app_settings (key, value) VALUES ('ai_models', %s) "
            "ON CONFLICT (key) DO UPDATE SET value = %s, updated_at = CURRENT_TIMESTAMP",
            (value, value)
        )
        conn.commit()
        cur.close()
        _cache.update(config)
        # Also set env vars for modules that can't import model_config
        if "classification" in config:
            os.environ["CLASSIFICATION_MODEL"] = config["classification"]
        if "embedding" in config:
            os.environ["EMBEDDING_MODEL"] = config["embedding"]
    except Exception as e:
        logging.getLogger("legalscout").warning(f"DB error: {e}")
        raise e
    finally:
        if conn:
            conn.close()


_tz_cache = {"value": None, "expires": 0}


def get_timezone() -> str:
    """Get configured timezone from app_settings. Cached for 60 seconds."""
    import time
    now = time.time()
    if _tz_cache["value"] and now < _tz_cache["expires"]:
        return _tz_cache["value"]

    conn = None
    try:
        from db.connection import get_db_conn
        conn = get_db_conn()
        cur = conn.cursor()
        cur.execute("SELECT value FROM app_settings WHERE key = 'timezone'")
        row = cur.fetchone()
        cur.close()
        if row and row[0]:
            _tz_cache["value"] = row[0]
            _tz_cache["expires"] = now + 60
            return row[0]
    except Exception as e:
        logging.getLogger("legalscout").warning(f"DB error: {e}")
    finally:
        if conn:
            conn.close()
    return _tz_cache["value"] or "Asia/Yangon"


def save_timezone(tz: str):
    """Save timezone to app_settings."""
    conn = None
    try:
        from db.connection import get_db_conn
        conn = get_db_conn()
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO app_settings (key, value) VALUES ('timezone', %s) "
            "ON CONFLICT (key) DO UPDATE SET value = %s, updated_at = CURRENT_TIMESTAMP",
            (tz, tz))
        conn.commit()
        cur.close()
    except Exception as e:
        logging.getLogger("legalscout").warning(f"DB error: {e}")
        raise e
    finally:
        if conn:
            conn.close()


def get_current_datetime() -> str:
    """Get current date/time in configured timezone."""
    from datetime import datetime, timezone as tz
    try:
        import zoneinfo
        zone = zoneinfo.ZoneInfo(get_timezone())
        now = datetime.now(zone)
    except Exception:
        now = datetime.now()
    return now.strftime("%A, %d %B %Y, %I:%M %p")


def get_current_date() -> str:
    """Get current date only in configured timezone."""
    from datetime import datetime
    try:
        import zoneinfo
        zone = zoneinfo.ZoneInfo(get_timezone())
        now = datetime.now(zone)
    except Exception:
        now = datetime.now()
    return now.strftime("%Y-%m-%d")








def clear_cache():
    """Clear cached config — forces reload from DB on next get_model() call."""
    global _cache
    _cache = {}
