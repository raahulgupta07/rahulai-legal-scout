# CLAUDE.md — Legal Scout

## Project Overview

**Legal Scout** is a legal document automation system for **Myanmar corporate law**. It generates legal documents (AGM minutes, director consents, shareholder resolutions, etc.) from Word templates using company data stored in PostgreSQL. An AI agent (Agno framework) powers a chat interface for natural language document requests.

**All data is managed from the admin panel** — no pre-loaded templates or companies ship with the project.

---

## Quick Start

```bash
cp .env.example .env    # Fill in OPENROUTER_API_KEY + generate secrets
docker compose up -d --build
# Open http://localhost:8080  (PORT=8080 in .env — NOT port 80)
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
| Frontend | Next.js 15, React 18, TypeScript, Tailwind, Zustand, Radix UI, single system sans stack (no webfont) |
| Backend | FastAPI, Agno 2.5, python-docx, psycopg, SQLAlchemy |
| AI | Configurable via Settings: **Gemini 3.6 Flash** for chat + training + classification (upgraded 2026-08-03 from GPT-5.4 Mini / Gemini 3 Flash / Gemini 3.1 Flash Lite), text-embedding-3-small for embeddings — all via OpenRouter (base URL configurable via `OPENROUTER_BASE_URL` env var) |
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
| `scout/agent.py` | AI agent definition, 27+ tools, system prompt (Task Continuity rules, Legal-Skills L1 block via `_build_legal_skills_block()`), prompt injection sanitizer |
| `scout/tools/ask_questions.py` | HITL clarify tool `ask_questions(questions_json, answers)` — Agno `requires_user_input` pause/resume. NEVER name a tool `ask_user`/`get_user_input` (agno reserves them and hijacks resume → provider 400) |
| `scout/tools/legal_skills.py` | `load_skill(name)` / `list_skills` — L2 skill bodies loaded on demand from `legal_skills` table |
| `scout/tools/people_picker.py` | Signer/member selection via in-chat picker cards |
| `tests/tracker_layer1.py` | 25 deterministic assertions off `/api/documents/fill-view` — the real regression gate |
| `tests/tracker_layer2.py` | 14 chat runs; asserts the agent ASKS rather than guesses |
| `tests/tracker_layer3.py` | Drives whole conversations to a generated `.docx`, unzips `word/document.xml` and proves the answers landed |
| `db/migration_016_people_father_name.sql` | `people.father_name` — Myanmar drafting names a person against their father; NOT in the DICA extract, hand-entered |
| `scout/tools/people_sync.py` | Projects `companies.directors` + individual `members` into the People register. `sync_company_people()` runs inside `add_company()` (same conn, caller commits); `sync_all_companies()` backs `POST /api/people/sync-from-companies`. Dedup: NRC → name+DOB → name-with-no-NRC. Merge is FILL-BLANKS-ONLY (hand edits always win). Director+shareholder collapses to role `both`; corporate members skipped |
| `scout/tools/smart_doc.py` | Document generation, placeholder fill (thread-safe, no globals). Calls `expand_repeat_regions()` at the top of `fill_template_with_validation` before the highlight fill |
| `scout/tools/repeat_regions.py` | Dynamic list expansion — grows/shrinks Present-member paragraph blocks, appointed-director lists and signing-table row groups to the real party count; individual-vs-corporate signing split; no-op when no parties. Returns synthetic `__rr_N__` tokens merged into `data` |
| `scout/tools/fill_view.py` | `build_fill_view(template, company)` → whole document as ordered text/blank/break blocks, each blank carrying kind + register candidates (directors, shareholders, People register, pronoun, location, auditor). Backs the Fill-in view |
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
| `db/migration_011_people_register.sql` | People register table |
| `db/migration_012_party_selections.sql` | Per-run party/signer selections |
| `db/migration_013_legal_skills.sql` | `legal_skills` table (name, description, body, category, source, enabled) |
| `db/migration_015_people_extra_fields.sql` | `people.business_occupation` (DICA publishes it per director) + `people.country_of_residence` (hand-entered; consent forms split resident/non-resident) |
| `db/migration_014_seed_legal_skills.sql` | 12 seeded skills (7 adapted from anthropics/claude-for-legal, Apache-2.0 attributed; 4 native Myanmar playbooks; 1 practice profile) |

### Frontend
| File | Purpose |
|------|---------|
| `agent-ui/src/app/page.tsx` | Chat workspace: SplitShell + panel auto-open logic (`docWorkLive` regex on document tools) + `userClosedRef` + columns toggle wiring |
| `agent-ui/src/app/login/page.tsx` | Pixel-exact bagofwords sign-in clone (measured live at :8095): 40px h1, 440px form col, 64px boxed fields (label inside), h-12 rounded-[11px] buttons, full-width SSO, 677px showcase col |
| `agent-ui/src/components/auth/LoginShowcase.tsx` | Animated dark-navy "LIVE" panel: legal pipeline loop (UNDERSTAND→…→REVIEW). FICTIONAL data only (Golden Lotus/Emerald Holdings) — never real client info pre-auth |
| `agent-ui/src/components/shell/AppRail.tsx` + `AppShell.tsx` | ONE global rail (chat + admin): blue "New chat", flat Overview/Registers/Settings, session history, user row. Mounted once in root layout, never unmounts |
| `agent-ui/src/components/shell/SplitShell.tsx` | Animated chat/document split — panel slides on `cubic-bezier(0.4,0,0.2,1)` 250ms, columns toggle rides the panel edge, resize handle w/ invisible-until-hover blue bar |
| `agent-ui/src/components/shell/ArtifactPanel.tsx` | Document pane: hairline rounded card (`#f8f8f7`), cyan-tinted toolbar, Fields / **Fill in** / Preview tabs, centered faint empty state |
| `agent-ui/src/components/shell/FillInView.tsx` | Fill-in view: fetches `/api/documents/fill-view`, renders the whole document inline with blanks as click-to-pick buttons (register candidates + free text), generates via `/api/documents/fill-generate` then shows the PDF preview |
| `agent-ui/src/app/admin/overview/page.tsx` | Tabs: Dashboard \| Documents \| Emails \| Skills (bodies in sibling `*View.tsx`). Tab band MUST be `overflow-y-auto` (not hidden) or detail views clip |
| `agent-ui/src/app/admin/registers/page.tsx` | Tabs: Templates \| Companies \| People |
| `agent-ui/src/app/admin/settings/page.tsx` | Tabs: AI models \| Email \| System \| Activity \| Users \| Knowledge |
| `agent-ui/src/app/admin/skills/SkillsView.tsx` | Skills tab: stat cards, category filters, enable/disable toggles, body edit modal (`/api/skills` CRUD) |
| `agent-ui/src/app/admin/*/​*View.tsx` | Extracted page bodies (verbatim features); old routes are client redirects w/ `?tab=` |
| `agent-ui/src/components/chat/ChatArea/*` | Blank state (greeting+grid+glow, composer centered), typewriter-smoothed streaming, Analyzing pill + tool timeline, hover-only timestamps |
| `agent-ui/src/components/chat/AskUserCard.tsx` + `AskUserCardList.tsx` | Clickable question cards: chips auto-submit single-pick, multi-select, free-text, "Other…"; answered → locked w/ green banner |
| `agent-ui/src/components/chat/askUserPayload.ts` | `ASK_USER_TOOL='ask_questions'` + legacy read-only match set |
| `agent-ui/src/hooks/useAIStreamHandler.tsx` | rAF typewriter (buffers bursty OpenRouter tokens ~120 chars/s), RunPaused → picker/ask cards, silent-stop auto-`continue` nudge (once per run_id) |
| `agent-ui/src/hooks/useSessionLoader.tsx` | History rehydration of pauses: match by tool NAME; answers live in `user_input_schema` (`result` is null); answered→locked, pending→resumable |
| `agent-ui/src/api/os.ts` | `buildResumeRequest` (echo WHOLE `user_input_schema`, fill only target fields), `buildContinueRunRequest`, `buildAskUserContinueRequest` |
| `agent-ui/src/components/ui/typography/*` | Chat type scale: body 14px/1.625, headings capped 14–16px semibold, code chips, 11px uppercase table headers |
| `agent-ui/src/components/ui/DocViewer.tsx` | Unified PDF/DOCX dispatcher; forces PdfViewer for `/preview-pdf/` paths |
| `agent-ui/src/components/ui/PdfViewer.tsx` | Canvas PDF render via pdfjs-dist (Brave-shields-safe, sends Bearer header) |
| `agent-ui/src/components/ui/DocxViewer.tsx` | Client-side docx render via docx-preview (sends Bearer header) |
| `agent-ui/src/lib/api-client.ts` | API endpoint URLs |
| `agent-ui/src/store.ts` | Zustand state |
| `agent-ui/src/app/globals.css` | Token layer (single source of truth) + `.ls-shimmer` streaming label |
| `agent-ui/src/app/layout.tsx` | Root layout (system font stack — no webfont ships) + AppShell mount |

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
| `list_new_company_setup_templates` | List ONLY the 5 new-company-setup templates (`template_group='new_company_setup'`) — offer these when setting up a new company |
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

