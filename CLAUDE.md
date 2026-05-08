# CLAUDE.md — Legal Scout

## Project Overview

**Legal Scout** is a legal document automation system for **Myanmar corporate law**. It generates legal documents (AGM minutes, director consents, shareholder resolutions, etc.) from Word templates using company data stored in PostgreSQL. An AI agent (Agno framework) powers a chat interface for natural language document requests.

**All data is managed from the admin panel** — no pre-loaded templates or companies ship with the project.

---

## Quick Start

```bash
cp .env.example .env    # Fill in OPENROUTER_API_KEY + generate secrets
docker compose up -d --build
# Open http://localhost (or http://localhost:PORT)
# Login: ADMIN_EMAIL / ADMIN_PASSWORD from .env
```

### Setup Flow
1. Upload templates → `/admin/templates`
2. Add companies → `/admin/companies` (DICA PDF or manual)
3. Train agent → click "Train Agent" + "Start Training"
4. Chat → generate documents

---

## Architecture

```
Port 80 (configurable via PORT in .env)
  │
  └── scout-api (FastAPI + Next.js static frontend)
        ├── /api/*        → 50+ REST endpoints
        ├── /agents/*     → AI chat (streaming)
        ├── /documents/*  → file downloads
        ├── /*            → frontend (Next.js static)
        │
        └── scout-db (PostgreSQL 18 + pgvector, internal)
              └── 13+ tables
```

**2 containers. 1 port. Production only.**

### Tech Stack
| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 15, React 18, TypeScript, Tailwind, Zustand, Radix UI, Space Grotesk font |
| Backend | FastAPI, Agno 2.5, python-docx, psycopg, SQLAlchemy |
| AI | Configurable via Settings: GPT-5.4 Mini (chat), Gemini 3 Flash (training), Gemini 3.1 Flash Lite (classification), text-embedding-3-small — all via OpenRouter (base URL configurable via `OPENROUTER_BASE_URL` env var) |
| Database | PostgreSQL 18 + pgvector |
| Auth | JWT + bcrypt (timing-attack-safe login) |
| Storage | Local filesystem + optional S3 (AWS, MinIO, R2, B2) |
| Deploy | Docker Compose, single-port, Node 22, gosu for privilege drop, production-only |

---

## .env Configuration

Only infrastructure secrets. Everything else configured from admin UI.

```bash
OPENROUTER_API_KEY=...    # Required — AI chat/training
ADMIN_EMAIL=...           # Required — admin login
ADMIN_PASSWORD=...        # Required — 10+ chars
JWT_SECRET_KEY=...        # Required — openssl rand -hex 32
DB_USER=scout             # Database user
DB_PASS=...               # Required — raises ValueError if unset (openssl rand -base64 24)
DB_DATABASE=legalscout    # Database name
PORT=80                   # Change if port 80 is taken
EXA_API_KEY=...           # Optional — only loaded when set, never embedded in URLs
```

**Configured from Admin UI (not .env):**
- AI models (chat, training, embeddings)
- Email/SMTP
- S3 storage
- Timezone

---

## Key Files

