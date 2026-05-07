# Legal Scout

AI-powered legal document automation system for Myanmar corporate law. Generate AGM minutes, director consents, shareholder resolutions and more through a natural language chat interface powered by AI.

---

## What It Does

- **Chat Interface** — Ask "Create AGM for City Holdings" and the AI agent finds the template, looks up company data, fills placeholders, generates the document
- **Template Management** — Upload Word `.docx` templates with `{{placeholders}}`, `[brackets]` or `{single}`, AI analyzes and trains on each template (15-step deep training)
- **Company Management** — Add companies via DICA PDF upload with **streaming AI extraction logs** (real-time terminal feed), or manual form entry
- **Document Generation** — Auto-fill templates with company data, ~92% auto-fill rate via dynamic field registry; download as `.docx`
- **Pixel-match Preview** — Inline PDF and Word preview rendered via LibreOffice → PDF → pdfjs canvas (works in Brave w/ shields up)
- **Deep Training** — AI analyzes templates for field types, legal references, document workflows, Q&A pairs, cross-template relationships
- **Dynamic Field Registry** — New templates auto-register their user_input fields; Edit Company UI renders inputs dynamically. Zero code changes per template.
- **Document Split-View** — Generated docs render side-by-side: pixel-match PDF left, placeholder values + validation stats right

---

## Quick Install (Any Server with Docker)

### Step 1: Clone

```bash
git clone https://github.com/raahulgupta07/CHLLegalScout.git
cd CHLLegalScout
```

### Step 2: Configure

```bash
cp .env.example .env
```

Edit `.env` with your values:

```bash
# REQUIRED — Get from https://openrouter.ai/keys
OPENROUTER_API_KEY=sk-or-v1-your-actual-key

# REQUIRED — Generate these (run each command, paste output into .env)
# openssl rand -hex 32
JWT_SECRET_KEY=paste-output-here

# openssl rand -base64 24
DB_PASS=paste-output-here

# REQUIRED — Your admin login (password must be 10+ characters)
ADMIN_EMAIL=admin@yourcompany.com
ADMIN_PASSWORD=YourStrongPassword123

# OPTIONAL — Change if port 80 is already used
PORT=80

# OPTIONAL — Keep defaults
DB_USER=scout
DB_DATABASE=legalscout
```

### Step 3: Build and Run

```bash
docker compose up -d --build
```

First build takes ~5 minutes (downloads images, installs dependencies). After that, starts in seconds.

### Step 4: Verify

```bash
# Check containers are running
docker compose ps

# Check health
curl http://localhost/health
```

You should see:
```json
{"status": "healthy", "environment": "production", "checks": {"database": {"status": "connected"}, "api_key": {"status": "set"}}}
```

### Step 5: Open and Setup

1. Open **http://your-server-ip** (or `http://localhost` if local)
2. Login with your `ADMIN_EMAIL` / `ADMIN_PASSWORD`
3. Go to `/admin/templates` — click **Upload** — select `.docx` template files
4. Go to `/admin/companies` — click **Create New Company** — upload DICA PDF or fill manually
5. Go to `/admin/templates` — click **Start Training** (trains AI on your templates)
6. Go to `/admin/companies` — click **Train Agent** (teaches AI about your companies)
7. Go to home page — start chatting: "Create AGM for [company name]"

---

## Engineer Pre-Flight Checklist

Run this before handing off:

```bash
# 1. Fresh nuke + redeploy
docker compose down -v
docker compose up -d --build

# 2. Wait for healthy
docker compose ps                       # both containers should say "healthy"

# 3. Verify endpoints
curl http://localhost:${PORT:-80}/health
# Expected: {"status":"healthy", ...}

# 4. Verify migrations applied
docker compose exec scout-api python -m db.migrate --status
# Expected: 10/10 applied

# 5. Verify admin auto-created
docker compose exec scout-db psql -U scout -d legalscout -c "SELECT email, role FROM users;"
# Expected: row with your ADMIN_EMAIL + role=admin

# 6. Login + sanity check
curl -X POST http://localhost:${PORT:-80}/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}"
# Expected: {"success":true,"token":"eyJ..."}
```