### Interaction & Skills
| Tool | Purpose |
|------|---------|
| `ask_questions` | HITL clarify cards — pauses run, user answers via clickable chips (see Ask-Questions section) |
| `load_skill` / `list_skills` | Load legal playbook bodies on demand (see Legal Skills section) |
| People picker tools | Signer/member selection cards (`people_picker.py`) |

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
| 3 | AI analysis (category, purpose, when_to_use, legal refs) | Gemini 3.6 Flash | JSON metadata |
| 4 | Save metadata to `templates` table (37 columns) | None (DB write) | — |
| 5 | Classify fields: `db_field` vs `user_input` | Gemini 3.6 Flash | Classification JSON |
| 5.5 | Map placeholders → exact DB columns | Gemini 3.6 Flash | Field mapping JSON |
| 6 | Store in `knowledge_vec` + `knowledge_lookup` | None (DB write) | KB entries |
| 7 | Generate vector embedding | text-embedding-3-small | 1536-dim vector |
| 8 | Create PDF preview (yellow-highlighted placeholders) | None (LibreOffice) | Cached PDF |
| 9 | Deep field analysis (type, format, validation per field) | Gemini 3.6 Flash | Per-field JSON |
| 10 | Legal reference extraction (Myanmar Companies Law 2017) | Gemini 3.6 Flash | Sections + compliance |
| 11 | Sample filled document (realistic Myanmar data) | Gemini 3.6 Flash | Sample values JSON |
| 12 | Document workflow (trigger, before/after docs) | Gemini 3.6 Flash | Workflow JSON |
| 13 | Q&A pairs (10 practical questions + answers) | Gemini 3.6 Flash | Stored in `knowledge_vec` |
| 14 | Cross-template relationships (prerequisite/follow-up/related) | Gemini 3.6 Flash | Relationships JSON |
| 15 | Confidence score (0-100%) based on which steps passed | None (local calc) | Score integer |