### Backend
| File | Purpose |
|------|---------|
| `app/main.py` | FastAPI app, 50+ endpoints, auth, admin, training |
| `scout/agent.py` | AI agent definition, 27+ tools, system prompt, prompt injection sanitizer |
| `scout/tools/smart_doc.py` | Document generation, placeholder fill (thread-safe, no globals) |
| `scout/tools/clarification.py` | Template/company matching |
| `scout/tools/companies_db.py` | Company DB queries |
| `scout/tools/knowledge_base.py` | Knowledge storage/search |
| `scout/tools/template_analyzer.py` | Template analysis, field classification |
| `app/s3_storage.py` | Optional S3 cloud storage |
| `app/model_config.py` | AI model configuration (DB-backed) |
| `app/connection.py` | DB connection (DB_PASS validated) |
| `app/url.py` | DB URL builder (DB_PASS validated) |
| `db/init.sql` | Database schema |
| `db/migration_001_template_fields.sql` | Template field additions |
| `db/migration_002_hardening.sql` | Security hardening |
| `db/migration_003_activity_tracking.sql` | Activity tracking |
| `db/migration_004_email_logs.sql` | Email logging |
| `db/migration_005_financial_year.sql` | Financial year support |
| `db/migration_006_field_mapping.sql` | Field mapping |
| `db/migration_007_deep_training.sql` | Deep training support |
| `db/migration_008_fix_user_role_constraint.sql` | User role constraint (adds 'editor') |
| `db/migration_009_company_extra_fields.sql` | `auditor_name`, `auditor_fee`, `next_financial_year_end_date` columns |
| `db/migration_010_dynamic_fields.sql` | `custom_fields JSONB` + `company_field_registry` table |

### Frontend
| File | Purpose |
|------|---------|
| `agent-ui/src/app/page.tsx` | Chat interface (input capped at 5000 chars) |
| `agent-ui/src/app/login/page.tsx` | Brutalist login page (Space Grotesk, warm yellow, ink borders) |
| `agent-ui/src/app/admin/templates/page.tsx` | Template upload, training, preview (DocViewer + LibreOffice PDF) |
| `agent-ui/src/app/admin/companies/page.tsx` | Company management (PDF/manual + dynamic field registry section + streaming extract logs) |
| `agent-ui/src/app/admin/dashboard/page.tsx` | Dashboard KPIs |
| `agent-ui/src/app/admin/documents/page.tsx` | Generated documents (split-view: PDF left, placeholder values right, back button) |
| `agent-ui/src/components/ui/DocViewer.tsx` | Unified PDF/DOCX dispatcher; forces PdfViewer for `/preview-pdf/` paths |
| `agent-ui/src/components/ui/PdfViewer.tsx` | Canvas PDF render via pdfjs-dist (Brave-shields-safe, sends Bearer header) |
| `agent-ui/src/components/ui/DocxViewer.tsx` | Client-side docx render via docx-preview (sends Bearer header) |
| `agent-ui/src/lib/api-client.ts` | API endpoint URLs |
| `agent-ui/src/store.ts` | Zustand state |
| `agent-ui/src/app/globals.css` | Global styles + brutalist utilities (.ink-border, .stamp-shadow, .tag-label, .stamp-press) |
| `agent-ui/src/app/layout.tsx` | Root layout (Space Grotesk font) |

### Config
| File | Purpose |
|------|---------|
| `compose.yaml` | Docker Compose (2 containers) |
| `Dockerfile` | Multi-stage build (Node 22 + Python), gosu privilege drop |
| `scripts/entrypoint.sh` | Container startup: fix permissions as root, drop to app user, DB wait + migrations |
| `.env.example` | Environment template |
| `DEPLOY.md` | Deployment guide |

---

## Agent Tools (27+)

### Document Generation
| Tool | Purpose |
|------|---------|
| `generate_document` | Fill template with company data, produce `.docx` |
| `create_document` | Create a new document record |
| `prepare_document` | Preview/prepare document before final generation |
| `preview_document` | Preview document with highlighted placeholders |
| `analyze_template` | Analyze a Word template's structure |

### Company Lookup
| Tool | Purpose |
|------|---------|
| `get_company` | Full company data from DB |
| `get_directors` | Directors list for a company |
| `get_shareholders` | Shareholders/members for a company |
| `check_company` | Verify company exists + data completeness |
| `list_companies` | List all available companies |

### Template Intelligence
| Tool | Purpose |
|------|---------|
| `list_templates` / `get_known_templates` | List all trained templates |
| `analyze_new_template` | Deep-analyze a newly uploaded template |
| `save_template_to_knowledge` | Save template analysis to KB |
| `find_matching_templates` | Find templates matching a user request |
| `get_template_data` | Full training data for a template |
| `get_data_for_template` | Company data mapped to template fields |

