# ============================================================================
# Legal Scout — Single-Image Production Dockerfile
# ============================================================================
# Stage 1: Build Next.js frontend → static HTML/JS/CSS
# Stage 2: Python API + frontend static files in one container
# ============================================================================

# --- Stage 1: Build Frontend ---
FROM node:22-alpine AS frontend-builder

WORKDIR /frontend

# Install pnpm (pinned — pnpm v10+ blocks postinstall and breaks build)
RUN npm install -g pnpm@9.15.4

# Install deps (cached layer)
# --ignore-scripts: skip native builds (canvas needs cairo/pango not in alpine; sharp ships prebuilt binary fetched on demand)
COPY agent-ui/package.json agent-ui/pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --ignore-scripts \
    && pnpm rebuild sharp || true

# Copy source and build
COPY agent-ui/ ./

# Build arg: empty = same-origin (single port)
ARG NEXT_PUBLIC_API_URL=""
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}

RUN pnpm build
# Output: /frontend/out/ (static HTML/JS/CSS)

# --- Stage 2: Python API + Frontend ---
FROM agnohq/python:3.12

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app

# ---------------------------------------------------------------------------
# Install system dependencies + gosu for secure privilege drop
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-writer libreoffice-common fonts-noto-core fonts-noto-cjk \
    curl tini gosu \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# ---------------------------------------------------------------------------
# Create non-root user
# ---------------------------------------------------------------------------
RUN groupadd -g 61000 app \
    && useradd -g 61000 -u 61000 -ms /bin/bash app

# ---------------------------------------------------------------------------
# Python dependencies (cached layer)
# ---------------------------------------------------------------------------
WORKDIR /app

COPY requirements.txt ./
RUN uv pip install -r requirements.txt pdfplumber bcrypt --system \
    && rm -rf /root/.cache /tmp/*

# ---------------------------------------------------------------------------
# Application code
# ---------------------------------------------------------------------------
COPY --chown=app:app . .

# ---------------------------------------------------------------------------
# Copy frontend build output
# ---------------------------------------------------------------------------
COPY --from=frontend-builder --chown=app:app /frontend/out /app/static-frontend

# ---------------------------------------------------------------------------
# Ensure document directories exist
# ---------------------------------------------------------------------------
RUN mkdir -p /documents/legal/templates /documents/legal/data /documents/legal/output \
    /documents/legal/uploads /documents/legal/previews /documents/legal/knowledge \
    /documents/legal/extracts \
    && chown -R app:app /documents

# ---------------------------------------------------------------------------
# Entrypoint — starts as root to fix bind-mount permissions, then drops to app
# ---------------------------------------------------------------------------
RUN chmod +x /app/scripts/entrypoint.sh

EXPOSE 8000

ENTRYPOINT ["tini", "--", "/app/scripts/entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