**AI calls per template: ~9 total** — 8x Gemini 3.6 Flash (steps 3, 5, 5.5, 9-14) + 1x text-embedding-3-small (step 7)

---

## Background Template Training (server-side job, 2026-07-27)

Training runs as a **server-side background job** — survives the training modal/tab/browser closing AND a server restart. Before: a JS for-loop in the open browser tab drove per-template SSE; closing the tab aborted it ("stops in between").

- **`app/training_jobs.py`** (new): DB table `template_training_jobs` (status queued|running|done|error|cancelled, queue jsonb, current_index, done/fail counts, logs jsonb heartbeat = updated_at). Daemon **thread** `_worker(job_id)` drives the EXISTING 15-step train-stream pipeline INTERNALLY via httpx to `http://127.0.0.1:8000` (mints own admin token `create_token(0,"system@training","admin")`) — zero pipeline change. **Per-template failure logs + continues** (fixes stop-at-N).
- **Endpoints:** `POST /api/knowledge/train-start` (`{retrain_all|templates}`), `GET /api/knowledge/train-job` (poll ~1.5s), `POST /api/knowledge/train-cancel`. FE POSTs start then POLLS, resumes live status on modal-reopen/reload, has Stop (no AbortController teardown).
- **★★★LANDMINE — `@app.on_event("startup")` is DEAD.** `app = agent_os.get_app()` (Agno) sets a **lifespan**; FastAPI/Starlette **silently ignores ALL `on_event("startup")` handlers when a lifespan exists**. So `startup_sync()` never runs (incl. dir-create, migration check, `_refresh_agent_knowledge`, `_refresh_legal_skills`, resume). FIX: watchdog started at **module-import time** (bottom of `training_jobs.py`; `from app import training_jobs` in main.py guarantees it per worker). ⚠️ OTHER startup_sync work is also silently dead — flagged, not yet fixed.
- **★★multi-worker** (`uvicorn --workers 2`) → job state MUST be DB. Single-runner guard = **Postgres advisory lock** `pg_try_advisory_lock(4210771)` on a dedicated conn for worker life. On restart the killed process's session-lock lingers until PG reaps it → one-shot lock LOSES → orphaned 'running' forever; fixed with **watchdog** (45s, import-started) re-spawning a worker for any 'queued' or stale-'running' (updated_at > 120s) + orphan-aware lock retry. Worker gates on `/health` readiness before internal calls.
- ★logging: use `logging.getLogger("legalscout")` (child `legalscout.training_jobs` had no handler → swallowed). E2E-verified: browser-close (100s no client → advanced), server-restart (watchdog revived → 11/11 done, 0 fail, DB 15/15), start/cancel. BAKED `scout:latest`, rollback `scout:pre-bgtrain-fix-20260727`. UNCOMMITTED.

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
| `template_training_jobs` | Server-side background training job state (status, queue, current_index, done/fail counts, logs) |

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
POST /api/knowledge/train-start               # Start server-side background training job ({retrain_all|templates})
GET  /api/knowledge/train-job                 # Poll background training job status
POST /api/knowledge/train-cancel              # Cancel background training job
GET  /api/knowledge/train-stream/{template}   # SSE training stream (15 steps, auth required)
GET  /api/knowledge/train-companies-stream    # SSE company training stream (auth required)
POST /api/knowledge/deep-train                # Batch train all templates (auth required)
POST /api/templates/group                     # Tag a template's group e.g. new_company_setup (admin)
GET  /api/documents/fill-view                  # ?template=&company= → fill-in blocks + register candidates
POST /api/documents/fill-generate             # Generate straight from the fill-in view's chosen values
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