### Knowledge Base
| Tool | Purpose |
|------|---------|
| `search_knowledge` | Semantic vector search across KB |
| `lookup_knowledge` | Fast key-value lookup |
| `list_knowledge_sources` | List all knowledge sources |
| `quick_info` | Fast factual lookups |

### Document Tracking
| Tool | Purpose |
|------|---------|
| `list_tracked_documents` | List generated documents with filters |
| `get_document_info` | Details of a specific document |
| `get_document_stats` | Document generation statistics |

### Other
| Tool | Purpose |
|------|---------|
| `get_clarification_info` | Clarify ambiguous requests |
| `send_email` | Email with optional document attachment (requires SMTP) |
| `read_file` / `list_files` / `save_file` | File operations in documents dir |
| `search_content` | Search within document file contents |
| `web_search_exa` | Web search via Exa API (optional, if `EXA_API_KEY` set) |

---

## Data Flow

### Document Generation
```
User: "Create AGM for City Holdings"
  → Agent identifies template + company
  → Reads company from DB
  → Fills {{placeholders}} in .docx
  → Saves to /documents/legal/output/
  → Returns download link
```

### Company Data Sources (all via admin UI)
- **DICA PDF upload** → AI extracts fields → saves to companies table
- **Manual form entry** → saves to companies table
- **No Excel files** — everything is DB-only

### Template Training Pipeline (15 steps)

Triggered from `/admin/templates` → "Train Agent" → "Start Training". Streams progress via SSE.

| Step | What | AI Model | Output |
|------|------|----------|--------|
| 1 | Extract `{{placeholders}}` from `.docx` | None (local regex) | Field list |
| 2 | Read full document text (paragraphs + tables) | None (local) | Content string |
| 3 | AI analysis (category, purpose, when_to_use, legal refs) | Gemini 3 Flash | JSON metadata |
| 4 | Save metadata to `templates` table (37 columns) | None (DB write) | — |
| 5 | Classify fields: `db_field` vs `user_input` | Gemini 3.1 Flash Lite | Classification JSON |
| 5.5 | Map placeholders → exact DB columns | Gemini 3.1 Flash Lite | Field mapping JSON |
| 6 | Store in `knowledge_vec` + `knowledge_lookup` | None (DB write) | KB entries |
| 7 | Generate vector embedding | text-embedding-3-small | 1536-dim vector |
| 8 | Create PDF preview (yellow-highlighted placeholders) | None (LibreOffice) | Cached PDF |
| 9 | Deep field analysis (type, format, validation per field) | Gemini 3 Flash | Per-field JSON |
| 10 | Legal reference extraction (Myanmar Companies Law 2017) | Gemini 3 Flash | Sections + compliance |
| 11 | Sample filled document (realistic Myanmar data) | Gemini 3 Flash | Sample values JSON |
| 12 | Document workflow (trigger, before/after docs) | Gemini 3 Flash | Workflow JSON |
| 13 | Q&A pairs (10 practical questions + answers) | Gemini 3 Flash | Stored in `knowledge_vec` |
| 14 | Cross-template relationships (prerequisite/follow-up/related) | Gemini 3 Flash | Relationships JSON |
| 15 | Confidence score (0-100%) based on which steps passed | None (local calc) | Score integer |

**AI calls per template: ~9 total** — 1x Gemini 3 Flash (step 3) + 2x Gemini 3.1 Flash Lite (steps 5, 5.5) + 1x text-embedding-3-small (step 7) + 6x Gemini 3 Flash (steps 9-14)

---

## Database Tables

