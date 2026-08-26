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
| `scout/agent.py` | AI agent definition, 45 registered tools, system prompt (Task Continuity rules, Legal-Skills L1 block via `_build_legal_skills_block()`, **generated tool inventory** via `_build_tool_inventory()`), prompt injection sanitizer, `send_email_tool` (queues only), `_audit_prompt_tool_contract()` which **raises at import** on a mismatch |
| `scout/tools/ask_questions.py` | HITL clarify tool `ask_questions(questions_json, answers)` — Agno `requires_user_input` pause/resume. NEVER name a tool `ask_user`/`get_user_input` (agno reserves them and hijacks resume → provider 400) |
| `scout/tools/legal_skills.py` | `load_skill(name)` / `list_skills` — L2 skill bodies loaded on demand from `legal_skills` table |
| `scout/tools/people_picker.py` | Signer/member selection via in-chat picker cards |
| `scout/knowledge/routing/intents.json` | ★ Interpolated into the system prompt as DATA. A wrong tool name here is invisible to any source search — `generate_document_tool` sat in it for weeks as the primary source for "Create legal document" |
| `tests/test_units.py` | **137 assertions** over source, DB and the served bundle. Runs INSIDE the container only: `docker exec scout-api python3 /app/tests/test_units.py` |
| `tests/tracker_layer1.py` | 25 deterministic assertions off `/api/documents/fill-view` — the real regression gate |
| `tests/tracker_layer2.py` | 30 **scripted** runs; asserts the agent ASKS rather than guesses. Driven by `scout/testing/scripted_runtime.py` — no model, no network, no container |
| `tests/tracker_layer3.py` | Drives 14 **scripted** conversations to a generated `.docx`, unzips `word/document.xml` and proves the answers landed. ★ Like the others, a Python client — it never executes frontend code |
| `tests/tracker_fill.py` | 43 deterministic checks over the fill/slot path |
| `tests/tracker_layer2_live.py`, `tests/tracker_layer3_live.py` | The **original model-driven** suites, kept verbatim. Run these when you need to know the real model still behaves; they cost API spend and can fail for reasons unrelated to your change |
| `scout/testing/` | Test-only. `ScriptedAgentRuntime` plus `Ask`/`Pick`/`Text`/`Document`/`Complete`/`Error` step types. **Nothing in the product imports it.** Import it *by path*, not `from scout.testing import …` — `scout/__init__.py` does `from scout.agent import scout`, which drags in `mcp`/`agno` and fails outside the container |
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
| `db/migration_017_party_selection_session.sql` | Scopes picker selections to the conversation. Without it a director chosen in one chat reappeared unasked in another 24 minutes later and landed in generated minutes |
| `db/migration_018_purge_foreign_legal_references.sql` | Clears Indian company-law citations from all 15 templates; replaces `DIN Application` with the DICA director particulars filing |
| `db/migration_019_email_approval_gate.sql` | `email_logs` gains `session_id`, `decided_at`, `decided_by_email`; status carries `queued`/`sent`/`failed`/`discarded` |
| `db/migration_020_company_source_pdf.sql` | Stores the uploaded DICA PDF path on the company record |
| `db/migration_021_fix_skill_tool_names.sql` | Rewrites dead tool names inside skill BODIES (`preview_document`→`preview_doc`, `list_tracked_documents`→`list_documents`). Word boundaries `\m..\M` are load-bearing — `preview_doc` is a PREFIX of `preview_document` |

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
| `agent-ui/src/components/shell/ActivityTray.tsx` | ★ ONE docked tray for every background job — replaces the standalone `ImportTray` **and** the blocking training modal. 380px, `bottom-4 right-4`, `rounded-[var(--radius-lg,12px)]`, `shadow-xl`, `px-3.5 py-2.5` rows, 13/12.5/11.5/11px type, `h-1` bars, `--bg-secondary` footer, collapsed pill. Tabs (Imports · Training · Email) use the admin 2px `--brand` underline. Mounted once by `AppShell` |
| `agent-ui/src/components/shell/activity/{ImportsTab,TrainingTab,EmailTab}.tsx` | The three channels. Imports = the old tray rows verbatim + a `%` beside each bar. Training = queue % *and* current-template step % + collapsible 16-step list + Stop. Email = queued agent mail, recipient/attachment **wrapped not truncated**, Send behind a one-click confirm |
| `agent-ui/src/hooks/useActivityTray.ts` | Tray visibility + tab. Visibility is the ABSENCE of a dismissal, not a stored `open`: new work revives a dismissed tray (a dismissal answered for work already seen). `forced` shows it before any channel has data — the gap between clicking Train and the poller's first tick |
| `agent-ui/src/hooks/useTrainingJob.ts` | Single app-wide poller for `/api/knowledge/train-job` (1.5s active / 20s idle, `kickTrainingPoll()` to pull now). `stepsFromJob` reuses `freshSteps`/`applyStepEvent` so tray and modal cannot disagree. ★ The endpoint returns the MOST RECENT job, not a recent one — a finished run shows only if this page watched it run. Deliberately NOT an `updated_at` cutoff: that reads a Postgres UTC stamp against the browser clock and is wrong by 6.5h in Yangon, silently |
| `agent-ui/src/hooks/useEmailQueue.ts` | 30s poll of `/api/email/queued` + `refreshEmailQueue()` |
| `agent-ui/src/app/admin/overview/page.tsx` | Tabs: Dashboard \| Documents \| Emails \| Skills (bodies in sibling `*View.tsx`). Tab band MUST be `overflow-y-auto` (not hidden) or detail views clip |
| `agent-ui/src/app/admin/registers/page.tsx` | Tabs: Templates \| Companies \| People |
| `agent-ui/src/app/admin/settings/page.tsx` | Tabs: AI models \| Email \| System \| Activity \| Users \| Knowledge |
| `agent-ui/src/app/admin/skills/SkillsView.tsx` | Skills tab: stat cards, category filters, enable/disable toggles, body edit modal (`/api/skills` CRUD) |
| `agent-ui/src/app/admin/*/​*View.tsx` | Extracted page bodies (verbatim features); old routes are client redirects w/ `?tab=` |
| `agent-ui/src/components/chat/ChatArea/*` | Blank state (greeting+grid+glow, composer centered), typewriter-smoothed streaming, Analyzing pill + tool timeline, hover-only timestamps |
| `agent-ui/src/components/chat/AskUserCard.tsx` + `AskUserCardList.tsx` | Clickable question cards: chips auto-submit single-pick, multi-select, free-text, "Other…"; answered → locked w/ green banner |
| `agent-ui/src/components/chat/askUserPayload.ts` | `ASK_USER_TOOL='ask_questions'` + legacy read-only match set |
| `agent-ui/src/hooks/useAIStreamHandler.tsx` | rAF typewriter (buffers bursty OpenRouter tokens ~120 chars/s), RunPaused → picker/ask cards, silent-stop nudge (capped at `MAX_CONSECUTIVE_NUDGES=3`), `buildClosingFromTool` / `buildApprovalFromPreview`. ★ `didToolWork` counts `ToolCallStarted` via `toolsThisRunRef` — `RunCompleted` carries NO `tools` key, so reading `chunk.tools` there was permanently false |
| `agent-ui/src/hooks/useAIResponseStream.tsx` | SSE reader. ★ Counts delivered chunks and THROWS on zero — a 200 with an HTML body drains fine, yields no events, and used to paint a blank bubble. `!response.ok` reads text before JSON |
| `agent-ui/src/components/chat/ApprovalPrompt.tsx` | The approval a stalled `preview_doc` owed. NOT an `AskUserCard` — the run has completed, so there is no pause to resume; the choice is sent as an ordinary next message |
| `agent-ui/src/components/chat/QueuedEmailCard.tsx` | Send / Discard for an email the agent queued. Recipient and attachment shown in full, never truncated — they decide whether sending is safe |
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
| `preview_doc` | Preview document with highlighted placeholders. ★ The REGISTERED name — the export-dict key is `preview_document`, and the prompt said so for weeks, naming a tool that did not exist |
| `prepare_document` | Field analysis without a rendered preview. Kept registered, but OFF the happy path — `preview_doc` returns the same analysis plus the preview |
| `analyze_template_tool` | Analyze a Word template's structure (registered name; not `analyze_template`) |