## Design System — CityAgent Insights language (restyle 2026-07-24/25, MERGED TO `main`)

Rebuilt to match CityAgent Insights (bagofwords): neutral Tailwind gray ramp, single blue accent, ONE system sans, dense 13-14px type. Single token layer in `globals.css` — components never hardcode hexes. Rollback tags: `pre-insights-restyle`, `pre-legal-skills`, `pre-ui-revamp`, `pre-rail-revamp`.

### Tokens (light / dark)
| Token | Light | Dark |
|-------|-------|------|
| `--bg` (content) | `#ffffff` | `#111827` |
| `--bg-secondary` (rail) | `#F9FAFB` | `#030712` |
| `--border` | `#E5E7EB` | `#1F2937` |
| `--text` / `--text-muted` / `--faint` | `#111827` / `#6B7280` / `#9CA3AF` | `#F9FAFB` / `#9CA3AF` / `#6B7280` |
| `--brand` | `#2563EB` | `#3B82F6` |
| `--accent` (subtle fill) | `#F3F4F6` | `#1F2937` |
| Radii | 6 / 8 / 12 / 16px + full | same |

Three theme blocks: `@media (prefers-color-scheme: dark)` + `:root[data-theme='dark']` + `:root[data-theme='light']` — an explicit toggle must beat the media query both ways. NEVER Tailwind alpha modifiers on `var()` colors (`bg-[var(--x)]/20` emits NOTHING) — use `color-mix(in srgb, var(--token) N%, transparent)`.