| Table | Purpose |
|-------|---------|
| `templates` | Template metadata (37 columns, deep training data) |
| `companies` | Company data (DICA format, directors/members JSONB) |
| `documents` | Generated document records |
| `knowledge_lookup` | Fast key-value search |
| `knowledge_vec` | Semantic search (pgvector embeddings) |
| `knowledge_raw` | Raw KB data |
| `knowledge_sources` | Synced KB file tracking |
| `users` | Authentication (email, hashed password, role: admin/user/editor) |
| `activity_logs` | Audit trail |
| `training_status` | AI training state |
| `app_settings` | Runtime configuration (models, S3, SMTP) |
| `document_versions` | Version tracking |
| `template_versions` | Template versioning |
| `company_field_registry` | Dynamic per-template user_input field registry (auto-populated after training) |
| `companies.custom_fields` | JSONB column — per-company key/value overrides for any field discovered by training |
| `schema_migrations` | Tracks applied SQL migration files (driven by `python -m db.migrate`) |

---

## Security

### Authentication & Authorization
- JWT authentication with bcrypt password hashing
- Login timing-attack protection (dummy bcrypt check when user not found)
- Minimum password length: 10 characters
- Strong secrets enforced on startup (blocks weak JWT/admin password)
- Auth required on all endpoints: 15 previously unprotected endpoints now require JWT (template upload/delete, training, export, company CRUD)
- Preview PDF endpoints require JWT token query param
- User role constraint: admin, user, editor

### Input Validation & Injection Protection
- SQL injection: parameterized queries throughout (including LIMIT clauses)
- SQL injection in restore endpoint: column whitelist per table + regex validation
- Prompt injection sanitizer in agent system prompt (`_sanitize_for_prompt` strips instruction-override patterns)
- Chat input capped at 5000 characters (frontend)
- `custom_data` protected fields cannot be overridden (company_name, directors, etc.)
- Export queries have LIMIT 10000

### XSS & Frontend Security
- `rehypeRaw` removed from MarkdownRenderer (prevents XSS from AI output)
- `sandbox="allow-same-origin"` on all iframes (5 files)
- `res.ok` checks on all fetch calls across all pages
- Empty catch blocks replaced with logged errors

### File & Path Security
- Path traversal protection on 8 file-serving endpoints (`.resolve()` + `startswith` check)
- File upload streams in chunks (no large memory spikes)

### Network & Infrastructure
- CORS: same-origin default, wildcard explicitly rejected
- Security headers (HSTS, X-Frame-Options, etc.)
- Non-root Docker user (gosu privilege drop in entrypoint)
- SSE generators wrapped in try-finally for connection cleanup
- AbortController added to frontend SSE streams (templates + companies)
- Log rotation (10MB x 3 files per container)

### Resource & Connection Management
- 30+ DB connection leaks fixed with try-finally across all backend files
- 40+ bare `except: pass` replaced with logged exceptions
- 7 AI API calls now have `raise_for_status()` before `.json()`
- EXA API key only loaded when set, never embedded in URL when empty
- DB_PASS raises ValueError if not set (connection.py, url.py, migrate.py)
- Document tracker: `fetchone()` None-safe, double-fetchall fixed
- Activity audit logging

---

## API Endpoints (key ones)

```
POST /api/auth/login                          # JWT login
GET  /api/dashboard/data                      # Companies, templates, documents
GET  /api/dashboard/stats                     # KPIs
POST /api/dashboard/upload/template           # Upload .docx (auth required)
POST /api/dashboard/add/company               # Add company (auth required)
DELETE /api/dashboard/company/{name}          # Delete company (auth required)
DELETE /api/dashboard/document/{id}           # Delete document (auth required)
GET  /api/knowledge/train-stream/{template}   # SSE training stream (15 steps, auth required)
GET  /api/knowledge/train-companies-stream    # SSE company training stream (auth required)
POST /api/knowledge/deep-train                # Batch train all templates (auth required)
GET  /api/templates/preview-pdf/{name}        # PDF preview (JWT token query param)
POST /api/company/extract-pdf-stream          # AI extract from DICA PDF (ND-JSON streaming logs)
GET  /api/dashboard/document-detail/{id}      # Full doc record incl custom_data + validation_result
GET  /api/dashboard/field-registry            # Auto-discovered user_input field list
POST /api/dashboard/field-registry/refresh    # Rebuild registry from templates table (auto-runs after training)
GET  /api/templates/preview-pdf/{name}        # docx→PDF (LibreOffice). Accepts ?token= or Authorization header
GET  /api/documents/preview-pdf/{name}        # output docx→PDF preview. Accepts ?token= or Authorization header
POST /agents/scout/runs                       # AI chat (streaming)
POST /api/suggest-followups                    # LLM-powered follow-up suggestions
GET  /health                                  # Health check
```