If all 6 pass → app ready for use.

---

## Resource Requirements

| Resource | Minimum | Recommended |
|---|---|---|
| CPU | 2 vCPU | 4 vCPU |
| RAM | 4 GB | 8 GB (Node + LibreOffice + Postgres + pgvector) |
| Disk | 20 GB | 40 GB SSD (Docker image ~2 GB + DB growth + uploaded docs) |
| Network | 100 Mbps | — needs outbound HTTPS to OpenRouter |
| OS | Linux x64 / macOS arm64 | Ubuntu 22.04 LTS |
| Docker | 24+ | latest |

**Build time**: ~5 minutes first build (downloads ~2 GB layers). Subsequent builds < 1 min if package files unchanged.

---

## Setup Order (zero state → working)

After Docker comes up, the app is empty. Follow this exact order:

1. **Login** as admin → http://localhost:${PORT}/login
2. **Upload templates** → `/admin/templates` → Upload `.docx` files (already shipped: 15 sample templates in `./documents/legal/templates/` mounted automatically)
3. **Add companies** → `/admin/companies` → Either:
   - Upload DICA PDF (AI extracts all fields automatically with streaming logs), OR
   - Click "Manual Entry" → fill the form
4. **Train** → `/admin/templates` → click **Start Training**. Each template runs the 15-step pipeline (~30s/template). Field registry auto-populates after each training.
5. **Fill custom fields** → `/admin/companies` → edit company → "Template Required Fields" section → fill any field marked TBD (auditor name, financial year end, etc.). These come from registry auto-discovered during training.
6. **Chat** → `/` → "Create AGM for ARCTIC SUN COMPANY LIMITED" → agent generates document.

Skipping training = generation works but agent gives generic answers. Skipping custom fields = TBD placeholders in output.

---

## Install on AWS (EC2)

### Step 1: Launch EC2 Instance

- **AMI**: Ubuntu 22.04 LTS
- **Instance type**: `t3.medium` (2 CPU, 4GB RAM) or larger
- **Storage**: 30GB+ SSD
- **Security Group**: Allow inbound ports:
  - 22 (SSH)
  - 80 (HTTP) or your chosen PORT
  - 443 (HTTPS, if using SSL)

### Step 2: SSH and Install Docker

```bash
ssh -i your-key.pem ubuntu@your-ec2-ip

# Update system
sudo apt update && sudo apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Install Docker Compose plugin
sudo apt install -y docker-compose-plugin

# Logout and login again for docker group to take effect
exit
ssh -i your-key.pem ubuntu@your-ec2-ip

# Verify
docker --version
docker compose version
```

### Step 3: Clone and Configure

```bash
cd /opt
sudo git clone https://github.com/raahulgupta07/CHLLegalScout.git legalscout
sudo chown -R $USER:$USER /opt/legalscout
cd /opt/legalscout

# Create .env
cp .env.example .env

# Generate secrets and edit
echo "JWT_SECRET_KEY=$(openssl rand -hex 32)"
echo "DB_PASS=$(openssl rand -base64 24)"

nano .env
# Paste your OPENROUTER_API_KEY, generated secrets, admin credentials
```

### Step 4: Deploy

```bash
docker compose up -d --build

# Verify
docker compose ps
curl http://localhost/health
```

### Step 5: Access

Open `http://your-ec2-public-ip` in your browser.

### Optional: Add HTTPS with Nginx

```bash
# Install nginx and certbot
sudo apt install -y nginx certbot python3-certbot-nginx

# Point your domain to EC2 IP (via Route 53 or DNS provider)

# Create nginx config
sudo tee /etc/nginx/sites-available/legalscout <<'NGINX'
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://localhost:80;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        client_max_body_size 50M;
    }
}
NGINX

sudo ln -s /etc/nginx/sites-available/legalscout /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# Get SSL certificate
sudo certbot --nginx -d yourdomain.com

# Auto-renew
sudo certbot renew --dry-run
```