★ `create_document` is **deregistered**. It was `return _generate_document(...)` — byte-identical to `generate_document` — and `prepare_document` is a strict prefix of the same call. Three doors to one room made the model pick differently run to run.

★ The authoritative list is **generated from the registry** into the prompt by `_build_tool_inventory()` (`scout/agent.py`). This table is documentation; that block is the contract, and startup raises if the prompt names a tool that is not registered.

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
| `send_email_tool` | **QUEUES** an email for the user to approve. Does NOT send — the agent has no path to SMTP and no `confirmed` argument. Delivery is `POST /api/email/queued/{id}/send` under the user's own JWT |
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
- **★★★LANDMINE — `@app.on_event("startup")` is DEAD.** `app = agent_os.get_app()` (Agno) sets a **lifespan**; FastAPI/Starlette **silently ignores ALL `on_event("startup")` handlers when a lifespan exists**. So `startup_sync()` never runs (incl. dir-create, migration check, `_refresh_agent_knowledge`, `_refresh_legal_skills`, resume). FIX: watchdog started at **module-import time** (bottom of `training_jobs.py`; `from app import training_jobs` in main.py guarantees it per worker). ✅ RESOLVED: the whole of `startup_sync()` now runs — it is called at module-import time at `app/main.py:7625`, wrapped in a try/except that logs `[STARTUP] startup_sync failed:` rather than taking the app down. Dir-create, migration check, `_refresh_agent_knowledge`, `_refresh_legal_skills` and training resume all execute. The `on_event` fact remains true; only the "still dead" part was stale.
- **★★multi-worker** (`uvicorn --workers 2`) → job state MUST be DB. Single-runner guard = **Postgres advisory lock** `pg_try_advisory_lock(4210771)` on a dedicated conn for worker life. On restart the killed process's session-lock lingers until PG reaps it → one-shot lock LOSES → orphaned 'running' forever; fixed with **watchdog** (45s, import-started) re-spawning a worker for any 'queued' or stale-'running' (updated_at > 120s) + orphan-aware lock retry. Worker gates on `/health` readiness before internal calls.
- ★logging: use `logging.getLogger("legalscout")` (child `legalscout.training_jobs` had no handler → swallowed). E2E-verified: browser-close (100s no client → advanced), server-restart (watchdog revived → 11/11 done, 0 fail, DB 15/15), start/cancel. BAKED `scout:latest`, rollback `scout:pre-bgtrain-fix-20260727`. UNCOMMITTED.

## ★★★Session 2026-08-25 — `1.2.32` → `1.2.42` (all UNCOMMITTED)

Live image `scout:1.2.42`, `LEGAL_SCOUT_SKILL_ROUTING=true`. 79 files uncommitted, ~42 builds.

### Fixed

- **★★★An empty value from the model erased what the user typed.** The client's
  first logged defect, reproduced with a boundary and fixed in `1.2.42`.
  It ONLY appears on the flow a real user takes: answer the question cards, then
  send "now generate" as a **separate message**. Captured from a failing run:

      generate_document(custom_data={"date": "", "date_of_birth": "", "phone": "", ...})
      while active_task.collected held {"date": "07 July 2027"}

  `smart_doc.py:1058` merged `{**_remembered, **custom_data}` — caller wins on
  every key it sends — so `""` won and the consent form had no date. Right rule
  for corrections, wrong for omissions: the model omits by sending `""`, not by
  leaving the key out. Now an empty caller value is dropped when a remembered
  non-empty value exists for the same key. `_explicitly_supplied` still reads
  PRESENCE, so "leave the date blank" is unaffected — that path never had a
  remembered value to lose, because `merge_collected` only stores what the user
  actually typed. **Measured, two-message flow: 2/5 → 9/9.**
  ★The single-flow harness scores 3/3 and never sees this. A test that drives
  generation in one continuous flow cannot reproduce the client's complaint.

- **★★★All 15 `template_group` values were NULL, so the setup-template tool
  always took its empty branch** and the agent answered "what documents set up a
  company?" from its own legal knowledge, naming templates that do not exist.
  Migration 011 already had the tagging SQL — it ran when `templates` was EMPTY
  (register wiped, `.docx` uploaded afterwards through the UI), so its `UPDATE`
  matched zero rows. A one-shot UPDATE cannot tag rows that arrive later, and
  templates always arrive later. `migration_029` uses a **BEFORE INSERT trigger**
  instead, covering both insert paths (`template_analyzer.py:254`,
  `scripts/sync_templates.py:27`) and any future one. INSERT only, deliberately:
  the admin Setup toggle clears a tag by writing NULL, and a BEFORE UPDATE
  trigger would put it straight back and make the toggle look broken. Proved on
  a scratch DB — migrate first, upload after — 4 tagged; with the trigger dropped
  (mutation test) 15 NULL. Also matches `%Shareholder%director%Consent%` so the
  N5 template auto-tags the day it arrives.

- **★★★A picker of near neighbours is an absence, not a choice** (`1.2.36`).
  `find_matching_templates` could not report absence: its only absence branch is
  `len(matches) == 0`, unreachable for any request phrased in this vocabulary
  because the predicate admitted a template when ANY word > 2 chars appeared in
  its name — `and`, `for`, `new`, `non` all counted. "Director and Shareholder
  Consent Form" matched **13 of 15**; `and` alone admits three on the substring
  in "Resignation and Appointment". Added `_STOPWORDS`, a `partial_match` flag
  when no single template covers every significant word, and a rule that a
  partial match is never dominant. ★The grounding rule from `1.2.34` stops the
  model INVENTING a name; it says nothing about SUBSTITUTING a real one.

- **★★★Skills were PULL and did not fire.** All 15 templates are already named in
  a `legal_skills` body and `new-company-setup` carries the exact consent set,
  but `agent.py:613` leaves `load_skill` to the model's discretion. Measured 3
  runs each: A0 3/3, resignation 3/3, **director-consent-new-company 0/3,
  combined-roles 0/3**. `find_matching_templates` now returns the body itself
  (`LEGAL_SCOUT_SKILL_ROUTING`, compose default off, **on** in the running
  container). A/B: 0/3 → **3/3** on both failing prompts, others unchanged.
  ★First routing rule required unanimity across the shortlist and almost never
  held — the loose predicate drags a Resignation Letter in on the word
  "director". Majority of the SHOWN options, falling back to the leader.

- **Tool payload trimmed 23%** (`1.2.40`): `find_matching_templates` 9,160 →
  7,095 chars. `matches` carried a full filesystem path and internal score for
  13 candidates (3,015 → 1,691); `message`/`options` were a lettered a)/b)/c)
  menu that the instruction in the same payload forbids relaying (705 → 0).
  Verified unread first — the UI reads only `name`/`display_name`/
  `selected_template`/`error`/`suggestion`/`clarification_needed`
  (`toolDisplay.ts:461`).

### ★★★OPEN — template drift, the worst one found today

**The model sometimes generates a different document than the user asked for.**
~2 runs in 11, on the two-message flow:

    request:  "director consent form (non group member) for Win Win Tint"
    call:     generate_document(template_name="Individual Shareholder Consent Form.docx")

Also seen: *Group Member* consent for a request naming *Non-Group*. This is worse
than a missing field — it is the wrong legal instrument. It also explains the
remaining "no date in document" results: the Individual Shareholder Consent Form
has **no date placeholder at all**, so the absence is a symptom of the drift, not
of the merge. **No test covers template choice across a multi-message flow.**

### Context / cost — measured, mostly leave alone

- **Gemini caches implicitly.** 24,386 of the ~31,209-token floor are served from
  cache with NO `cache_control` anywhere in this codebase — that syntax is
  Anthropic-only and would be a no-op on `google/gemini-3.6-flash`. ★I claimed
  "no prompt caching" from a cold-cache first measurement ($0.0242); steady state
  is $0.0077. **8,785 tokens miss on every turn** — cause not yet established,
  `add_datetime_to_context=True` is the prime suspect for splitting the prefix.