---

## Design System

**DASH-inspired brutalist aesthetic** — industrial/command-center feel across all pages. Inspired by City-Dash.

### Colors
| Token | Value | Usage |
|-------|-------|-------|
| Surface (page bg) | `#feffd6` | Chat area, admin pages |
| Surface bright | `#fffff0` | Answer boxes, cards |
| On-surface (text) | `#383832` | Primary text, borders |
| Primary (green) | `#007518` | Active states, borders |
| Primary neon | `#00fc40` | CLI prompts, send button, NEW CHAT button |
| Error | `#be2d06` | Destructive actions, cancel |
| Warning | `#ff9d00` | Traffic light dot |
| Terminal dark | `#262622` | CLI blocks, user bubbles |

### Typography
- **Font:** Space Grotesk (loaded in layout.tsx), weight 900 for headers
- **Pattern:** Uppercase, letter-spacing 0.05-0.15em, font-black

### CSS Utilities (globals.css)
- `.ink-border` — Asymmetric 2px/3px letterpress border
- `.stamp-shadow` — Hard 4px offset shadow
- `.tag-label` — Dark tag with yellow text (form labels)
- `.stamp-press` — Button press translate effect
- `.brutalist` — Zero border-radius override
- `@keyframes cursorBlink` — CLI green block cursor
- `@keyframes cliBlink` — Traffic light dots animation

### Chat UI (DASH-inspired)
- **User messages:** Right-aligned, dark bubble `#262622`, letterpress border (4px right/bottom)
- **Agent messages:** CLI terminal block (dark) + white answer box below with stamp shadow
- **CLI block:** Always visible — `$ scout exec --agent legal` → `> ✓ tool_name` → `$ done · N steps`
- **Streaming animation:** Green cursor `█` blink + traffic light dots `■■■` (green/orange/red)
- **Answer box loading:** Doc icon + traffic light dots, "STREAMING" label until complete
- **COPY button:** Under every answer, copies to clipboard
- **Trace toggle:** `$ trace ▼` collapsible showing tool calls + duration
- **Auto-suggestions:** LLM-powered via `POST /api/suggest-followups` (instant keyword fallback + async AI)
- **Session tag:** `LEGAL SCOUT · 02:08 PM` centered at top of chat
- **Status bar:** `SYSTEM_ACTIVE | POWERED BY AI AGENT | LEGAL SCOUT · MYANMAR`
- **Timestamps:** `02:08 PM · READ` (user) / `02:08 PM · AGENT` (agent) — 12hr AM/PM format

---

## Commands

```bash
# Deploy
docker compose up -d --build

# Check status
docker compose ps
curl http://localhost/health

# View logs
docker compose logs -f scout-api

# Update
git pull && docker compose up -d --build

# Stop
docker compose down

# Reset DB (WARNING: deletes all data)
docker compose down -v && docker compose up -d --build
```

---

## File Storage

| Directory | Purpose | S3 Sync |
|-----------|---------|---------|
| `/documents/legal/templates/` | Uploaded .docx templates | Yes |
| `/documents/legal/output/` | Generated documents | Yes |
| `/documents/legal/uploads/` | DICA PDF uploads | Yes |
| `/documents/legal/previews/` | PDF previews (cached) | No |
| `/documents/legal/extracts/` | DICA PDF extracts | No |
| `/documents/legal/knowledge/` | Knowledge base files | No |