---

## Install on Any VPS (DigitalOcean, Linode, Hetzner, etc.)

Same as AWS steps 2-5 above. Any Linux server with Docker works:

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Clone and configure
git clone https://github.com/raahulgupta07/CHLLegalScout.git
cd CHLLegalScout
cp .env.example .env
nano .env   # Fill in your values

# Deploy
docker compose up -d --build

# Done
curl http://localhost/health
```

---

## Port Conflicts

If port 80 is already used by another service on the same server:

```bash
# Option 1: Change port in .env
PORT=8080

# Then access at http://your-server:8080

# Option 2: Use nginx reverse proxy (recommended for production)
# See "Add HTTPS with Nginx" section above
# Set PORT=8080 and proxy from nginx port 80 → 8080
```

---

## Architecture

```
Internet → Port 80 (or $PORT)
              │
    ┌─────────▼──────────────────────────────────┐
    │  scout-api (Node 22 + Python 3.12)          │
    │  (FastAPI + Next.js static frontend)         │
    │                                              │
    │  /api/*        → REST API (50+ endpoints)    │
    │  /agents/*     → AI chat (streaming)         │
    │  /documents/*  → file downloads              │
    │  /health       → health check                │
    │  /*            → frontend (React)            │
    └─────────┬──────────────────────────────────┘
              │ internal
    ┌─────────▼──────────────────────────────────┐
    │  scout-db                                    │
    │  (PostgreSQL 18 + pgvector)                  │
    │  13+ tables, vector search                   │
    └──────────────────────────────────────────────┘
```

**2 Docker containers. 1 external port. No other dependencies.**

### Why this stack
- **FastAPI + Agno** — agentic framework w/ memory, tool calls, streaming. Production-grade.
- **Next.js static export** — no Node runtime in production. FastAPI serves baked HTML/JS.
- **PostgreSQL 18 + pgvector** — single DB for relational + vector. No Redis/Pinecone needed.
- **LibreOffice in container** — pixel-match Word→PDF conversion server-side. Required for fidelity preview.
- **OpenRouter** — single API key for GPT, Gemini, Claude. Switch models from admin UI without redeploy.
- **JSONB `custom_fields`** — adding new template fields needs zero migrations or schema changes. Auto-discovered after training.

### Data Flow

```
Admin uploads template.docx
   │
   └──> 15-step training pipeline
        ├── Extract {{placeholders}}, {single}, [bracket]
        ├── AI metadata (Gemini 3 Flash)
        ├── Classify db_field vs user_input (Gemini 3.1 Lite)
        ├── Map fields → DB columns
        ├── Vector embed (text-embedding-3-small)
        ├── PDF preview (LibreOffice)
        ├── Deep field analysis × 6 (legal refs, sample fill, workflow, Q&A, cross-rels)
        └── Auto-refresh field registry  ← NEW v1.1.0

User chats "Create AGM for ARCTIC SUN"
   │
   └──> Agent (scout)
        ├── find_matching_templates("AGM") → "Annual General Meeting Minutes.docx"
        ├── prepare_document(template, company) → preview + missing fields
        ├── generate_document(...) → fill_template_with_validation
        │       ├── Priority 1: trained field_mapping (db_column or default)
        │       ├── Priority 2: companies table column (auditor_name, etc.)
        │       ├── Priority 3: companies.custom_fields[key] JSONB  ← NEW v1.1.0
        │       ├── Priority 4: user-provided custom_data (chat)
        │       └── Priority 5: smart defaults (today, registered_office, "they") OR "TBD"
        └── record_document → documents table → download link
```

---

## Features

### Chat Interface (DASH-inspired brutalist design)
- Natural language document requests
- AI agent with 27+ tools (document generation, company lookup, template intelligence, knowledge base, email, web search)
- DASH-style CLI terminal blocks showing tool execution (`$ scout exec --agent legal`)
- Streaming animation with green cursor blink + traffic light dots
- Answer box with stamp shadow, streaming indicator until complete
- COPY button on every response
- LLM-powered auto-suggestions after each response (`POST /api/suggest-followups`)
- Collapsible trace toggle (`$ trace`) showing tool calls + duration
- Session tag (`LEGAL SCOUT · 02:08 PM`) at top of chat
- Status bar (`SYSTEM_ACTIVE | POWERED BY AI AGENT | LEGAL SCOUT · MYANMAR`)
- User messages right-aligned with dark bubble, agent messages left-aligned with CLI + answer box
- Option buttons (a/b/c/d/e) for clarification
- Document download cards
- Session history with agent name + time ago

### AI Agent Capabilities (27+ Tools)
- **Document Generation** — `generate_document`, `create_document`, `prepare_document`, `preview_document`, `analyze_template`
- **Company Lookup** — `get_company`, `get_directors`, `get_shareholders`, `check_company`, `list_companies`
- **Template Intelligence** — `list_templates`, `analyze_new_template`, `find_matching_templates`, `get_template_data`, `get_data_for_template`
- **Knowledge Base** — `search_knowledge` (semantic vector search), `lookup_knowledge` (fast key-value), `quick_info`
- **Document Tracking** — `list_tracked_documents`, `get_document_info`, `get_document_stats`
- **Communication** — `send_email` (with optional document attachment, requires SMTP config)
- **File Operations** — `read_file`, `list_files`, `save_file`, `search_content`
- **Web Search** — `web_search_exa` (optional, requires `EXA_API_KEY`)

### Template Management (`/admin/templates`)
- Upload `.docx` Word templates
- 15-step deep AI training per template (streamed via SSE in real-time):

| Step | What | AI Model |
|------|------|----------|
| 1 | Extract `{{placeholders}}` from `.docx` | Local (regex) |
| 2 | Read full document text | Local |
| 3 | AI analysis (category, purpose, when_to_use, legal refs) | Gemini 3 Flash |
| 4 | Save metadata to DB (37 columns) | DB write |
| 5 | Classify fields: `db_field` vs `user_input` | Gemini 3.1 Flash Lite |
| 5.5 | Map placeholders to exact DB columns | Gemini 3.1 Flash Lite |
| 6 | Store in knowledge base (vector + lookup) | DB write |
| 7 | Generate vector embedding (1536 dimensions) | text-embedding-3-small |
| 8 | PDF preview with yellow-highlighted placeholders | LibreOffice |
| 9 | Deep field analysis (type, format, validation) | Gemini 3 Flash |
| 10 | Legal reference extraction (Myanmar Companies Law 2017) | Gemini 3 Flash |
| 11 | Sample filled document (realistic Myanmar data) | Gemini 3 Flash |
| 12 | Document workflow (trigger, before/after docs) | Gemini 3 Flash |
| 13 | Q&A pairs (10 practical questions + answers) | Gemini 3 Flash |
| 14 | Cross-template relationships | Gemini 3 Flash |
| 15 | Confidence score (0-100%) | Local calculation |

- **~9 AI calls per template** — cost-optimized with Gemini models (70-94% cheaper than Claude)
- Real-time streaming training logs
- Template detail popup with all metadata
- Confidence score per template (0-100%)
- PDF preview with highlighted placeholders
- Download original templates

### Company Management (`/admin/companies`)
- Add via **DICA PDF upload** (AI extracts all fields automatically)
- Add via **manual form** entry
- Full CRUD (view, edit, delete)
- Directors and shareholders management
- Company completeness indicator
- Real-time streaming training with per-company AI analysis
- Compliance status, risk flags, missing data detection

### Document Generation
- Auto-fill Word templates with company data
- Validate filled documents (report unfilled placeholders)
- Download generated `.docx` files
- Document history with date filtering
- Version tracking

### Admin Panel
- **Dashboard** — KPIs, stats, recent activity
- **Documents** — Generated document history
- **Templates** — Upload, train, preview
- **Companies** — Add, edit, train
- **Knowledge** — AI training status
- **Users** — User management (admin/editor/user roles)
- **Settings** — AI models, S3 storage, email, timezone
- **Emails** — Email sending logs

### Security
- JWT authentication on all API endpoints (no unprotected routes)
- bcrypt password hashing, 10-character minimum passwords
- Role-based access control (admin, editor, user)
- CORS protection (same-origin enforced, wildcard explicitly rejected)
- Path traversal protection on all file-serving endpoints
- SQL injection protection (parameterized queries, column whitelists on restore)
- Prompt injection sanitization on AI agent input
- Login timing attack protection (constant-time responses)
- File upload size streaming validation
- Security headers (HSTS, X-Frame-Options, iframe sandboxing, XSS prevention)
- Activity audit logging
- Centralized DB connections via `get_db_conn()` (no hardcoded credentials)
- Centralized OpenRouter URL via `OPENROUTER_BASE_URL` env var
- Chat input size limit (50KB) enforced on backend
- All document directories auto-created at startup
- All exception handlers log warnings (no silent failures)
- All exceptions logged (no silent failures)
- All DB connections use try-finally (no connection leaks)
- Log rotation (10MB x 3 files)
- Non-root Docker user with gosu privilege drop
- Entrypoint auto-fixes bind-mount permissions

### Storage
- Local filesystem (Docker volume, persists across restarts)
- Optional S3 cloud storage (AWS S3, MinIO, Cloudflare R2, Backblaze B2)
- Configure S3 from admin Settings — no .env changes needed
- S3 syncs templates, generated docs, DICA PDFs

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| **Frontend** | Next.js 15, React 18, TypeScript, Tailwind CSS, Zustand, Radix UI, Framer Motion |
| **Backend** | FastAPI 0.129, Python 3.12, Agno 2.5 (AI agent framework) |
| **Database** | PostgreSQL 18 + pgvector (vector similarity search) |
| **AI Models** | GPT-5.4 Mini (chat), Gemini 3 Flash (training), Gemini 3.1 Flash Lite (classification), text-embedding-3-small — all via OpenRouter |
| **Document** | python-docx (Word), LibreOffice (PDF conversion), openpyxl (Excel parsing) |
| **Auth** | JWT (PyJWT) + bcrypt |
| **Deploy** | Docker Compose, single multi-stage Dockerfile (Node 22 build stage) |
| **Monitoring** | Prometheus + Grafana (optional) |

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key for all AI operations |
| `JWT_SECRET_KEY` | Yes | JWT signing key (`openssl rand -hex 32`) |
| `ADMIN_PASSWORD` | Yes | Admin login password (10+ chars) |
| `DB_PASS` | Yes | Database password (`openssl rand -base64 24`) |
| `ADMIN_EMAIL` | Yes | Admin login email |
| `DB_USER` | No | Database user (default: `scout`) |
| `DB_DATABASE` | No | Database name (default: `legalscout`) |
| `PORT` | No | External port (default: `80`) |

**Everything else is configured from the admin UI:**
AI models, email/SMTP, S3 storage, timezone.

---

## Commands Reference

```bash
# Start
docker compose up -d --build

# Stop
docker compose down

# View logs
docker compose logs -f scout-api

# Check status
docker compose ps
curl http://localhost/health

# Update to latest version
git pull
docker compose up -d --build

# Reset database (WARNING: deletes all data)
docker compose down -v
docker compose up -d --build

# Check database
docker compose exec scout-db psql -U scout -d legalscout -c "SELECT COUNT(*) FROM templates;"

# Run migrations manually
docker compose exec scout-api python -m db.migrate
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Port 80 taken | Set `PORT=8080` in `.env` |
| "SECURITY FATAL" on startup | Set strong `JWT_SECRET_KEY` (64 chars) and `ADMIN_PASSWORD` (10+ chars) |
| Health check returns 503 | `docker compose logs scout-db` — check DB credentials |
| Cannot create user — "Request failed" | Password must be ≥10 chars; see browser DevTools Network for exact error |
| Doc preview blank in Brave | Hard reload (`Cmd+Shift+R`); canvas viewer self-hosts pdfjs worker |
| Generated docs full of TBD | Click **Refresh Field Registry** in Companies, then fill new fields in Edit Company. Auto-runs after each `Start Training`. |
| New columns missing after deploy | `docker compose exec scout-api python -m db.migrate` |
| Container build OOM | Bump host RAM to 8 GB OR add `--memory=4g` to Docker daemon. Node `next build` is the heavy step. |
| `pnpm install` fails behind firewall | Set `HTTPS_PROXY` in build env, or pre-cache `pnpm-store` |
| Brave: PDF preview blank | Hard reload `Cmd+Shift+R` once after build. Canvas viewer is shields-safe. |
| Logs full of `404 /sessions/{id}/runs` | Already silenced to INFO. Cosmetic — frontend pre-fetches before session created. |
| Template generated 100% TBD | Train templates first (Templates page → Start Training). Then fill custom_fields per company. |
| LibreOffice convert timeout | First convert per file ~5s. If consistently >30s: bump container CPU; conversion happens once then cached in `/documents/legal/previews/`. |
| Port 80 conflict on macOS | `PORT=8080` in `.env`. macOS reserves port 80 for some Apple services. |
| `Authentication required` on preview | Hard reload — frontend caches old chunk. Endpoints accept `Authorization: Bearer` header now. |
| Admin user not created | Check `docker compose logs scout-api | grep "Admin user created"`. If missing, verify `ADMIN_EMAIL`/`ADMIN_PASSWORD` in `.env` (10+ chars). |
| Two users see same chat history | Was a bug pre-v1.1.0; fixed. Hard reload after upgrade — frontend now sends `user_id` filter. |
| Agno `agno_*` tables missing | These auto-create on first agent run, not via migrate. Send any chat message to bootstrap. |
| Can't login | Verify `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env`, then `docker compose restart` |
| Templates not showing | Upload via `/admin/templates` |
| Companies not showing | Add via `/admin/companies` |
| Agent gives generic answers | Train both templates and companies first |
| Download links broken | `docker compose restart scout-api` |
| Build fails | `docker compose build --no-cache` |
| Disk full | `docker system prune -f` |
| Container keeps restarting | `docker compose logs scout-api --tail 50` — check for errors |

---

## Project Structure

```
CHLLegalScout/
├── app/                          # FastAPI backend
│   ├── main.py                   # API server (50+ endpoints)
│   ├── model_config.py           # AI model configuration
│   ├── s3_storage.py             # S3 cloud storage
│   └── logging_config.py         # Structured logging
├── agent-ui/                     # Next.js frontend
│   ├── src/app/                  # Pages (chat, admin, login)
│   ├── src/components/           # UI components
│   └── src/lib/                  # API client, utilities
├── scout/                        # AI agent
│   ├── agent.py                  # Agent definition + system prompt
│   └── tools/                    # 11 tool modules
├── db/                           # Database
│   ├── init.sql                  # Schema
│   └── migration_*.sql           # Migrations
├── documents/                    # File storage (Docker volume)
│   └── legal/
│       ├── templates/            # Uploaded .docx templates
│       ├── output/               # Generated documents
│       ├── uploads/              # DICA PDF uploads
│       └── previews/             # Cached PDF previews
├── compose.yaml                  # Docker Compose
├── Dockerfile                    # Multi-stage build (Node 22 + Python 3.12)
├── .env.example                  # Environment template
├── DEPLOY.md                     # Deployment guide
└── CLAUDE.md                     # Technical documentation
```

---

## License

Private repository. All rights reserved.
