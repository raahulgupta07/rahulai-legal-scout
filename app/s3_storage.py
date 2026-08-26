"""
S3 Storage Module
=================

Upload, download, delete files from S3 (or S3-compatible: MinIO, R2, B2).
Local-first: files are saved locally, then synced to S3 in background.

Usage:
    from app.s3_storage import s3_upload, s3_download, s3_delete, s3_test, is_s3_enabled
"""

import json
import logging
import threading
from pathlib import Path

logger = logging.getLogger("legalscout.s3")

# S3 config keys in app_settings table
S3_CONFIG_KEY = "s3_config"


def _get_s3_config() -> dict:
    """Load S3 config from app_settings DB."""
    conn = None
    try:
        from db.connection import get_db_conn

        conn = get_db_conn()
        cur = conn.cursor()
        cur.execute("SELECT value FROM app_settings WHERE key = %s", (S3_CONFIG_KEY,))
        row = cur.fetchone()
        cur.close()
        if row and row[0]:
            return json.loads(row[0]) if isinstance(row[0], str) else row[0]
    except Exception as e:
        logging.getLogger("legalscout").warning(f"DB error: {e}")
    finally:
        if conn:
            conn.close()
    return {}


def save_s3_config(config: dict):
    """Save S3 config to app_settings DB."""
    conn = None
    try:
        from db.connection import get_db_conn

        conn = get_db_conn()
        cur = conn.cursor()
        value = json.dumps(config)
        cur.execute(
            "INSERT INTO app_settings (key, value) VALUES (%s, %s) "
            "ON CONFLICT (key) DO UPDATE SET value = %s, updated_at = CURRENT_TIMESTAMP",
            (S3_CONFIG_KEY, value, value),
        )
        conn.commit()
        cur.close()
    except Exception as e:
        logging.getLogger("legalscout").warning(f"DB error: {e}")
        raise e
    finally:
        if conn:
            conn.close()


def is_s3_enabled() -> bool:
    """Check if S3 is configured and enabled."""
    config = _get_s3_config()
    return bool(config.get("enabled") and config.get("bucket") and config.get("access_key"))


def _get_client():
    """Create boto3 S3 client from stored config."""
    import boto3

    config = _get_s3_config()
    if not config.get("enabled"):
        return None, None

    kwargs = {
        "aws_access_key_id": config.get("access_key", ""),
        "aws_secret_access_key": config.get("secret_key", ""),
        "region_name": config.get("region", "us-east-1"),
    }
    # Custom endpoint for MinIO, R2, B2, etc.
    if config.get("endpoint_url"):
        kwargs["endpoint_url"] = config["endpoint_url"]

    client = boto3.client("s3", **kwargs)
    bucket = config.get("bucket", "")
    return client, bucket


def _local_to_s3_key(local_path: str) -> str:
    """Convert local path to S3 key. /documents/legal/templates/AGM.docx → templates/AGM.docx"""
    path = str(local_path)
    # Strip the /documents/legal/ prefix
    for prefix in ["/documents/legal/", "/documents/"]:
        if prefix in path:
            return path.split(prefix, 1)[1]
    return Path(path).name


def s3_upload(local_path: str, s3_key: str | None = None):
    """Upload a file to S3. Returns True on success."""
    try:
        client, bucket = _get_client()
        if not client:
            return False

        if not s3_key:
            s3_key = _local_to_s3_key(local_path)

        client.upload_file(str(local_path), bucket, s3_key)
        logger.info(f"S3 uploaded: {s3_key}")
        return True
    except Exception as e:
        logger.warning(f"S3 upload failed ({s3_key}): {e}")
        return False


def s3_upload_async(local_path: str, s3_key: str | None = None):
    """Upload to S3 in background thread (non-blocking)."""
    if not is_s3_enabled():
        return
    thread = threading.Thread(target=s3_upload, args=(local_path, s3_key), daemon=True)
    thread.start()


def s3_download(s3_key: str, local_path: str) -> bool:
    """Download a file from S3 to local path. Returns True on success."""
    try:
        client, bucket = _get_client()
        if not client:
            return False

        Path(local_path).parent.mkdir(parents=True, exist_ok=True)
        client.download_file(bucket, s3_key, str(local_path))
        logger.info(f"S3 downloaded: {s3_key} → {local_path}")
        return True
    except Exception as e:
        logger.warning(f"S3 download failed ({s3_key}): {e}")
        return False


def s3_delete(s3_key: str) -> bool:
    """Delete a file from S3. Returns True on success."""
    try:
        client, bucket = _get_client()
        if not client:
            return False

        client.delete_object(Bucket=bucket, Key=s3_key)
        logger.info(f"S3 deleted: {s3_key}")
        return True
    except Exception as e:
        logger.warning(f"S3 delete failed ({s3_key}): {e}")
        return False


def s3_delete_async(s3_key: str):
    """Delete from S3 in background thread."""
    if not is_s3_enabled():
        return
    thread = threading.Thread(target=s3_delete, args=(s3_key,), daemon=True)
    thread.start()


def s3_list(prefix: str = "") -> list[dict]:
    """List files in S3 bucket under a prefix."""
    try:
        client, bucket = _get_client()
        if not client:
            return []

        response = client.list_objects_v2(Bucket=bucket, Prefix=prefix, MaxKeys=500)
        files = []
        for obj in response.get("Contents", []):
            files.append(
                {
                    "key": obj["Key"],
                    "size": obj["Size"],
                    "modified": obj["LastModified"].isoformat() if obj.get("LastModified") else None,
                }
            )
        return files
    except Exception as e:
        logger.warning(f"S3 list failed: {e}")
        return []


def s3_test() -> dict:
    """Test S3 connection. Returns status dict."""
    try:
        client, bucket = _get_client()
        if not client:
            return {"success": False, "error": "S3 not configured or disabled"}

        # Try listing bucket
        response = client.list_objects_v2(Bucket=bucket, MaxKeys=1)
        response.get("KeyCount", 0)

        # Get full count
        total_files = 0
        total_size = 0
        paginator = client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=bucket):
            for obj in page.get("Contents", []):
                total_files += 1
                total_size += obj.get("Size", 0)

        size_mb = round(total_size / (1024 * 1024), 2)
        return {
            "success": True,
            "message": f"Connected — {total_files} files, {size_mb} MB",
            "files": total_files,
            "size_mb": size_mb,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def s3_sync_all():
    """Upload all local files to S3. Used for initial sync."""
    if not is_s3_enabled():
        return {"success": False, "error": "S3 not enabled"}

    synced = 0
    errors = 0
    base = Path("/documents/legal")

    for subdir in ["templates", "output", "uploads"]:
        dir_path = base / subdir
        if not dir_path.exists():
            continue
        for f in dir_path.iterdir():
            if f.is_file():
                s3_key = f"{subdir}/{f.name}"
                if s3_upload(str(f), s3_key):
                    synced += 1
                else:
                    errors += 1

    return {"success": True, "synced": synced, "errors": errors}