S3 is optional — configure from Admin → Settings. Local filesystem is default.
All directories are auto-created at startup (defense-in-depth beyond Docker).

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Port 80 taken | Set `PORT=8080` in `.env` |
| "SECURITY FATAL" on startup | Set strong `JWT_SECRET_KEY` and `ADMIN_PASSWORD` in `.env` |
| Health returns 503 | Check DB: `docker compose logs scout-db` |
| Templates not showing | Upload via `/admin/templates` |
| Companies not showing | Add via `/admin/companies` |
| Agent gives generic answers | Click "Train Agent" + "Start Training" |
| Download links broken | Restart: `docker compose restart scout-api` |
| DB_PASS ValueError on startup | Set `DB_PASS` in `.env` — no longer optional |
| `ERR_PNPM_IGNORED_BUILDS` during build | Dockerfile pins `pnpm@9.15.4`; pull latest + rebuild `--no-cache` |
| Downloaded `.docx` saves as `.docx.txt` | Fixed via explicit MIME map in `_file_response` (app/main.py) |
| Build OOM on 4GB host | Add swap: `fallocate -l 4G /swapfile && mkswap /swapfile && swapon /swapfile` |

---

## Dynamic Field System (Future-Proof Templates)

Per-template user_input fields are stored as JSONB on `companies.custom_fields`. New templates auto-register fields without schema migrations.

**Flow**:
1. Admin uploads `New Resolution.docx` → 15-step training extracts placeholders + classifies user_input fields.
2. After training, `_refresh_field_registry_internal()` UPSERTs each user_input field into `company_field_registry` (key, label, description, type heuristic, used_by_templates).
3. Edit Company UI fetches `/api/dashboard/field-registry` → renders inputs dynamically. Values save to `companies.custom_fields[key]`.
4. `smart_doc.py` flattens `custom_fields` into companies dict so `find_replacement` resolves new keys with zero code change.

**Resolution priority** in `find_replacement`:
1. Trained `field_mapping` (db_column or default)
2. DB column on `companies` (auditor_name, financial_year_end_date, etc.)
3. `custom_fields` JSONB by key
4. user_provided `custom_data` from chat
5. Smart defaults (today date, registered_office for location, "they" for pronoun)
6. `KNOWN_USER_INPUT` fallback → "TBD"

Result: avg fill rate 64% → **92%** across 15 templates after registry populated.

## Stability Hardening (Applied)

All database connections use centralized `get_db_conn()` from `db/connection.py` — no more inline `psycopg.connect()` with hardcoded credentials. OpenRouter base URL centralized via `OPENROUTER_BASE_URL` in `app/model_config.py`. All silent `except: pass` blocks replaced with logged warnings. Chat input limited to 50KB on backend. All document directories auto-created at startup. All AI model references use `get_model()` — no hardcoded model names in any endpoint. Training/classification switched from Claude 3.5 Haiku to Gemini 3 Flash / 3.1 Flash Lite (70-94% cheaper).

## Cloud Build Hardening

- **pnpm pinned to v9.15.4** in Dockerfile — pnpm v10+ blocks postinstall scripts and breaks `--frozen-lockfile` on fresh cloud builds (`ERR_PNPM_IGNORED_BUILDS`).
- **`--ignore-scripts` + explicit `pnpm rebuild sharp`** — skips canvas native build (alpine missing cairo/pango; canvas is unused at runtime), keeps sharp prebuilt binary for Next.js image opt.
- **`.dockerignore`** excludes `documents/`, `logs/`, `.git/`, `agent-ui/node_modules`, `agent-ui/.next`, `agent-ui/out` — minimal build context.
- **Monitoring stack removed** from compose — only `scout-db` + `scout-api` ship.
- **Download MIME fix** — `_file_response()` sets correct `media_type` + `Content-Disposition` so browsers (Safari especially) don't append `.txt` to `.docx`.
