"""
Structured Logging Configuration
=================================

Configures JSON logging for production and human-readable logging for development.
All log entries include: timestamp, level, logger name, message, and optional extras.

Usage:
    from app.logging_config import setup_logging, get_logger
    setup_logging()
    logger = get_logger("mymodule")
    logger.info("something happened", extra={"user_id": 1, "action": "login"})
"""

import json
import logging
import sys
from datetime import UTC, datetime
from os import getenv
from typing import ClassVar


class JSONFormatter(logging.Formatter):
    """Structured JSON log formatter for production."""

    def format(self, record: logging.LogRecord) -> str:
        log_entry = {
            "timestamp": datetime.fromtimestamp(record.created, tz=UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }

        # Add extra fields (anything passed via extra={})
        for key in (
            "request_id",
            "method",
            "path",
            "status_code",
            "duration_ms",
            "user_id",
            "user_email",
            "ip",
            "action",
            "error",
            "detail",
        ):
            value = getattr(record, key, None)
            if value is not None:
                log_entry[key] = value

        # Add exception info if present
        if record.exc_info and record.exc_info[0]:
            log_entry["exception"] = {
                "type": record.exc_info[0].__name__,
                "message": str(record.exc_info[1]),
            }

        return json.dumps(log_entry, default=str)


class HumanFormatter(logging.Formatter):
    """Colored human-readable formatter for development."""

    COLORS: ClassVar[dict[str, str]] = {
        "DEBUG": "\033[36m",  # Cyan
        "INFO": "\033[32m",  # Green
        "WARNING": "\033[33m",  # Yellow
        "ERROR": "\033[31m",  # Red
        "CRITICAL": "\033[41m",  # Red background
    }
    RESET = "\033[0m"

    def format(self, record: logging.LogRecord) -> str:
        color = self.COLORS.get(record.levelname, "")
        timestamp = datetime.fromtimestamp(record.created).strftime("%H:%M:%S")

        # Build extra fields string
        extras = []
        for key in ("request_id", "method", "path", "status_code", "duration_ms", "user_id", "ip", "action"):
            value = getattr(record, key, None)
            if value is not None:
                extras.append(f"{key}={value}")
        extra_str = f" [{', '.join(extras)}]" if extras else ""

        return f"{timestamp} {color}{record.levelname:8s}{self.RESET} {record.name}: {record.getMessage()}{extra_str}"


def setup_logging():
    """Configure logging based on RUNTIME_ENV."""
    runtime_env = getenv("RUNTIME_ENV", "dev")
    log_level = getenv("LOG_LEVEL", "INFO").upper()

    # Choose formatter
    formatter = JSONFormatter() if runtime_env == "prd" else HumanFormatter()

    # Configure root handler
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)

    # Set up root logger
    root = logging.getLogger()
    root.setLevel(getattr(logging, log_level, logging.INFO))
    root.handlers = [handler]

    # Reduce noise from noisy libraries
    for noisy in ("uvicorn.access", "httpcore", "httpx", "urllib3", "watchfiles"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    # Uvicorn uses its own access log — keep error level only
    logging.getLogger("uvicorn.error").setLevel(logging.INFO)

    # Silence Agno's noisy 404 "Session with ID ... not found" warnings
    class _SessionNotFoundFilter(logging.Filter):
        def filter(self, record: logging.LogRecord) -> bool:
            msg = record.getMessage()
            return "Session with ID" not in msg and "404 Session" not in msg

    for n in ("agno", "uvicorn.error", "fastapi"):
        logging.getLogger(n).addFilter(_SessionNotFoundFilter())

    return logging.getLogger("legalscout")


def get_logger(name: str) -> logging.Logger:
    """Get a named logger under the legalscout namespace."""
    return logging.getLogger(f"legalscout.{name}")