- **`max_tool_calls_from_history=3` was implemented, baked as `1.2.41`, measured
  and REVERTED.** Post-document turns averaged 60,487 input tokens without it and
  55,036 with (9%), but individual turns ranged 33k–75k in BOTH arms — the effect
  is smaller than the variance, and one trimmed run auto-filled TODAY's date into
  a consent form. `agno/utils/message.py:10` filters HISTORY only; the current
  run's own tool results are never touched, so it cannot fix a 136k single turn.
- **The 5-run history window does NOT corrupt the document.** A card answer stops
  being conversationally recallable at exactly 5 padding turns (`date kept` 2/3 at
  0–3 pads, **0/3 at 5, 7, 9**) and the model then says "Signing Date: None
  provided". The DOCUMENT is still right — `active_task.collected` +
  `smart_doc.py:1054` — verified end to end at 0 and 7 pads. Real but smaller
  defect: `collected` never reaches conversation context, so "what have I told you
  so far?" is answered wrongly late in a thread.

### Client masters — OneDrive folder checked 2026-08-24

`~/Downloads/OneDrive_1_24-8-2026`: 15 `.docx` (exactly the register, no extras),
5 DICA extract PDFs, 1 `STRICTLY CONFIDENTIAL` xlsx. **14 of 15 byte-identical to
what is installed; field sets identical on all 15**, 155 placeholders total.
★**`Director and Shareholder Consent Form.docx` is not there either** — N5 has no
source anywhere, and the tracker row marks it `(new template)` itself.
⚠ Do not copy that folder into the repo tree — `documents/` is bind-mounted and
has been committed before.

★★★**Five templates carry NON-BREAKING SPACES inside placeholder names**
(`[individual\xa0shareholder_1_name]`). The product folds them at one choke point
(`placeholders.py`), so this is handled — but any ad-hoc scan with an
`[a-zA-Z0-9_ ]` character class reads them as ABSENT and reports phantom "ghost
fields". I hit this and had to retract a finding.

### Template knowledge is 87% empty

    Annual General Meeting Minutes    purpose=214  when_to_use=127  how_to_use=412
    Corporate Shareholder Consent     purpose=303  when_to_use=172  how_to_use=503
    the other 13                      purpose=0    when_to_use=0    how_to_use=[]
    9 of 15                           ai_analyzed = FALSE  (while ai_trained = TRUE on all 15)

`ai_trained` claims trained while nothing was analysed. This is why matching falls
back on FILENAMES, which is the root of the near-neighbour behaviour above. Filling
it is the real version of "convert the templates to skills" — the semantic layer,
with every `.docx` left exactly as the firm wrote it. NOT DONE.

### Harness notes

- `tests/tracker_layer3_live.py` returns **NO-DOC on every case**, including on
  `1.2.34`, so it predates this session. The agent ends the turn after
  `preview_doc` with zero text (`smart_doc.py:1829` documents the stop); the
  browser survives it with a synthetic "continue". **One nudge finishes the run** —
  the harness's own nudge path is broken, the product is fine.
- `scout/tools/clarification.py` now carries `from __future__ import annotations`
  so it can be imported off-container for offline testing despite
  `scout/__init__.py` booting the whole agent.

## ★★★Landmines found 2026-08-24 (1.2.0 groundwork)

- **`scripts/sync_templates.py` cascade-deletes trained state.** It reconciles `templates` against the `.docx` files on disk, and for every row in `in_db - existing` it runs three deletes: `templates`, `knowledge_vec WHERE source_file = 'template:<name>'`, `knowledge_lookup WHERE source_file = 'template:<name>'`. So **removing a template file destroys its embeddings and lookups**, and re-adding the file gives you back an untrained template with no warning that anything was lost. ★**CORRECTED — I had this wrong.** It does **NOT** run on boot. `grep -rn sync_templates` across `*.py`, `*.sh`, `*.yaml` and the Dockerfile finds **zero callers**: `startup_sync()` does not call it, `scripts/entrypoint.sh` runs only `python -m db.migrate`, and nothing in compose invokes it. It is an orphan script that only does damage when a human runs it by hand — which lowers the severity a great deal, and is worth knowing before anyone reaches for it to repopulate the register.
  ★ The corollary bit me directly: **template files on disk never reach the `templates` table on their own.** After deploying 1.2.0 with 15 `.docx` present and visible inside the container, `SELECT count(*) FROM templates` was still **0**. Registration happens through the admin upload endpoint, not by scanning the directory.
- **★★★A SWALLOWED EXCEPTION DOES NOT PROTECT THE CALLER — the transaction is already dead.** If any bookkeeping write (ledger, audit, telemetry) runs on the **caller's** connection and fails, Postgres marks that transaction aborted and every later statement the *caller* issues fails with `InFailedSqlTransaction: current transaction is aborted`, no matter how thoroughly the bookkeeping code caught its own error. Demonstrated on the live DB with a real `CheckViolation`:

  | | shares the caller's connection | own autocommit connection |
  |---|---|---|
  | caller's INSERT | ok | ok |
  | bookkeeping write fails | `CheckViolation` — swallowed | `CheckViolation` — swallowed |
  | caller's next statement | **`InFailedSqlTransaction`** | ok |
  | caller's `COMMIT` | **reports ok** | ok |
  | caller's work actually saved | **0 — LOST** | **1 — survived** |

  ★★★The commit **reports success** while the work is discarded — psycopg turns a commit on an aborted transaction into a rollback. This is the database-layer twin of "a 200 is not a working product": the caller sees every green light and loses the write. Anything writing a side record must open its **own** connection with `autocommit=True` and expose no parameter through which a caller's connection could be passed. `sync_company_people` is the live hazard — it runs on the caller's connection and deliberately does not commit, so a borrowed connection there takes down the whole company sync.

  **THE REMEDY when you cannot avoid the caller's connection: `SAVEPOINT`.** `ROLLBACK TO SAVEPOINT` is legal *inside* an aborted transaction and returns it to usable. Verified on the live PostgreSQL 18.4 with a real `ForeignKeyViolation`:

  | | no savepoint | `SAVEPOINT` + `ROLLBACK TO SAVEPOINT` |
|---|---|---|
  | caller's INSERT | ok | ok |
  | side-record write | `ForeignKeyViolation` — swallowed | `ForeignKeyViolation` — swallowed |
  | caller's next statement | **`InFailedSqlTransaction`** | ok |
  | caller's `COMMIT` | reports OK | reports OK |
  | caller's work saved | **0 — LOST** | **1 — survived** |

  So there are two correct shapes and only two: **own autocommit connection** (preferred — no caller to protect), or **a savepoint around every borrowed-connection write**. Name the savepoint from a module constant, never interpolate it. A `{"stored": False}` return value is not a fix: it is a truthful statement about the side record and says nothing about the transaction it just killed.
- **★★★A dead API route that answered HTTP 200 — `/api/company/generate-extract/{company_id}`.** It was defined *below* the frontend catch-all `@app.get("/{full_path:path}")`, which claims every GET registered after it, so the endpoint returned the frontend's HTML at **200** and its body never ran. **Verified live before the fix**, with a valid admin token:

  | request | status | content-type | body |
  |---|---|---|---|
  | `/api/company/generate-extract/1` | 200 | `text/html` | Next.js shell, build id `Q2HfIguvG23satBQR_OIJ` |
  | `/definitely-not-a-route` | 200 | `text/html` | **same build id** |
  | `/api/email/queued` (above the catch-all) | 200 | `application/json` | `{"success":true,"queued":[]}` |

  Byte-identical to a path that does not exist. Unauthenticated both look like `401 {"detail":"Authentication required"}` — the middleware answers first — so **you cannot see this without a token**. FIXED by moving the route above the catch-all (now at `app/main.py:7039`, catch-all at 7221). ★ `@app.post("/api/documents/send-email")` is still below it and is fine: the catch-all only claims GET. That asymmetry is why the bug survives a casual smoke test. The invariant worth keeping: **no `/api/…` GET may be registered after the catch-all** — the two GETs that appear after it in source are in the `else:` branch and are mutually exclusive with it.