### Typography
- **Font:** ONE system sans stack (`ui-sans-serif, system-ui, …`) — no webfont ships. `--font-mono` token deliberately resolves to the SAME sans (single-font decision 2026-07-25; revert comment sits on the token in `globals.css`).
- **Scale:** 13px nav rows · 11px uppercase +0.05em section/table headers · 30px/400 home greeting · chat body 14px/1.625 · chat headings capped 14–16px semibold · code chips 13px mono · durations 11px mono tabular.

### Shell
- **One rail** (`AppRail`, 240px, collapsible 56px): blue-text "New chat", flat Overview/Registers/Settings (minRole-gated), divider, session history (13px single-line), user row + version. Mounted once at root layout.
- **Admin = 3 tabbed pages**: `/admin/overview` (Dashboard|Documents|Emails|Skills), `/admin/registers` (Templates|Companies|People), `/admin/settings` (AI models|Email|System|Activity|Users|Knowledge). Old routes redirect w/ `?tab=`. AuthGuard path-gates all (incl. the once-open `/admin/people`). Tab band = `flex-1 min-h-0 overflow-y-auto` — `overflow-hidden` clips detail views (template preview / company form / document preview).

### Chat UX
- **Home:** centered greeting → composer (`rounded-xl`, Email pill, graphite circular send) → chips, over a faint 24px grid + pastel glow. Composer keeps ONE tree position across empty→thread (never remounts).
- **Streaming:** rAF typewriter smooths bursty OpenRouter delivery (~120 chars/s, backlog-capped); partial-markdown stabilizer closes open ```/** pairs; inline cursor; "Analyzing your request" pill + dot timeline of tools (green done / pulsing blue live, labels + durations) → collapses to `✓ N steps · Xs` on finish.
- **Document panel:** hidden until a document tool runs or an artifact lands; slides open/closed on `cubic-bezier(0.4,0,0.2,1)` 250ms; columns toggle rides the panel edge; resizable (invisible handle, blue bar on hover).
- **Timestamps:** hover-title only; response duration is the only visible time.
- **Auto-suggestions:** LLM-powered via `POST /api/suggest-followups`, shown only after the answer settles.

---

## Ask-Questions HITL (in-chat cards, 2026-07-25)

ALL agent choices (template pick, yes/no approvals, missing fields, signer/member selection) go through clickable cards — the prose `a) b) c)` pattern is PURGED from the system prompt (verify: `grep '^[abc]) ' scout/agent.py` must be ZERO).

- **Backend:** `scout/tools/ask_questions.py` — Agno `@tool(requires_user_input=True)`; run pauses (RunPaused), FE resumes same run_id echoing the WHOLE `user_input_schema` with only the `answers` field filled (JSON).
- **LANDMINE:** agno RESERVES tool names `ask_user` and `get_user_input` (`_tools.py:795`) — its built-in handler hijacks resume, skips execution, leaves a dangling tool call → provider 400 "No tool output found". Hence the name `ask_questions`.
- **History:** answered pauses flip `requires_user_input`→false and store answers inside `user_input_schema` (`result` stays null); pause runs persist as status=ERROR with fallback text — rehydrate by tool NAME (`useSessionLoader.tsx`).
- **Task Continuity:** prompt section + imperative tool result ("CONTINUE THE TASK IN THIS SAME TURN… empty output is forbidden") + FE auto-nudge: RunCompleted with empty content + tool work + nothing pending → send `continue` once per run_id (mitigates 100k+-token resumed-context silent stops).

---

## Legal Skills Engine (Anthropic Agent-Skills pattern, 2026-07-25)

Progressive-disclosure playbooks — no sandbox needed (skills are markdown instructions; L3 "resources" are the existing Agno tools).

- **L1:** name+description (~50 tok/skill) always in system prompt, injected by `_refresh_legal_skills()` (app/main.py) between markers `## Legal Skills (playbooks — load on demand)` … `■■■`, placed AFTER the template-knowledge `═══` fence. Refreshes on skill CRUD without agent restart.
- **L2:** full body via `load_skill(name)` tool (`scout/tools/legal_skills.py`), stored in `legal_skills` table.
- **12 seeded skills** (migration_014): 7 adapted from `anthropics/claude-for-legal` (Apache-2.0, attributed in `source`), 4 native Myanmar corporate-law playbooks, 1 CHL practice-profile.
- **Signing rules (client complaint fix, E2E-proven):** Corporate Shareholder Consent is signed by the CORPORATE SHAREHOLDER'S OWN directors (e.g. Pahtama Group's directors for Arctic Sun) — never the new company's board; signers always chosen via picker, never guessed; DICA extracts never carry phone/email/residential address.
- **Admin:** Overview → Skills tab (`SkillsView.tsx`) — toggles, edit, `/api/skills` CRUD.

