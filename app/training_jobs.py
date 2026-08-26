"""
Server-side template training jobs
===================================

A DB-backed background job runner so template training survives the browser
tab being closed. The FE starts a job and then polls for status; the actual
work runs in a daemon thread inside the API process and drives the EXISTING
per-template SSE pipeline (`GET /api/knowledge/train-stream/{name}`) plus the
batch `POST /api/knowledge/deep-train` — nothing about the 15-step pipeline
itself changes.

Because the app runs `uvicorn --workers 2`, job state MUST live in Postgres
(a poll can land on either worker) and startup-resume must not double-run a
job across the two processes. A Postgres advisory lock held on a dedicated
connection for the worker's lifetime is the single-runner guard: only the
holder runs the queue; every other worker/process acquire-fails and exits.
"""

import contextlib
import json
import logging
import threading
import time
import urllib.parse
from datetime import datetime

import httpx
from psycopg.rows import dict_row
from psycopg.types.json import Json

from db.connection import get_db_conn

# Use the "legalscout" logger (which is wired to stdout) so worker/watchdog
# diagnostics are actually visible — a child logger was silently swallowed.
log = logging.getLogger("legalscout")

# Arbitrary constant advisory-lock key — only the holder runs the queue.
_LOCK_KEY = 4210771

_INTERNAL_BASE = "http://127.0.0.1:8000"

# Cap logs kept in the DB row (worker side) and returned to the API.
_LOG_KEEP = 500
_API_LOG_CAP = 200

# A running job whose updated_at (heartbeat) is older than this is considered
# ORPHANED — its worker died (e.g. a server restart killed the process while it
# held the advisory lock). The watchdog re-spawns a worker for it.
_STALE_SECS = 120
# How long a freshly-spawned worker will keep retrying a busy advisory lock
# before giving up. Covers the window where a killed process's session-level
# lock has not yet been reaped by Postgres.
_LOCK_RETRY_SECS = 150
_LOCK_RETRY_INTERVAL = 3
_WATCHDOG_INTERVAL = 45

_watchdog_started = False
_watchdog_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------
def ensure_table() -> None:
    conn = get_db_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS template_training_jobs (
                id serial PRIMARY KEY,
                status varchar(20) NOT NULL DEFAULT 'queued',
                queue jsonb NOT NULL DEFAULT '[]',
                total int NOT NULL DEFAULT 0,
                current_index int NOT NULL DEFAULT 0,
                current_template text,
                done_count int NOT NULL DEFAULT 0,
                fail_count int NOT NULL DEFAULT 0,
                logs jsonb NOT NULL DEFAULT '[]',
                error text,
                created_at timestamptz DEFAULT now(),
                updated_at timestamptz DEFAULT now(),
                finished_at timestamptz
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------
def _row_to_job(row: dict, cap_logs: bool = True) -> dict:
    if row is None:
        return None
    job = dict(row)
    # Normalise timestamps to isoformat strings for JSON responses.
    for k in ("created_at", "updated_at", "finished_at"):
        v = job.get(k)
        if isinstance(v, datetime):
            job[k] = v.isoformat()
    logs = job.get("logs") or []
    if cap_logs and isinstance(logs, list) and len(logs) > _API_LOG_CAP:
        job["logs"] = logs[-_API_LOG_CAP:]
    return job


def get_active_job(cap_logs: bool = True) -> dict:
    """Most recent job still queued or running, or None."""
    conn = get_db_conn()
    try:
        cur = conn.cursor(row_factory=dict_row)
        cur.execute(
            "SELECT * FROM template_training_jobs WHERE status IN ('queued','running') ORDER BY id DESC LIMIT 1"
        )
        return _row_to_job(cur.fetchone(), cap_logs=cap_logs)
    finally:
        conn.close()


def get_latest_job(cap_logs: bool = True) -> dict:
    """Most recent job of any status, or None."""
    conn = get_db_conn()
    try:
        cur = conn.cursor(row_factory=dict_row)
        cur.execute("SELECT * FROM template_training_jobs ORDER BY id DESC LIMIT 1")
        return _row_to_job(cur.fetchone(), cap_logs=cap_logs)
    finally:
        conn.close()


def _peek(job_id: int) -> dict:
    """Cheap liveness probe for a job: its status and how many seconds since its
    last heartbeat (updated_at). Used while contending for the advisory lock."""
    conn = get_db_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT status, EXTRACT(EPOCH FROM (now()-updated_at)) FROM template_training_jobs WHERE id=%s",
            (job_id,),
        )
        row = cur.fetchone()
        if not row:
            return None
        return {"status": row[0], "age": float(row[1] or 0)}
    finally:
        conn.close()