- **★★★A SECOND POSTGRES LISTENS ON `127.0.0.1:5432` AND IT IS NOT THIS PRODUCT'S.** PostgreSQL **16.13 (Homebrew)**, owned by `rahulgupta`, holding `postgres` / `ai` / `hiredb`. Legal Scout's database is **PostgreSQL 18.4** inside the `scout-db` container, which publishes **no host port at all** (`compose.yaml` gives it no `ports:` block — only `scout-api` publishes 8080), so `scout-db` resolves only inside the `scout` bridge network and is reachable only via `docker exec`. A test that took the obvious `localhost:5432` default would **connect, succeed, and report green against a database with nothing to do with Legal Scout**. Any DB-touching suite must print the server version and database name and refuse to run unless the tables it needs are present.
- **A prompt instruction naming a tool that does not exist passes the audit when it has no parentheses.** `scout/agent.py:1563` says `**DO NOT call analyze_new_template**`, but nothing is registered under that name — agno sees `analyze`. `_audit_prompt_tool_contract()` only matches a name immediately followed by `(` with an argument-list shape, so a *negative* instruction slips through. The result: the model cannot avoid calling a name it is never shown, and the tool the instruction meant is unguarded.
- **★★★TWO DIFFERENT FUNCTIONS ARE REGISTERED UNDER ONE TOOL NAME — `list_sources`. Live, and no startup guard can see it.** Agno keys a tool by the function's own `__name__`, not by the dict key it was fetched under. Confirmed inside the container (agent construction bypassed with a namespace stub, both modules loaded from disk unmodified):

  | registered via | agno tool name | function |
  |---|---|---|
  | `scout/agent.py:309` `list_sources` (from `create_list_sources_tool()`) | `list_sources` | `scout/tools/awareness.py:30` |
  | `scout/agent.py:278` `knowledge_tools["list_knowledge_sources"]` | **`list_sources`** | `scout/tools/knowledge_tools.py:165` |

  `SAME agno tool name? True. SAME function? False.` **One of the two is unreachable**, and the system prompt tells the model to call it (`scout/agent.py:1188`, "Use `list_sources` to see what's available"). Neither guard can catch this: `_registered_tool_names()` (`agent.py:325`) returns a **set**, so the collision collapses to one entry and `_audit_prompt_tool_contract()` cannot raise; `_build_tool_inventory()` (`:371`) does `if name in seen: continue`, so the prompt gets one line carrying whichever docstring arrived first. Same class as the `preview_document` bug that forced migration 021 — an instruction pointing at a tool that is not the one you meant — but with **no possible startup raise**. NOT FIXED: renaming one changes which tool the agent calls, so it is a product decision. `tests/tracker_routines.py` pins the duplicate registrations so the set cannot grow silently.

  **FIXED 2026-08-24.** `knowledge_tools`' function is renamed to `list_knowledge_sources`, matching the dict key it was always exported under; awareness keeps `list_sources`, which is the one the prompt at `agent.py:1188` means (it filters by `source_type` and formats its output — the other returned bare filenames). `get_known_templates` was also removed from `_tools_to_add`: it and `list_templates` were the same object bound twice at `:242-243`.

  **And the registry now refuses to boot on ANY duplicate.** `_duplicate_tool_names()` counts instead of setting, and joins the existing `STARTUP_STRICT_TOOLS` refusal. Proven against both registries:

  | | agno names | duplicates | boot |
|---|---|---|---|
  | before rename | `list_sources`, **`list_sources`**, `search`, `lookup` | `{'list_sources': 2}` | **REFUSES** |
  | after rename | `list_sources`, `list_knowledge_sources`, `search`, `lookup` | none | proceeds |

  ★ A collision is strictly worse than a missing tool: a missing tool ends the turn visibly empty, a collision runs the **wrong function** and returns a plausible answer. Renaming the export-dict key fixes nothing — agno never reads it.
- **`get_known_templates` and `list_templates` are the same object registered twice** — `scout/agent.py:242-243` both bind `template_analyzer["list_templates"]`, and both names go into `_tools_to_add`. Low severity; pinned by a test that goes red with the fix named when someone corrects it.
- **CLAUDE.md's own "Agent Tools" table named EIGHT tools by the wrong name** — `search_knowledge`→`search`, `lookup_knowledge`→`lookup`, `list_knowledge_sources`→`list_sources`, `list_tracked_documents`→`list_documents`, `get_document_info`→`get_document`, `get_document_stats`→`get_stats`, plus `analyze_new_template`→**`analyze`** and `save_template_to_knowledge`→**`save_knowledge`** (`template_analyzer.py:617,632`). Those last two carry **three** disagreeing names each — the variable in `agent.py`, the export-dict key, and the function's own `__name__`, which is the only one agno uses. ★ `analyze`, `search` and `lookup` are what the model is actually offered, and they are extremely generic names to choose between. The prompt inventory is generated, so the model is unaffected; the exposure is that this table is what a human reads before writing a skill body — which is exactly how migration 021 became necessary. Re-checked: no seeded skill body names any of the six, so the data is clean.
- **★★★`DELETE /api/dashboard/company/{name}` could delete EVERY company. FIXED.** `app/main.py:5223` was `DELETE FROM companies WHERE company_name_english ILIKE %s` on the raw unquoted path parameter, with **no `LIMIT`** and `conn.autocommit = True` set two lines above — so no transaction to roll back. ILIKE reads as case-insensitive equality, but LIKE metacharacters in the parameter are live. Measured on throwaway rows (4 seeded, fictional names, real register untouched at 0):

  | path parameter | before fix | after fix |
  |---|---|---|
  | exact name | 1 deleted ✓ | 1 deleted ✓ |
  | different case, same name | — | 1 deleted ✓ (case-insensitivity kept) |
  | a name containing `_` | **2 deleted** — took a sibling | 1 deleted ✓ |
  | `DELETE …/company/%25` → `%` | **4 deleted — ALL of them** | **0 deleted** ✓ |

  ★ The `_` row needs no attacker: it fires on any registered company name containing an underscore, and takes silent collateral. Severity was bounded by `require_admin`, so this was a destructive-operation footgun rather than an auth bypass. Fixed to `lower(company_name_english) = lower(%s)`. The follow-up `knowledge_lookup` sweep stays a LIKE — it is a genuine substring match — but its parameter is now escaped with an explicit `ESCAPE '\\'`, or deleting a company named `%` would empty that table too.
- **★★★CROSS-COMPANY LEAK, LIVE, in the agent's `search_knowledge` tool.** `scout/tools/knowledge_base.py:461` is `SELECT DISTINCT key_name, key_value, source_file FROM knowledge_lookup WHERE key_value ILIKE %s LIMIT %s` — **no `source_file` restriction of any kind**. `add_company()` writes six company-identifying rows per company at `:681-686` under `source_file = f"company:{company_name}"`, so registered office, directors and registration numbers for **every client** are returned on any matching substring. `search_knowledge` is a registered agent tool (`scout/agent.py:272`, and `search_knowledge=True` at `:1697`). Company scope in that store is a **naming convention inside a string**, not a key: nothing constrains it, and a company rename orphans every row. NOT FIXED — the scope column does not exist, and narrowing the tool changes what the agent can answer. **FIXED 2026-08-24, narrowly.** `search_knowledge` now excludes the `company:%` namespace by default; `include_clients=True` is passed only by `GET /api/knowledge/search`, which also now requires admin. The agent keeps `get_company` / `get_directors` / `get_shareholders`, which resolve a company first, so no capability is lost. Measured with two fictional clients sharing a street name:

  | query path | rows | distinct CLIENTS exposed |
|---|---|---|
  | old (git HEAD) | 3 | **2 of 2** |
  | new — agent default | 1 | **0** |
  | new — admin opt-in | 3 | 2 (deliberate) |

  Template knowledge stayed reachable throughout. ★This does NOT add the scope column — company scope in that table is still a naming convention inside a string. It keeps the client namespace out of the model's reach, which is the part that was urgent.