---

## Dynamic Templates & Fill-in View (client feedback, 2026-07-27)

Built from the legal team's testing feedback. Three additions:

### 1. New-company-setup template filter
`templates.template_group` (migration 011) is now wired: `find_matching_templates(setup_only=True)` and the `list_new_company_setup_templates` tool restrict to the 5 setup forms; agent prompt shows only these when setting up a new company. Admins tag/untag templates via `POST /api/templates/group` and the **Setup** toggle column in `TemplatesView.tsx`. New uploads can be added to the set from there.

### 2. Dynamic (unbounded) attendees / signatories — `scout/tools/repeat_regions.py`
Templates hard-code fixed slots (`individual shareholder_1..2`, `corporate shareholder_3`, `director_1..3`). `expand_repeat_regions(doc, data, ...)` runs at the top of `fill_template_with_validation` and rewrites those regions to the real party count:
- **Present-member / appointed-director paragraph blocks** — contiguous run of "list unit" paragraphs (placeholder + short role tag), cloned/deleted to fit.
- **Signing-table row groups** — delete-and-rebuild by party type; a corporate party clones the "signed by its authorized representative" row group and fills the representative, an individual gets the plain block.
- Party lists: member family auto-falls-back to the company's `shareholders_list` (zero agent change); `appointed_directors` / `signing_directors` come from `custom_data`.
- Returns synthetic `__rr_N__` tokens merged into `data`, so the normal highlighter fills+colours them.
- **Safe:** no-op on all 15 templates with empty data; single scattered refs (e.g. the Chairperson line) are never touched.
- ★`_is_corporate` must accept member `type` value `"Company"` (real DICA data), not only `"corporate"`.
- ★`_tail_attr` must check `"name"` before `"share"` — else "shareholder_1_**name**" matches "share" and renders blank.
- Landmine: the existing `slot_resolver.collect_slot_requests` still ASKS for numbered member slots up front; the expander fixes the OUTPUT but the ask-step over-asking is a pending reconciliation.

### 3. Whole-document fill-in view — `scout/tools/fill_view.py` + `FillInView.tsx`
`GET /api/documents/fill-view?template=&company=` renders the doc as ordered blocks; each blank carries `kind` + register candidates. `FillInView.tsx` (3rd panel tab) shows the whole document, blanks are click-to-pick chips (candidates + free text), and `POST /api/documents/fill-generate` generates + previews. E2E-proven live on ARCTIC SUN (1 corporate member → 1 Present line + 1 corporate signing block).

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