def _try_lock(lock_conn) -> bool:
    cur = lock_conn.cursor()
    cur.execute("SELECT pg_try_advisory_lock(%s)", (_LOCK_KEY,))
    return bool(cur.fetchone()[0])


def _wait_server_ready(timeout: float = 60.0) -> bool:
    """A worker spawned during startup can outrun uvicorn binding the port; its
    first internal call would then hit a refused/half-open socket. Wait for the
    local API to answer /health before driving the pipeline."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            r = httpx.get(f"{_INTERNAL_BASE}/health", timeout=5.0)
            if r.status_code == 200:
                return True
        except Exception:
            pass
        time.sleep(2)
    return False


# ---------------------------------------------------------------------------
# Job lifecycle
# ---------------------------------------------------------------------------
def create_job(templates: list) -> dict:
    """Insert a queued job — unless one is already active, in which case it is
    returned untouched (never two concurrent queues)."""
    existing = get_active_job()
    if existing is not None:
        return existing
    conn = get_db_conn()
    try:
        cur = conn.cursor(row_factory=dict_row)
        cur.execute(
            "INSERT INTO template_training_jobs (status, queue, total) VALUES ('queued', %s, %s) RETURNING *",
            (Json(list(templates)), len(templates)),
        )
        job = _row_to_job(cur.fetchone())
        conn.commit()
        return job
    finally:
        conn.close()


def start_job(templates: list) -> dict:
    """Ensure schema, create (or return the active) job, and spawn the worker."""
    ensure_table()
    existing = get_active_job()
    if existing is not None:
        return existing
    job = create_job(templates)
    threading.Thread(target=_worker, args=(job["id"],), daemon=True).start()
    start_watchdog()
    return job


def cancel_active() -> bool:
    """Flag the active job cancelled — the worker notices between templates."""
    conn = get_db_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE template_training_jobs SET status='cancelled', "
            "finished_at=now(), updated_at=now() "
            "WHERE status IN ('queued','running')"
        )
        n = cur.rowcount
        conn.commit()
        return n > 0
    finally:
        conn.close()


def resume_incomplete() -> None:
    """On startup, re-spawn a worker for any unfinished job. The advisory lock
    guarantees only one of the (2) uvicorn processes actually runs it."""
    ensure_table()
    conn = get_db_conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT id FROM template_training_jobs WHERE status IN ('running','queued') ORDER BY id DESC")
        ids = [r[0] for r in cur.fetchall()]
    finally:
        conn.close()
    for job_id in ids:
        threading.Thread(target=_worker, args=(job_id,), daemon=True).start()
    start_watchdog()


def _watchdog_loop() -> None:
    """Self-heals orphaned jobs: a 'running' job whose heartbeat went stale means
    its worker died (server restart, crash). Re-spawn a worker — the advisory
    lock (now freed with the dead session) lets it reclaim and continue. Without
    this, a job orphaned by a restart would sit at 'running' forever."""
    # First tick sooner than the full interval so a restart resumes quickly.
    time.sleep(10)
    while True:
        try:
            conn = get_db_conn()
            try:
                cur = conn.cursor()
                # Drive BOTH resume and self-heal: any 'queued' job (never picked
                # up) and any 'running' job whose heartbeat went stale (its worker
                # died — e.g. a server restart). The advisory lock inside _worker
                # guarantees only one worker across the 2 uvicorn processes runs
                # it, so spawning here is always safe. This is the ONLY startup
                # driver — @app.on_event("startup") is dead under AgentOS's
                # lifespan, so we cannot rely on it.
                cur.execute(
                    "SELECT id, status FROM template_training_jobs "
                    "WHERE status='queued' "
                    "   OR (status='running' AND updated_at < now() - make_interval(secs => %s))",
                    (_STALE_SECS,),
                )
                rows = cur.fetchall()
            finally:
                conn.close()
            for job_id, status in rows:
                log.info("[watchdog] reviving %s job %s", status, job_id)
                threading.Thread(target=_worker, args=(job_id,), daemon=True).start()
        except Exception:
            log.exception("Training watchdog iteration failed")
        time.sleep(_WATCHDOG_INTERVAL)


def start_watchdog() -> None:
    """Start the watchdog once per process (idempotent)."""
    global _watchdog_started
    with _watchdog_lock:
        if _watchdog_started:
            return
        _watchdog_started = True
    threading.Thread(target=_watchdog_loop, daemon=True, name="train-watchdog").start()


# ---------------------------------------------------------------------------
# Worker internals
# ---------------------------------------------------------------------------
def _load_job(conn, job_id: int) -> dict:
    cur = conn.cursor(row_factory=dict_row)
    cur.execute("SELECT * FROM template_training_jobs WHERE id=%s", (job_id,))
    return _row_to_job(cur.fetchone(), cap_logs=False)


def _flush_logs(conn, job_id: int, logs: list) -> None:
    """Persist the (trimmed) log list. The worker is the sole writer of logs."""
    trimmed = logs[-_LOG_KEEP:]
    cur = conn.cursor()
    cur.execute(
        "UPDATE template_training_jobs SET logs=%s, updated_at=now() WHERE id=%s",
        (Json(trimmed), job_id),
    )
    conn.commit()


def _make_log_entry(template: str, step: str, msg: str, level: str = "info") -> dict:
    return {
        "ts": datetime.utcnow().isoformat(),
        "template": template,
        "step": step,
        "msg": msg,
        "level": level,
    }


def _worker(job_id: int) -> None:
    """Background body — its own DB connections, guarded by an advisory lock."""
    lock_conn = get_db_conn(autocommit=True)
    have_lock = False
    conn = None
    try:
        log.info("[train-job %s] worker starting", job_id)
        have_lock = _try_lock(lock_conn)
        if not have_lock:
            # The lock is busy. Either a LIVE worker owns training (normal — we
            # should exit), or a killed process's session-level lock has not yet
            # been reaped by Postgres (orphan — we should wait and claim it).
            # Distinguish by the job's heartbeat: keep retrying only while the
            # job looks orphaned; bail the moment a live worker is progressing
            # or the job finishes.
            deadline = time.monotonic() + _LOCK_RETRY_SECS
            while time.monotonic() < deadline and not have_lock:
                time.sleep(_LOCK_RETRY_INTERVAL)
                peek = _peek(job_id)
                if peek is None or peek["status"] in ("done", "error", "cancelled"):
                    return
                if peek["age"] < _STALE_SECS:
                    # Fresh heartbeat → a live worker owns it. Stand down.
                    return
                have_lock = _try_lock(lock_conn)
            if not have_lock:
                return

        log.info("[train-job %s] acquired training lock", job_id)
        conn = get_db_conn()
        job = _load_job(conn, job_id)
        if job is None:
            return
        # If it was finished between spawn and lock acquisition, stop.
        if job["status"] in ("done", "error", "cancelled"):
            return

        # A startup-spawned worker may beat uvicorn to the port; wait for the
        # local API before issuing internal calls, else every template would
        # fail with a connection error.
        if not _wait_server_ready():
            log.warning("[train-job %s] local API not ready — deferring to watchdog", job_id)
            return

        queue = job.get("queue") or []
        logs = list(job.get("logs") or [])
        start_index = job.get("current_index") or 0

        cur = conn.cursor()
        cur.execute(
            "UPDATE template_training_jobs SET status='running', updated_at=now() WHERE id=%s",
            (job_id,),
        )
        conn.commit()

        # Mint our own admin token (import here to avoid a circular import).
        from app.main import create_token

        token = create_token(0, "system@training", "admin")
        headers = {"Authorization": f"Bearer {token}"}

        cancelled = False
        pending_since_flush = 0

        def _log(template, step, msg, level="info"):
            nonlocal pending_since_flush
            logs.append(_make_log_entry(template, step, msg, level))
            pending_since_flush += 1
            if pending_since_flush >= 10:
                _flush_logs(conn, job_id, logs)
                pending_since_flush = 0

        for i in range(start_index, len(queue)):
            # Re-read status to honour cancellation between templates.
            fresh = _load_job(conn, job_id)
            if fresh and fresh["status"] == "cancelled":
                cancelled = True
                break

            name = queue[i]
            cur = conn.cursor()
            cur.execute(
                "UPDATE template_training_jobs SET current_index=%s, current_template=%s, updated_at=now() WHERE id=%s",
                (i, name, job_id),
            )
            conn.commit()

            _log(name, "template_start", f"[{i + 1}/{len(queue)}] {name}", "ai")

            template_done = False
            try:
                url = f"{_INTERNAL_BASE}/api/knowledge/train-stream/{urllib.parse.quote(name)}"
                timeout = httpx.Timeout(connect=10.0, read=300.0, write=30.0, pool=10.0)
                with httpx.stream("GET", url, headers=headers, timeout=timeout) as r:
                    if r.status_code != 200:
                        r.read()
                        _log(name, "error", f"HTTP {r.status_code} starting training", "error")
                    else:
                        for line in r.iter_lines():
                            if not line or not line.startswith("data: "):
                                continue
                            try:
                                evt = json.loads(line[6:])
                            except Exception:
                                continue
                            step = evt.get("step", "")
                            msg = evt.get("msg", "")
                            if step == "done":
                                template_done = True
                                _log(name, step, msg or "done", "success")
                            elif step == "error":
                                _log(name, step, msg or "error", "error")
                            else:
                                _log(name, step, msg, "info")
            except Exception as e:
                log.warning("Training stream failed for %s: %s", name, e)
                _log(name, "error", f"{name} — connection error: {e}", "error")

            # Tally success / failure but ALWAYS continue to the next template.
            cur = conn.cursor()
            if template_done:
                _log(name, "template_done", f"{name} — done", "success")
                cur.execute(
                    "UPDATE template_training_jobs SET done_count=done_count+1, "
                    "current_index=%s, updated_at=now() WHERE id=%s",
                    (i + 1, job_id),
                )
            else:
                _log(name, "template_failed", f"{name} — failed", "error")
                cur.execute(
                    "UPDATE template_training_jobs SET fail_count=fail_count+1, "
                    "current_index=%s, updated_at=now() WHERE id=%s",
                    (i + 1, job_id),
                )
            conn.commit()
            _flush_logs(conn, job_id, logs)
            pending_since_flush = 0

        # Batch deep-train once the per-template loop finished (unless cancelled).
        if not cancelled:
            # ★★★Scope it to THIS job's queue.
            #
            # This used to POST with no body, and the endpoint then globbed every
            # .docx in the templates directory. Uploading 2 templates therefore
            # registered and AI-analysed all 15 files on disk — including ones
            # deliberately removed from the register — and took ~11 minutes.
            #
            # ★It is also the reason the UI appeared to hang: the per-template
            # bar reaches "2 of 2 / 100%" before this call starts, and nothing
            # below updates the job row, so the client polls an unchanging row
            # for the whole phase. The status line below gives it something to
            # show; the phase is still one blocking call, which is the next
            # thing to fix if it grows.
            _log("", "deep_train_start", f"Refreshing agent knowledge for {len(queue)} template(s)…", "processing")
            _flush_logs(conn, job_id, logs)
            cur = conn.cursor()
            cur.execute(
                "UPDATE template_training_jobs SET current_template=%s, updated_at=now() WHERE id=%s",
                (f"Refreshing agent knowledge ({len(queue)})…", job_id),
            )
            conn.commit()
            try:
                with httpx.Client(timeout=httpx.Timeout(600.0)) as client:
                    resp = client.post(
                        f"{_INTERNAL_BASE}/api/knowledge/deep-train",
                        headers=headers,
                        json={"templates": list(queue)},
                    )
                if resp.status_code == 200:
                    _log("", "deep_train_done", "Agent knowledge updated", "success")
                else:
                    _log("", "deep_train_error", f"Deep-train HTTP {resp.status_code}", "error")
            except Exception as e:
                log.warning("deep-train failed: %s", e)
                _log("", "deep_train_error", f"Agent knowledge refresh failed: {e}", "error")
            _flush_logs(conn, job_id, logs)

        # Finalise.
        final_status = "cancelled" if cancelled else "done"
        cur = conn.cursor()
        cur.execute(
            "UPDATE template_training_jobs SET status=%s, finished_at=now(), updated_at=now() WHERE id=%s",
            (final_status, job_id),
        )
        conn.commit()

    except Exception as e:
        log.exception("Training worker fatal error: %s", e)
        try:
            if conn is not None:
                cur = conn.cursor()
                cur.execute(
                    "UPDATE template_training_jobs SET status='error', error=%s, "
                    "finished_at=now(), updated_at=now() WHERE id=%s",
                    (str(e), job_id),
                )
                conn.commit()
        except Exception:
            log.exception("Failed to mark job errored")
    finally:
        if have_lock:
            try:
                lcur = lock_conn.cursor()
                lcur.execute("SELECT pg_advisory_unlock(%s)", (_LOCK_KEY,))
            except Exception:
                log.exception("Failed to release advisory lock")
        with contextlib.suppress(Exception):
            lock_conn.close()
        if conn is not None:
            with contextlib.suppress(Exception):
                conn.close()


# ---------------------------------------------------------------------------
# Import-time bootstrap
# ---------------------------------------------------------------------------
# @app.on_event("startup") is DEAD under AgentOS's lifespan, so we cannot start
# the watchdog there. Start it at import instead — main.py imports this module
# once per uvicorn worker process, guaranteeing the watchdog runs. The watchdog
# both resumes jobs orphaned by a restart and picks up freshly-queued jobs; the
# advisory lock keeps it single-runner across the 2 worker processes.
try:
    start_watchdog()
    logging.getLogger("legalscout").info("[train-jobs] watchdog started at import")
except Exception:
    logging.getLogger("legalscout").exception("Failed to start training watchdog")