- **`scout_learnings` is scoped by `user_id` only** (`app/main.py:6371`), yet `scout/agent.py:1240-1275` instructs the model to save company-specific facts into it (`save_learning("City Holdings Limited is stored as …")`). `search_learnings` then serves that back to the same clerk while they work on a **different** client. Same failure mode as the leak above, different store.
- **`scout/__init__.py` boots the entire agent on ANY submodule import.** It is `from scout.agent import scout, scout_knowledge, scout_learnings`, so `import scout.anything` constructs the Agno agent, the model client, the DB handle and all 45 tools — and agno pulls `mcp`, absent locally. Consequence: no part of `scout/` is unit-testable off-container, and any script importing one helper pays full agent construction. Work around it with a namespace stub; the real fix is making `scout/__init__.py` lazy.
- **★★★`_LINK_COLS` is a positional PREFIX of three queries.** `app/main.py` builds `get_person`, `person_companies` and `list_company_people` from the same column string; the third appends `p.full_name, p.nationality, p.nrc_passport_no` and reads them **by index**. Adding a column to `_LINK_COLS` without renumbering that slice puts the person's NAME into `company_name` on `/api/companies/{id}/people` — no exception, just a wrong answer. A star comment now sits above the constant.
- **★★★`link_company_person` NULLed every field the caller omitted.** The UPSERT set all columns from `EXCLUDED`, so a partial body wiped the rest. **This was already firing in production**: the "Link company" form never sends `share_class`, so re-linking someone to fix an appointed date silently cleared their share class, invisibly. FIXED — fields absent from the body keep their stored value; a field present but empty still clears, so deliberate blanking works. Measured on the live DB: body carrying only `resigned_date` NULLed **4 of 4** untouched fields before, **0 of 4** after.
- **`cessation_recorded_by` is stamped from the session, never the body.** `require_admin(request)` supplies it. A recorder the caller names is a claim, not an audit trail — a forgery control proves a body claiming `somebody.else@attacker.test` still stores the real admin. An unrelated re-link does not re-stamp it.
- **`slot_resolver.py:253` `is_valid_entry` always returns True.** It does `return bool(_contract_validate(entry))`, but `app/slot_contract.py:102 validate_mapping_entry` is `-> tuple[bool, str | None]` and **all 12 of its return paths return a 2-tuple**. `bool((False, "reason"))` is `True`, so every entry validates, including invalid ones. **LATENT — `grep -rn is_valid_entry` finds only the definition; there are zero callers.** **FIXED** with `ok = _contract_validate(entry); return bool(ok[0] if isinstance(ok, tuple) else ok)`. Measured on 6 entries: the contract rejects 5 of them, the old code returned True for **5 of 5**, the new code for **0 of 5**, and the valid control still passes.
  ★ The test trap underneath it: `_contract_validate` is `None` unless `app` imports, and `app` needs `jwt`. A venv without `jwt` exercises the FALLBACK branch, cannot reproduce the bug at all, and **reports green**. The container has jwt, so the broken path is the one that ships.
- **Download-link regex in the tracker suites.** `tracker_layer3_live.py` — **fixed, but it was never a live defect and my earlier note over-claimed it.** The `/documents/…` alternative requires `\.docx`, so the greedy `[^\s)"']+` backtracks to the extension anyway; and there is **no `/api/documents/download/` route in the product at all** — the only occurrences are the two tracker suites and `scout/testing/scripted_runtime.py`. The product emits `/documents/legal/output/{f.name}` (`app/main.py:4602`). So the greedy alternative matches nothing the real agent sends; the fix there is a defensive no-op. **`tracker_layer3.py:643` is different and IS live**: the scripted suite is the gate, its runtime is what emits `/api/documents/download/…`, and the alternative there is unanchored. Measured on `"…e1-minutes.docxThe minutes are ready."` → scripted extracts `…docxThe`, live extracts `…docx`. It has not fired only because the fixtures happen to leave whitespace after the URL. One fixture without that space turns every case into ERROR "could not read docx" for a reason unrelated to the product.
- **`slot_resolver.py` had no `from __future__ import annotations`** (its sibling `repeat_regions.py` did), so its `str | None` annotations made it unimportable on python 3.9, the system python here. **FIXED — the import is at `slot_resolver.py:28`.** Verified: same module without the line raises `TypeError: unsupported operand type(s) for |: 'type' and 'NoneType'` on 3.9.6; with it, imports and `collect_slot_requests` is callable.
- **`scout/tools/slot_resolver.py:923 _member_position_covered` is dead code** — measured 0 calls across all 8 slot kinds.
- **Circular import**: `scout/__init__.py` → `scout.agent` → `db` → `app/__init__.py:8` → `app.main:24` → `scout.agent`. Anything importing `scout.*` outside the container trips it. Import submodules by path instead.
- **The container has drifted from its image.** `docker diff scout-api` shows `/app/static-frontend` overwritten by a `docker cp`, so `docker tag scout:latest scout:<rollback>` would have captured a rollback point **missing the live frontend**. Use `docker commit scout-api <tag>`. Verified by chunk `webpack-f40d06f764fe8d0f.js` — present in the committed image, absent from `scout:latest`.

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
- Auth required on all `/api/*` endpoints: 15 previously unprotected endpoints now require JWT (template upload/delete, training, export, company CRUD)
- ★★★ **"All endpoints" meant `/api/*` only — and that was not the whole app.** `AuthMiddleware` returns early on any path not starting with `/api/`, so the `app.mount("/documents", StaticFiles(...))` tree — generated documents, uploaded DICA filings, the firm's templates, cached previews — was served to anyone. Measured 2026-08-06: a real AGM minutes `.docx`, HTTP 200, 29,313 bytes, no token, on a container published to `0.0.0.0`. `PUBLIC_ROUTES` held a `"/documents/legal/"` entry commented "Static file serving" that **never executed** (that list is read after the `/api/` early return), so it looked like policy while doing nothing. Now gated by `STATIC_PROTECTED_ROOTS` **above** the early return, via `_request_jwt` → header / `?token=` / `ls_session` cookie. The cookie is why `<a href>` downloads still work with no link change. Guarded by U17, which asserts ORDER — a gate below the early return is as dead as the comment was
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
GET  /api/email/queued                        # Emails the agent queued, awaiting approval (auth)
POST /api/email/queued/{id}/send              # THE ONLY path to SMTP for agent-composed mail (user's JWT)
POST /api/email/queued/{id}/discard           # Reject a queued email (auth)
POST /agents/scout/runs                       # AI chat (streaming)
POST /api/suggest-followups                    # LLM-powered follow-up suggestions
GET  /health                                  # Health check
```

★ **Route order matters.** Everything above must be defined BEFORE `@app.get("/{full_path:path}")` in `app/main.py`. Registered after it, a GET route returns the frontend's HTML with a **200** — and POST on the same path still works, because the catch-all only claims GET. That half-working shape survives a status-code check; read the body.

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
- **★★★CORRECTED 2026-08-24 — this landmine described the bug BACKWARDS.** `collect_slot_requests` did not *over*-ask numbered member slots; it collapsed every numbered position of a party family into a **single** question. Measured on the `appointed_director` family, container python 3.12.8, against HEAD and against the fix:

  | Template declares | Real parties | HEAD asked | Fixed asks |
  |---|---|---|---|
  | 3 slots | 7 | **1** | **7** |
  | 3 slots | 2 | 1 | **2** |
  | 3 slots | count unknown | 1 | 1 |

  So the ask-step **under**-asked while `repeat_regions` expanded the output correctly — the two consulted different sources. FIXED: `collect_slot_requests` now calls `repeat_regions._parties_for_family` for the families in `_REPEAT_FAMILIES` and keys its dedup on `position if real_count else None`, so an unknown count deliberately preserves the old collapse rather than guessing. Reproduced independently twice, by two different methods.

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

## Current State (2026-08-07)

**One activity tray + signing/authority correctness. Baked, UNCOMMITTED (tray only).** `scout:latest` on `http://localhost:8080`, health 200. Rollback image `scout:pre-activitytray-20260806`.