## Current State (2026-08-04)

**Bug-sweep release.** ~20 defects closed, three test suites built, everything baked into `scout:latest` and running on `http://localhost:8080`. **UNCOMMITTED** — the image and the working tree are the only copies.

### ★★★ Model landmines (gemini-3.6-flash, switched 2026-08-03)

Chat, training and classification all run `google/gemini-3.6-flash`. **Reasoning cannot be disabled** — OpenRouter rejects `reasoning:{enabled:false}` ("Reasoning is mandatory for this endpoint"), and `exclude:true` only hides it while still spending the tokens. Two consequences, both of which shipped silently:

1. **Tight `max_tokens` returns empty content.** Follow-up suggestions at 200 tokens returned `[\n  "`, `json.loads` threw, a bare `except` returned `[]` — the feature was dead and nothing surfaced it. The AI connectivity probe at 20 tokens reported "(empty response)" for a healthy model. **Budget ≥800 even for trivial completions.** Never swallow the parse error.
2. **`reasoning_content` is separate from `content`.** A turn can produce reasoning and ZERO content — that is what the long-standing "silent stop" actually was, not a stalled agent. Fixed by capturing `chunk.reasoning_content` in `useAIStreamHandler` and rendering a collapsed "Thought process" block. Render it as PLAIN TEXT, not markdown: reasoning is full of `**`/`###` that the markdown renderer blows into headings louder than the answer. Note `extra_data.reasoning_steps` is a DIFFERENT Agno concept and a red herring.

### ★★ Prompt ↔ tool contract

Two tools the system prompt told the model to call were not registered — `generate_dica_extract` (never added to `_tools_to_add`) and `list_companies` (registered under its `__name__` `list_all_companies` while the prompt said `list_companies()`). Both failed **silently**: the model follows the instruction, finds no tool, ends the turn with nothing. No test caught either. `scout/agent.py` now runs `_audit_prompt_tool_contract()` at import and logs `PROMPT/TOOL MISMATCH`.

### ★★ Party selection must carry role AND company

- `choose_person_from_register` recorded an EMPTY `company_name`, so picks were written to `party_selections` but unfindable by the `(lower(company_name), picker)` index.
- `PICKER_SLOT_KINDS` hardcoded `'signatory'` for every picker, so `slot_kind` could not discriminate roles. `_KIND_PATTERNS` only matched snake_case, so a prose purpose ("select the new director to be appointed") fell through to the catch-all. Result: **a person chosen as the INCOMING director appeared on the NEXT document's resignation line.** Wrong person, right company, no warning.
- Fixed: patterns are prose-tolerant, `classify_kind()` is shared with `people_picker`, the real role is recorded at pick time, and the read-back filters on `slot_kind`.

### ★ Other landmines

- **U+00A0 in placeholder names.** Five templates carry non-breaking spaces inside `[individual\xa0shareholder_1_name]`. A different string from the normal-space spelling, so any hand-written alias misses and the field comes out blank. Normalised in `placeholders.py:placeholder_name()`.
- **`@app.on_event("startup")` is dead** under the AgentOS lifespan — `startup_sync()` is now called at module import (bottom of `app/main.py`). `[STARTUP]` lines in the log confirm it ran.
- **The nudge was unbounded.** The guard was per `run_id`, but every nudge starts a NEW run with a NEW id, so nothing capped it — that is what generated the same document three times. Now `MAX_CONSECUTIVE_NUDGES = 3`, reset on real output.
- **`documents/` is a bind mount** to the repo — template edits on disk are live without a rebuild.
- **Port is 8080**, not 80.

### Test suites (`tests/`)