Suite **164 PASS · 4 SKIP** (`docker exec scout-api python3 /app/tests/test_units.py`).

### ★★★ The product is on a FRESH INSTALL — Layer 1 is 8 PASS / 17 BLOCKED, and that is correct

**★CORRECTED 2026-08-24 — the count AND the cause are both out of date.** The wipe (requested 2026-08-06) deleted all 15 templates and only 2 were re-uploaded; that is no longer the state. Measured now:

```
on disk → 15 .docx    git status (that dir) → 0 entries    git ls-files → 16 (15 .docx + .gitkeep)
templates table → 0 rows          companies table → 0 rows
```

The files are all back. **Layer 1 is still blocked, but for a different reason, and restoring files will not unblock it** — they are present and *untrained*. Three gates stand between here and 25/25:
1. `templates` is empty, so `POST /api/knowledge/train-start` reads 0 rows and returns `{"status": "nothing_to_train"}` (`app/main.py:4058`).
2. `SKIP_AI_TRAINING: "true"` is hardcoded at `compose.yaml:79` and not overridable from `.env`, so training is a silent no-op (`ai_analysis = None`, `app/main.py:3642`).
3. `companies` is empty, and `/api/documents/fill-view` — which every Layer 1 assertion reads — needs a company. **Retraining alone cannot reach 25/25.**

Recreating the container to flip gate 2 pulls `scout:latest` (`compose.yaml:57`), which reverts the drifted frontend — use `IMAGE_TAG=1.1.0`.

All 17 report the identical `Template not found: …docx` from `/api/documents/fill-view` returning `success:false`. **BLOCKED is a third state on purpose** — the assertion never executes, so this is *absent*, not *broken*. Printed as FAIL, C3c ("Resignation Letter offers WIN WIN TINT") would send someone debugging `people_picker.py` over a missing file. Same reasoning as the `SKIP` state in `test_units.py`. Restore with `git checkout -- documents/legal/templates` (bind mount, live immediately), then retrain.

### ★★ One tray replaced the blocking training modal

Training already survived the tab closing — what it did not survive was the UI, because the only way to watch it was a modal covering the page it was training from. `startTraining` now opens `ActivityTray` on the Training tab (`openTab('training')` + `kickTrainingPoll()`, because the idle poll is 20s and a tray that appears a beat after the click reads as a dead button). The modal stays behind the "Training log" button for the transcript.

Percentages added throughout: import rows, training queue **and** current-template step (`Step 5.5 of 16 · Map to DB columns`), artifact panel fields (`12/17 · 71%`). The in-flight template counts as a fraction of the queue bar, so one slow template no longer reads as frozen.

Copy fixed: "Fifteen steps" → "Sixteen stages per template, numbered 1 to 15 — 5.5 is a real half-step". `STEP_DEFS` has 16 entries; the NUMBERS were not changed, because they appear in stored logs.

**No Documents tab.** Nothing tracks document generation as a queue — it streams in chat. A fourth tab would have been drawn, not wired.

### ★★ Signature blocks expand from the party list, never from editing the .docx

Verified live on `Annual General Meeting Minutes.docx` (ships 2 individual + 1 corporate slot): 7 individual members → 22 rows / 7 signature blocks / 14 `__rr_N__` tokens, Present-member paragraphs grown to 7 in the same pass; 5 individual + 2 corporate → corporates get "Signed by its authorized representative" row groups, individuals the plain block.

★ `_parties_for_family()` reads `members` / `attendees` / `shareholders_selected` / `present_members` (member family) — **`shareholders_list` is NOT one of them** and returns 0 tokens with an unchanged document and no warning. That looks exactly like a broken expander.

★ A corporate representative is vetted against **that member company's** board. Unregistered → fails OPEN with a WARNING; registered but off-board → the name is DROPPED.

⚠️ Still unreconciled: `slot_resolver.collect_slot_requests` asks about the NUMBERED slots the template declares (1, 2, 3). A 7-party document renders correctly and may still only be asked about 3. Prefer the Fill-in tab for many-party documents.

## Previous State (2026-08-06)

**Correctness + safety release. COMMITTED** — 19 commits on `main`, baked into `scout:latest`. Rollback tag `pre-cfos-improvements` at `9491f97`; images `scout:pre-phase1-…`, `pre-approval-…`, `pre-emailgate-…`, `pre-emptystream-…`, `pre-docauth-20260806`, `pre-signing-fix-…`, `pre-register-authority-…`, `pre-slotfix-…`, `pre-freshreset-20260806`.

Suite **139 PASS** at the time · Layer 1 **25/25** (before the wipe).

Also landed in that pass: duplicate signature block (sole corporate member signing twice, 5 rows → 3); board-authority guard; cessation honoured on both candidate paths; type-aware member slot assignment; 7 dead skill tool references purged (migration 021) plus a write-time validator in `app/main.py` (`_reject_unknown_skill_tools`); stale `known_locations` removed from `intents.json`; the unfilled badge counting `custom_data` keys instead of template placeholders.

### ★★★ ONE REMOTE. IT IS PRIVATE. (was: two, public)

Earlier notes in this file said "no remote configured". That is **false** and led to a wrong recommendation (that a history rewrite was cheap because nothing had been published). Two remotes exist and both are **public GitHub repositories**:

**Current state (2026-08-26):** the only remote is
`origin` → `github.com/raahulgupta07/rahulai-legal-scout`, **private**. Use no
other repo. The two below were dropped as remotes on 2026-08-26; both still
exist on GitHub, both private, both holding `8763a9e` as dormant backups:

- ~~`origin` → `github.com/raahulgupta07/CHLLegalScout`~~ — no longer a remote
- ~~`airg` → `github.com/raahulgupta07/airg-legal-scout`~~ — no longer a remote

The exposure described below was real and is now closed on all three (all
private since 2026-08-25). The historical record is kept because the blob is
still in history: if any of these is ever made public again, that has to be
dealt with first.

Commit `be8d9e4` (2026-03-29) is an ancestor of `main` on **both**, and it contains the real client filing `DICA_Extract_ARCTIC_SUN_COMPANY_LIMITED_20260327.pdf` (44,587 bytes) plus 3 of the firm's `.docx` templates. Verified anonymously retrievable via the GitHub API on 2026-08-06 — roughly four months of exposure. `.env` was NEVER committed (only `example.env`; `/.env` is 404 on both), so no credentials are out.

Local `main` is 94 commits ahead of `origin` and 87 ahead of `airg`, so none of the recent work is published. **A local history rewrite does not remove anything from GitHub.** Making the repos private (or deleting them) is the only step that stops access, and it is the owner's to take. `git push` is off the table until that is settled.

### ★★★ Indian company law was hardcoded in a Myanmar product

`app/main.py:_get_legal_refs_from_name()` returned citations chosen by substring match on the template FILENAME:

```
"agm"/"egm"    → Companies Act 2013 - Section 100-104, SEBI Regulations
"director"     → Companies Act 2013 - Section 152, SEBI (LODR) Regulations 2015
"shareholder"  → Companies Act 2013 - Section 189, Companies (Mgmt & Admin) Rules 2014
```

The Companies Act 2013 is India's; SEBI has no jurisdiction in Myanmar. **All 15 templates held those constants exactly**, so the AI extraction step never once succeeded and this fallback supplied every citation in the product. Three bare `print()` calls were the only trace, and the same block set `jurisdiction = "Myanmar"` a few lines later.

Fixed: the function returns `[]` and logs at ERROR; **Myanmar section numbers are deliberately NOT substituted** — writing them by hand repeats the bug in a harder-to-spot form. Correct references come from the deep-training legal step (which already prompts for Myanmar Companies Law + DICA) and are a draft for the firm's lawyers, not an authority. Migration 018 cleared the 15 rows and replaced `DIN Application` (an Indian filing) with the DICA director particulars filing. `U12` guards it via `ast`, skipping docstrings — a line-based version failed on its own fix.

⚠️ `legal_references` is now EMPTY on all 15 templates by design. Re-run training to repopulate; the new ERROR logging shows whether that step works or falls back again.

### ★★★ The agent can no longer send email

`send_email_tool` used to reach SMTP directly on the agent's own decision — recipient, subject, body and attachment all chosen by the model, with no confirmation and no audit row. It now only **queues** to `email_logs` (status `queued`). Delivery is `POST /api/email/queued/{id}/send`, which requires the **user's** JWT — the agent has no session and no token. There is deliberately no `confirmed` argument: a flag set by the model whose judgement is being checked is not an approval.

- Row is claimed (`status='sending'`) in the same UPDATE that reads it — two clicks cannot send twice, and email cannot be recalled.
- A delivery **exception** leaves it `failed`, never re-queued (SMTP may have accepted before the error). **Unconfigured SMTP** is different — nothing was attempted, so it returns to `queued`.
- Attachment path re-checked against the documents dir at send time, not only at queue time.
- `"a@b.com, attacker@evil.com"` is refused, not split.
- ★ These endpoints must stay **ABOVE** `@app.get("/{full_path:path}")`. Defined below it, `GET /api/email/queued` returned the frontend's HTML with a **200** — queue permanently empty, no approval possible — while the POSTs still worked, because the catch-all only claims GET.
- **Not verified: real delivery.** SMTP is unconfigured here, so the success path stops at the SMTP connection.

### ★★ The tool list is generated; a mismatch refuses to boot

Four prompt/tool mismatches shipped while the list was hand-written prose guarded by a log line: `generate_dica_extract` (never registered), `list_companies` (registered as `list_all_companies`), `preview_document` (export key; `@wraps` made it `preview_doc`), and `generate_document_tool` — which lives in `scout/knowledge/routing/intents.json` and reaches the prompt as **DATA**, invisible to any source search.

`_build_tool_inventory()` now renders the list from the live registry into the prompt. Startup **raises** on a mismatch (`STARTUP_STRICT_TOOLS=0` downgrades it, for incidents only). Audit and inventory share `_registered_tool_names()`.

★ Purposes come from `.description`, **not** `__doc__`: an agno-wrapped tool is a `Function` instance whose `__doc__` is the class docstring, which put "Model for storing functions that can be called by an agent" on 24 of 45 tools.

### ★★ Fixing `preview_document` made the metric worse — correctly

The prompt named a tool that did not exist, so **"Step 3: PREVIEW FIRST (Required!)" never ran** and the model went straight to generation. Fixing the name made it execute — and Layer 3 stalls went 7 → 13 across 6 case-runs, with one case producing no document. The baseline was cheaper because a required step was broken.

| | runs | PASS | NO-DOC | stalls |
|---|---|---|---|---|
| baseline (preview unreachable) | 6 | 6 | 0 | 7 |
| after name fix | 6 | 5 | 1 | 13 |
| after Option A | 6 | 6 | 0 | 8 |

`create_document` was deregistered — byte-identical to `generate_document`; `prepare_document` is a strict prefix of it. Happy path is now `preview_doc → ask_questions → generate_document`.

### ★★ Empty turns are now closed from the tool result

`generate_document` ended the turn with **zero content 10 of 10 times** it was the last tool. The old recovery nudged with a synthetic `continue`, buying a second full inference to recover a sentence the tool result already contained.

- `buildClosingFromTool` renders it (message + fill count + markdown link). **Only a finished document may close a turn** — the same tool returns a readable `success:false` message ("Choose the resigning director…") that would leave the user told to pick someone with no picker card drawn.
- `preview_doc` gets `buildApprovalFromPreview` instead: the preview plus the approval card it owed. **Not an `AskUserCard`** — those resume a PAUSED run; this run completed, so the choice is sent as an ordinary next message.
- Against 25 real tool results: `generate_document [done]` 15 → closed, `[awaiting]` 2 → nudge, `preview_doc` 8 → preview+approval.
- A stream delivering **zero chunks** now throws instead of painting a blank bubble (a 200 with an HTML body drains fine and yields no events).

### ★ Verification landmines (cost real time on 2026-08-06)

- **`docker exec` without `-i` swallows heredoc stdin** — the script never runs, exits 0, prints nothing. A "passing" mutation test that never executed.
- **Silencing a build's stderr leaves a stale artifact** — `esbuild … >/dev/null 2>&1` failed, the old `.mjs` stayed, and the next run tested old code.
- **A source-regex assertion can fail on CORRECT code** — U15 allowed 300 chars between `if (!response.ok)` and `response.text()`; a comment pushed it to 347.
- **None of the three tracker suites executes frontend code.** They are Python clients, so anything in `agent-ui/` is invisible to a Layer 3 number. Verify frontend by running the function over real tool results from `ai.agno_sessions` and grepping the built bundle.
- **A bake is ~4 min of downtime on the only instance.** A message sent during one comes back as a blank bubble with **no run persisted** — check `ai.agno_sessions` before blaming the agent.

## Previous State (2026-08-04)

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

**Python floor — and it is systemic, not two files.** ★I have now corrected this line **three times**, each time after fixing one module and declaring the floor gone. It was not one bug; it is a pattern. A file annotating `X | None` **without** `from __future__ import annotations` is unimportable on the 3.9.6 system python (`TypeError: unsupported operand type(s) for |`). Fixed in the order they surfaced, each one revealing the next:

| # | file | annotation |
|---|---|---|
| 1 | `scout/tools/slot_resolver.py:28` | `str \| None` |
| 2 | `scout/tools/smart_doc.py:105` | `dict[str, Any] \| None` |
| 3 | `app/slot_contract.py` | `tuple[bool, str \| None]` |

**Nine more live files still carry it** and are deliberately NOT fixed: `app/main.py`, `db/session.py`, `scout/context/intent_routing.py`, `scout/context/source_registry.py`, `scout/evals/{grader,run_evals,test_cases}.py`, `scout/tools/{awareness,save_discovery,search}.py`. The last three hold **`@tool` decorators**, and PEP 563 turns annotations into strings that agno/pydantic must resolve at schema-build time — so adding the import there is a change to tool-schema generation, not a formatting tweak, and must be verified against a running agent rather than assumed. The container is 3.12.8 and unaffected by any of this.

★ Fixing one file does not remove the floor; it moves it to whichever module the next import reaches. Do not claim the floor is gone — run the suites.

★ Side benefit worth knowing: with `app/slot_contract.py` importable on 3.9, `slot_resolver._contract_validate` is no longer `None` locally, so the **contract branch is now the one the offline suite exercises** — previously it silently tested the fallback and reported green.

★ Do not gate a suite on a version literal. `tracker_fill.py` briefly hard-exited below 3.10; a version number is a guess about *why* an import fails and goes stale the moment someone fixes the real cause — which is exactly what happened here. The suite now attempts the import and reports the module, the line, the cause and the one-line fix.

| Suite | Scope | Determinism |
|---|---|---|
| `tracker_layer1.py` | 25 assertions off `/api/documents/fill-view` | **Deterministic — the real gate** |
| `tracker_layer2.py` | 30 scripted runs; asserts it asks rather than guesses | **Deterministic** — no model, no network |
| `tracker_layer3.py` | 14 scripted conversations → `.docx`, unzipped and grepped | **Deterministic** — no model, no network |
| `tracker_fill.py` | 43 checks over the fill/slot path | **Deterministic** |
| `tracker_layer2_live.py` | The old model-driven layer-2 run, preserved verbatim | Non-deterministic — costs API spend |
| `tracker_layer3_live.py` | The old model-driven layer-3 run, preserved verbatim | Non-deterministic — costs API spend |

Layer 2/3 failures move between cases run to run; do not treat one as a regression until it reproduces. Runs are tagged with `user_id` so they appear in the app's own sidebar.

### Known open (as of 2026-08-07)

**Unverified rather than broken:**
- **No frontend change has been confirmed in a real browser.** The closing render, the approval card, the queued-email card and now the whole activity tray are proven against real tool results / live endpoints and present in the served bundle (`/app/static-frontend/_next/static/chunks`), but never clicked. Browser automation has never connected in this project, and the three tracker suites are Python clients that cannot execute `agent-ui/` code.
- **Real email delivery is unproven** — SMTP is unconfigured, so the send path stops at the SMTP connection. Everything before that is tested.