| Suite | Scope | Determinism |
|---|---|---|
| `tracker_layer1.py` | 25 assertions off `/api/documents/fill-view` | **Deterministic — the real gate** |
| `tracker_layer2.py` | 14 chat runs; asserts it asks rather than guesses | Non-deterministic |
| `tracker_layer3.py` | Full conversations → generated `.docx`, unzipped and grepped | Non-deterministic |

Layer 2/3 failures move between cases run to run; do not treat one as a regression until it reproduces. Runs are tagged with `user_id` so they appear in the app's own sidebar.

### Known open

- The model still sometimes ends a turn without a closing sentence. Reasoning is now visible so nothing is hidden, but a prompt fix is outstanding.
- `collect_slot_requests` suppression extended but not exhaustive.
- Python-repr parser retained in `useArtifact.ts` — required for sessions stored before tool results became JSON.
- "Director and Shareholder Consent Form" template does not exist; tracker case B5 blocked.
- The client's OneDrive master copy of *Notice of AGM to Shareholders* still lacks `[director_name]` — re-uploading reintroduces a fixed bug.

## Previous State (2026-07-27)

- **Background training release**: template training is now a server-side background job (`app/training_jobs.py`) that survives modal/tab/browser close AND server restart — DB-backed job + Postgres advisory lock + import-time watchdog. Per-template failures log+continue (fixes stop-at-N). ★★★Landmine: `@app.on_event("startup")` is dead under AgentOS lifespan → watchdog started at module import instead. BAKED `scout:latest`, rollback `scout:pre-bgtrain-fix-20260727`, E2E-verified (browser-close, server-restart, 11/11 done 0 fail, DB 15/15). UNCOMMITTED. ⚠️ OTHER `startup_sync` work (dir-create, migration check, knowledge/skills refresh) also silently dead under the lifespan — flagged, not yet fixed.
- **Dynamic-templates release** (client feedback): setup-template filter + unbounded attendees/signatories (`repeat_regions.py`) + whole-document fill-in view (`fill_view.py`, `FillInView.tsx`) + admin Setup-group toggle. Baked into the `:8080` image (rebuilt 2026-07-27, rollback tag `scout:pre-dynamic-templates`), health 200, E2E-verified live on real data. UNCOMMITTED on `main` — not pushed. Pending refinement: `collect_slot_requests` still over-asks numbered member slots at the ask-step (output already correct).

## Previous State (2026-07-25)

- **EVERYTHING ON `main` (~40 commits, all feature branches deleted).** Insights restyle + streaming/typewriter + animated document panel + ask_questions cards + Task Continuity + Legal Skills engine + single sans + pixel-exact bagofwords login + admin scroll fixes. Baked into the local Docker image (:8080) and Playwright-verified live. Rollback tags kept: `pre-insights-restyle`, `pre-legal-skills`, `pre-ui-revamp`, `pre-rail-revamp`, `pre-v2-phase0`. NOT pushed to any remote.
- **Login page** measured 1:1 against Insights `:8095/users/sign-in` (computed-style loop): h1 40px/600, form col 440px, fields 440×64 r12, buttons h-12 r11 full-width, showcase panel 677px r22. Showcase animation uses FICTIONAL companies only — no real client data pre-auth.
- **Known LEFT items:** one full-chain E2E in a single run (card→picker→fields→preview→generate→download; prior failures were test-selector brittleness, not product); context diet for 100k+-token resumed turns (auto-nudge is mitigation); ~~People-register backfill + `country_of_residence` migration~~ (BOTH DONE 2026-08-03 — `people_sync.py`, migration 015); company page link to the ORIGINAL uploaded DICA PDF (`pdf_url` never stored on extraction — file exists on disk under `/documents/legal/uploads/`); cold-start-interview run to fill the CHL practice-profile skill.
- `FUTURE_READINESS.md` predates the restyle — its §2 tokens and phase table are superseded, but its defect list (§6) and People-register data findings (§7) remain valid.