**Open work:**
- `legal_references` is empty on all 15 templates by design. Re-run training to repopulate with Myanmar/DICA citations, then have the firm's lawyers confirm them.
- ⚠️ **The client's DICA extract PDF is PUBLIC ON GITHUB** — see the remotes block in Current State. This supersedes the line below, which assumed no remote existed. A local rewrite fixes nothing until the repos are private or deleted. Original note: the client's DICA extract PDF is still reachable in earlier git commits. No remote is configured, so a history rewrite is cheapest now. The 6.6MB client `.docx` commit (`544d23f`) can go in the same pass.
- Document packs: new-company setup still asks *meeting date* once per template. **Mitigated, not fixed** (2026-08-06) — the `ask_questions` continue-instruction now tells the model its answers stay valid for the rest of the conversation. Nothing on the server remembers a non-person answer: `smart_doc` recomputes `missing_user_fields` per document from the company record alone, and `party_selections` covers PERSON slots only. A real fix needs a conversation-scoped answer store.
- ~~A turn that ends empty with zero tool calls shows a blank bubble~~ **FIXED 2026-08-06** — told, never nudged (a nudge starts a new run with a new id, which is how the same document got generated three times). Gated on `sawReasoningRef` so a reasoning-only turn cannot trip it. Written to BOTH error state and `content`, because `AgentMessageWrapper` mounts `AgentMessage` only `{hasContent && …}` — error state alone renders nothing at all.
- ~~The model sometimes ends a turn without a closing sentence~~ **prompt fix landed 2026-08-06** — one rule, with a turn ending in a pause (`ask_questions` / picker) as the single explicit exception so cards do not get redundant prose above them. Still worth watching in practice.
- `collect_slot_requests`: the corporate-representative suppression was **wrong in the unsafe direction** and is fixed (2026-08-06). It counted `repeat_regions`' last-resort fallback — the corporate member's FIRST DIRECTOR from the register — as "already answered", so a resolution could be signed by whoever the register listed first with no picker shown. Measured on CITY MART HOLDING COMPANY LIMITED: resolved to MIN MIN, ask skipped on all four *Shareholders Resolution In Writing* templates. Suppression now requires a representative somebody actually CHOSE. Other slot suppression still not exhaustive.
- Python-repr parser retained in `useArtifact.ts` — required for sessions stored before tool results became JSON.
- ~~"Director and Shareholder Consent Form" template does not exist; tracker case B5 blocked.~~ **Confirmed 2026-08-25 and characterised.** Not in the register and not in the client's OneDrive masters; their tracker marks it `(new template)`. Run as the TWO approved consents instead — 3 reps each, all four tracker expectations met (asked for the new company name 3/3, person auto-filled 3/3, shares 3/3, capital 2/3, signing date 3/3, supplied values in the .docx, zero auto-filled dates). ★Do not author a substitute: a pass against a self-written file proves nothing about theirs while looking like a result.
- ~~The client's OneDrive master copy of *Notice of AGM to Shareholders* still lacks `[director_name]`~~ **STALE — checked 2026-08-25.** The 24-Aug OneDrive copy HAS `[director_name]`; field sets are identical to what is installed (the files differ by hash only). Safe to re-upload any of the 15.
- ~~`intents.json` `known_locations` points at `documents/legal/data/`~~ **REMOVED 2026-08-06.**
- ~~⚠️ **The register is empty after the wipe**~~ **RESOLVED — 2026-08-25: 15 templates registered, 4 tagged `new_company_setup`, companies populated.** Historical note: ~~2 of 15 templates~~ **15 of 15 template files were back on disk (2026-08-24) while the `templates` table had 0 rows and `companies` had 0 rows**, so nothing is trained and nothing is queryable. Layer 1 cannot be a gate until templates are restored and retrained. Backup with the 5 client DICA PDFs, 15 templates, 94 documents and `legalscout-full.sql` (523MB) lives at `~/Desktop/LegalScout-backup-20260806` — **the only copy of the client filings**.
- Duplicate detection runs only AFTER extraction, so N duplicate DICA files cost N full ~45s AI calls. Comparing filenames / registration numbers up front would skip them.
- No cessation-recording workflow: `company_people.resigned_date` is honoured by the picker and accepted by the endpoint, but no admin UI field sets it.
- Rotate `ADMIN_PASSWORD` and `JWT_SECRET_KEY` before this leaves localhost.

### Considered and rejected: porting to Cloudflare OS (2026-08-06)

Asked whether Legal Scout should move into `cloudflare/cloudflare-os`. **No** — the parts that don't fit are the parts that *are* the product: `python-docx` and the LibreOffice PDF step cannot run on Workers, Postgres + pgvector has no equivalent in KV/R2, and all 27 Agno tools plus the HITL resume contract would be rewritten from zero. Its per-user Gadget model also solves a problem one law firm with shared registers does not have.

Worth borrowing instead: their **Gatekeeper** pattern (approval + audit around external calls) — which is what the email gate above is. Their **Code Mode** idea (don't route data through the model just to copy it) is what the closing render does.

## Previous State (2026-07-27)

- **Background training release**: template training is now a server-side background job (`app/training_jobs.py`) that survives modal/tab/browser close AND server restart — DB-backed job + Postgres advisory lock + import-time watchdog. Per-template failures log+continue (fixes stop-at-N). ★★★Landmine: `@app.on_event("startup")` is dead under AgentOS lifespan → watchdog started at module import instead. BAKED `scout:latest`, rollback `scout:pre-bgtrain-fix-20260727`, E2E-verified (browser-close, server-restart, 11/11 done 0 fail, DB 15/15). UNCOMMITTED. ✅ RESOLVED: `startup_sync()` in full is now invoked at module-import time (`app/main.py:7625`); dir-create, migration check and the knowledge/skills refreshes all run.
- **Dynamic-templates release** (client feedback): setup-template filter + unbounded attendees/signatories (`repeat_regions.py`) + whole-document fill-in view (`fill_view.py`, `FillInView.tsx`) + admin Setup-group toggle. Baked into the `:8080` image (rebuilt 2026-07-27, rollback tag `scout:pre-dynamic-templates`), health 200, E2E-verified live on real data. UNCOMMITTED on `main` — not pushed. ~~Pending refinement: `collect_slot_requests` still over-asks numbered member slots~~ — **wrong, and now fixed**: it *under*-asked (one question for N positions). See the corrected landmine above.

## Previous State (2026-07-25)

- **EVERYTHING ON `main` (~40 commits, all feature branches deleted).** Insights restyle + streaming/typewriter + animated document panel + ask_questions cards + Task Continuity + Legal Skills engine + single sans + pixel-exact bagofwords login + admin scroll fixes. Baked into the local Docker image (:8080) and Playwright-verified live. Rollback tags kept: `pre-insights-restyle`, `pre-legal-skills`, `pre-ui-revamp`, `pre-rail-revamp`, `pre-v2-phase0`. NOT pushed to any remote.
- **Login page** measured 1:1 against Insights `:8095/users/sign-in` (computed-style loop): h1 40px/600, form col 440px, fields 440×64 r12, buttons h-12 r11 full-width, showcase panel 677px r22. Showcase animation uses FICTIONAL companies only — no real client data pre-auth.
- **Known LEFT items:** one full-chain E2E in a single run (card→picker→fields→preview→generate→download; prior failures were test-selector brittleness, not product); context diet for 100k+-token resumed turns (auto-nudge is mitigation); ~~People-register backfill + `country_of_residence` migration~~ (BOTH DONE 2026-08-03 — `people_sync.py`, migration 015); company page link to the ORIGINAL uploaded DICA PDF (`pdf_url` never stored on extraction — file exists on disk under `/documents/legal/uploads/`); cold-start-interview run to fill the CHL practice-profile skill.
- `FUTURE_READINESS.md` predates the restyle — its §2 tokens and phase table are superseded, but its defect list (§6) and People-register data findings (§7) remain valid.
