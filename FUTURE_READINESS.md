# Future Readiness — CHL Legal Scout

Last updated: 2026-07-20
Status: design settled in a working mockup, **zero source changes shipped**. Rollback tag `pre-rail-revamp` at `161c937`.

---

## 1. Where we are

Phase 0 is done. Tokens are extracted from real shipped component source. A full clickable mockup exists with a working chat, and — more importantly — the feature surface has now been audited in **both** directions.

Reference build: `scratchpad/scout-app.html` (~129 KB, single file, no build step, seeded with the live `companies.id=1` record).

Nothing in `agent-ui/` or `api/` has been modified. This file and the mockup are the only artefacts.

---

## 2. Design source of truth

**Scout already has a shipped token layer.** The UI revamp merged to `main` (rollback tag `pre-ui-revamp`) collapsed the old two-half-applied systems onto one set of custom properties in `agent-ui/src/app/globals.css`, **including a dark theme**. That is the source of truth. Do not re-tokenize.

| Token | Light | Dark |
|---|---|---|
| Brand | `#c2410c` | `#c2410c` |
| Surface | `#ffffff` | `#232322` |
| Surface raised | `#ffffff` | `#2c2c2a` |
| Ink | `#2a2a27` | `#e8e8e4` |
| Border | `#e4e4e1` | `#343431` |
| Border strong | `#c9c9c4` | |
| Text | `#1f1f1d` | |
| Text secondary | `#3d3d39` | |
| Text muted | `#6b6b66` | |
| Accent | `#ededea` | |

City Agent Insights was read for **layout grammar**, not colour — rail proportions, row padding, section labels, page container, card and grid rhythm. Its brand is `#C2541E`; Scout's shipped brand is `#c2410c`. Close, not identical. **Ship Scout's.**

Insights files read (grammar only, and never `DESIGN_SYSTEM.md`, which was ruled out):

| File | What it gave us |
|---|---|
| `CityAgent Analytics/frontend/components/nav/ChatHistoryRail.vue` | Rail proportions |
| `CityAgent Analytics/frontend/pages/artifacts/index.vue` | Collection-page grammar |

### Layout scale

| Token | Value | Notes |
|---|---|---|
| Rail width | `256px` | |
| Nav row | `px-2.5 py-1.5` `rounded-lg` `13.5px` | |
| History row | `px-2.5 py-1.5` `rounded-md` `13px` | |
| Section label | `10px` semibold uppercase, `tracking-wider` | |
| Page container | `max-w-[1120px]` `py-6` | |
| Page title | `30px` medium | |
| Card radius | `rounded-2xl`, hover border `#9aa0aa` | |
| Stat grid | `1 / sm:2 / lg:4`, `gap-3` | |

**Assumptions that reading real code disproved:**

1. Insights' brand is `#C2541E`, not `#c96342`. The wrong value came from `dash/frontend/src/app.css` — a SvelteKit tree that is **not** what ships (`ca-app` serves `_nuxt`). Reading it would also have shipped `--pw-radius: 0`, square corners everywhere. Moot for Scout, which has its own brand — but the lesson stands.
2. The active nav row is a **background change only**. No left bar, no brand text. (Scout adds a 2px bar for the *admin* rows specifically, to separate them from chat rows — our addition, not Insights.)
3. **Scout already has a dark theme**, built during the revamp. Earlier drafts of this file called dark mode an open question because Insights is light-only; that was wrong. `<html>` was previously pinned `data-theme="light"` and has been unpinned — check it stays that way.

---

## 3. Architecture decisions locked

**Rail lives in the layout, not the page.** Next.js App Router `layout.tsx` renders it once; `usePathname()` drives active state. It must not unmount across route changes — that was the original ask and it constrains everything downstream.

**One rail, both shells.** Admin nav pinned on top, chats below a 1px divider. Only the chats block scrolls. Two active treatments coexist: admin row → 2px brand bar + `#E3E6EB`; chat row → `#E3E6EB` only.

**Overview is one nav item with three segments** — Dashboard / Documents / Emails.

**Registers and Administration stay as separate items.** This reverses an earlier proposal to fold them into tabs. The audit killed it: the shipped sidebar already uses these exact three groups, Settings already carries 4 tabs, Users has its own activity log that duplicates the Settings Activity tab, and Companies alone has six view states. Consolidating would have buried working structure.

---

## 4. What the shipped app already has

This is the correction that matters most. **The nav we set out to design already exists.**

`app/admin/components/Sidebar.tsx` ships Overview / Registers / Administration with a collapse toggle, accent bar on active, `aria-current`, path-prefix matching, per-item `minRole` gating, an "Open chat" link, a user block, sign out, and a mobile overlay.

The real work is narrower than planned: the **chat rail and admin rail are two separate components**. Phase 1 is unifying them at layout level, not inventing a nav.

---

## 5. Feature surface (audited both directions)

The first pass built a mockup *from* the audits and never checked codebase → mockup. That check found ~60 real controls missing and ~10 invented. Both are now reconciled in `scout-app.html`.

### Invented — do not build these

Chat session date grouping (reality is a flat list) · session rename · session search · artifact-panel Email button · artifact page nav `[◀ 1/3 ▶]` · artifact zoom · placeholder highlighting in the artifact · email resend (**the Emails screen is a read-only log**) · a "reset templates" danger action · a Knowledge "view all".

### Real behaviours that must survive the rebuild

- **Every table sorts, every column**, with `aria-sort` and nulls sinking regardless of direction
- **`ConfirmButton` arms then auto-disarms after 5 seconds** — this is the delete pattern app-wide, not modals
- `DataTable` Enter/Space row activation, `hideBelow` responsive column dropping, `rowTone` striping
- Modal focus trap, Escape, scroll lock
- Templates: multi-file sequential upload, duplicate-upload prompt, ~18 detail cards
- Companies: six view states (`list|choice|pdf|manual|edit|view`), docked non-modal `TrainingLogPanel`, and the **dynamic "Template required fields" section** from `/api/dashboard/field-registry` — the 64%→92% fill mechanism
- Settings: "Validate all", per-model Test with Verified/Failed badges, timezone card (19 zones), 4 SMTP presets with app-password notices, password show/hide, health check, DB stats, backup download + restore-with-counts, S3 toggle-gated fields, **four** danger-zone resets with four distinct typed phrases (`DELETE DOCUMENTS`, `DELETE COMPANIES`, `RESET CHAT`, `DELETE EVERYTHING`)
- Loading screens, error notices, empty states with numbered steps, empty-under-filter states with Clear, offline detection on Dashboard

### Absent everywhere — decide before building

No pagination on any screen. No bulk selection. No CSV export. No print, copy, context menus, or keyboard shortcuts in admin. Knowledge caps at the first 25 rows and 6 columns with no way to reach the rest.

**The 15-step training modal is the product.** Live SSE, named steps, degraded-step handling. It carries more weight than any other screen.

---

## 6. Defects found while auditing — not design issues

Each is real, reproduced from source, and unfixed.

**`/admin/people` is reachable by URL for the `user` role.** The sidebar hides it via `minRole`; `AuthGuard`'s path list omits it. Two gating systems that disagree. Gating belongs in one place. *Authorization hole — fix before anything cosmetic.*

**Settings S3 "Test connection" persists credentials before testing.** There is no way to try a key without storing it.

**Company "view" mode does not disable its fields.** It swaps a Read-only badge; the inputs stay editable. Save always POSTs `addCompany()` — there is no update endpoint.

**Health check runs unauthenticated** — plain `fetch` to `/health`, no token.

**Users has a Status column and an Inactive stat, but no way to change status.** Dead UI. No self-delete guard either.

**`/admin/templates/upload` is orphaned** — nothing links to it, and it accepts `.docx` only while the Templates page accepts `.doc/.docx/.pdf`.

**`knowledge.last_trained` is computed then hardcoded `null`** and never displayed.

**Dead creator-tracking block** at `app/main.py:4678-4684` — opens a connection, opens a cursor, closes both, writes nothing. The comment says "Track creator". This is why `created_by_email` is null on every company.

---

## 7. Data findings — DICA extraction and the People register

Verified against the live DB and the actual source PDF still on disk at `/documents/legal/uploads/2026_01_20_Arctic_Sun_Company_Extract.pdf`.

### The People register is not connected to anything

Whole codebase has exactly **one** `INSERT INTO people` (`main.py:1280`, the manual Add-person form) and **one** `INSERT INTO company_people` (`main.py:1497`, the manual Link modal). PDF extraction writes `companies.directors` JSONB and stops.

Live state: `companies` 1 row with 2 directors + 1 corporate member as JSONB; `people` 1 hand-typed test row linked to nothing; `company_people` **0 rows**; `document_signatories` **0 rows**.

Two sources of truth for the same fact, and the automated one feeds the older shape.

### The in-chat picker also reads the register

`scout/tools/people_picker.py` queries `people`, `company_people` **and** `companies`. The picker was verified live in real Chrome — card rendered, radio clicked, Confirm resumed the same `run_id`, and the deliberately-chosen *second* director reached the `.docx`. That path works.

It works today by falling back to `companies.directors` JSONB, because `company_people` is empty. So the register-backed branch of the picker has never executed against real data. Backfilling does not risk the working path — it activates the intended one.

Related: RC5 (frozen `directors[0]` indexes) was proven dead in the database, then **resurfaced at runtime** because `prepare_document_data` pre-fills slot placeholders from the company record, making an unanswered slot look resolved. Fixed by persisting selections to `party_selections`. A prompt-only fix was attempted twice and failed — do not "simplify" the persisted store back into instructions.

### The templates already read from the register

Training step 5.5 wrote this into `templates.field_mapping`:

```json
"phone": { "source": "slot", "slot": { "of": "people_register", "kind": "new_director" } }
```

Same for `email`, `address`, `nric`, `nationality`, `date_of_birth`. The wiring is done. The register it reads holds no real director, so **all six resolve to TBD**. The backfill is not a nice-to-have — it is what makes the consent forms fillable.

### The 8 person fields: 5 come from DICA, 3 never do

| Field | `people` column | In a DICA extract | Extraction asks for it |
|---|---|---|---|
| Full name | `full_name` | yes | yes |
| Nationality | `nationality` | yes | yes |
| NRC / Passport | `nrc_passport_no` | yes | yes |
| Gender | `gender` | yes | yes |
| Date of birth | `date_of_birth` | yes | yes |
| Phone number | `phone` | **no** | no |
| Email address | `email` | **no** | no |
| Residential address | `residential_address` | **no** | no |

The Officers block carries exactly: Name, Type, Date of Appointment, Date of Birth, Nationality, N.R.C./Passport, Gender, Business Occupation. Nothing else.

**Never map the company's contact detail onto a person.** The Registered Office line contains `+(95) 9 777393888` and `LEGAL@CITYHOLDINGS.COM.MM` — those belong to the company. Using them on a director's consent form would be wrong and would look like the gap had closed.

**A 9th field is required and has no column.** Both Director Consent Forms need `country_of_residence`. `people` has no such column and it is not the same as nationality. Needs a migration.

Three of fifteen templates demand person contact detail: both Director Consent Forms (address + phone + email) and the Individual Shareholder Consent Form (address). `gender` is captured, stored, and used by **no** template — pronouns resolve through a separate `pronoun` field.

### Extraction quality, from the one real run

- `company_name_myanmar` is **model output, not document content**. The PDF's Burmese is unrecoverable CID codes; a second LLM call reconstructs the name from the English. Plausible, unverified, and it goes onto filed documents.
- `total_capital` and `consideration_amount_paid` are the **same share-bundle cell read twice**. No DICA field is labelled either name.
- The `full_text[:8000]` cap is **silent**. This document was 4,534 chars so it fit. A longer extract truncates with no warning event — missing directors are indistinguishable from a company that has none.
- `"ZA W MIN LATT"` — the space is in the PDF text. Verbatim capture means verbatim errors, now stored as a legal name.
- `filing_history` keeps DICA's date format while every other date was ISO-ised. Unsortable.
- Mortgages and Charges is on the page and not in the prompt. Never captured.
- `source='manual'` on a company that came from a PDF; `pdf_url` null though the file is on disk; `created_by_email` null (see the dead block in §6).
- `custom_fields` is `[]` where the column defaults to `{}`. Every `custom_fields->>'key'` read on this row silently returns null — the dynamic field system is dead for it.

---

## 8. Open question blocking Phase 1

**Fonts.** Scout's static export ships a CSP that blocks Google Fonts. Linked-by-URL faces **fail silently** — no error, just wrong type. Either self-host as `@font-face` data URIs, or use system fonts.

Dark mode is **not** an open question — it shipped with the revamp (§2). The reference mockup is light-only and is therefore *behind* the app on this point; anything built from it must carry the dark tokens through.

---

## 9. Known traps

**Tailwind alpha modifiers do not work on `var()` colors.** Both `bg-[var(--ink)]/20` and `bg-primary/90` emit **no CSS** — the element renders transparent and nothing warns you. Use `color-mix(in srgb, var(--token) 20%, transparent)`.

**Verify the compiled bundle, not the source.** A source edit that never made it through the build has bitten this repo before. Check `HEAD` *and* the built output.

**`ls` and `grep` return empty stubs** in this environment (rtk hook artefact). Use `python3` file walks, Read/Glob, or `rtk proxy`.

**An endpoint existing is not a screen existing.** Log-level config, an S3 file browser, an API-keys editor and a template reset were all listed as shipped UI purely because routes existed. None have any interface. Read the page, not the router.

**Build the mockup from the codebase, not from the sibling product.** Every invented control in §5 came from assuming Scout matched Insights. The same mistake produced the dark-mode "open question" in earlier drafts of this file — Scout had already shipped one.

**`bg-[var(--ink)]/20` silently renders nothing.** See §9 opener. 19 instances were found and fixed during the revamp; keep HEAD at zero.

**`globals.css` once carried `body .rounded-* { border-radius: var(--radius-none) !important }`**, which squared off every Tailwind rounding class app-wide and shipped a spinning *square* loader. Removed. Plain rounding classes are safe; do not reintroduce the `rounded-[var(--radius-sm)]` workaround.

**Case-insensitive filesystem.** Shared kit lives in `components/ui/kit/`, not `Button.tsx` beside the existing `button.tsx` — macOS would clobber the shadcn button the chat imports.

---

## 10. Phases

| Phase | Scope | Status |
|---|---|---|
| 0 | Token extraction; two-way feature audit; reference mockup | done |
| 1 | Unify the two rails into one `layout.tsx` component, `usePathname()` active state | blocked on §8 |
| 2 | Shared primitives — container, header, toolbar, sortable DataTable, ConfirmButton, empty states | |
| 3 | Overview — dashboard, documents, emails | |
| 4 | Templates incl. the 15-step training modal | |
| 5 | Companies incl. the PDF extraction flow and the field-registry section | |
| 6 | People, Knowledge, Users, Settings | |
| 7 | Verify against the compiled bundle; dark-mode pass if adopted | |

Sequenced **before or alongside** the UI work, because they are correctness not cosmetics:

| | Fix | Why now |
|---|---|---|
| A | Single source of role gating; add `/admin/people` | authorization hole |
| B | People backfill from `companies.directors` + extraction hook | consent forms are unfillable without it |
| C | Migration: `people.country_of_residence` | required field with no column |
| D | Provenance: `source`, `pdf_url`, the dead creator block | no audit trail |
| E | `custom_fields` type `[]` → `{}` | dynamic fields silently dead |
| F | Truncation warning event on the 8,000-char cap | silent data loss |

**Backfill shape.** `companies.directors[]` → `people` + `company_people(role='director')` carrying `date_of_appointment`. `members[]` where `type='Individual'` → `role='individual_shareholder'`. Corporate members → `shareholder_links`, never `people`. Dedupe on `nrc_passport` → `nrc_passport_no`, which matches the existing unique partial index. Field names differ across the boundary: JSONB uses `name`/`nrc_passport`, the table uses `full_name`/`nrc_passport_no`. `phone`, `email` and `residential_address` stay null — a backfilled person is still incomplete for document generation, by design.

Separate pre-existing feature work, not part of the revamp: repeating blocks, fill-in-context, the agenda-layout `.docx` bug.

---

## 11. Product gaps — flagged, not fixed

**No field-mapping editor.** Placeholder → column mapping is assigned at training step 5.5 and is read-only thereafter. A wrong mapping can only be corrected by a full retrain. No hand-remap path exists and no UI has been invented for one.

**No end-to-end run.** Nobody has driven a real document through the admin screens as a user. Everything here is read from source and from the database, not observed in use.

---

## 12. Operational notes

Branch flow is `feature/*` → `dev` → `staging` → `main`. Never push straight to `main`. A release means VERSION + CHANGELOG + tag.

**Secrets:** an OpenRouter key was pasted into chat in an earlier session and still needs rotating at `openrouter.ai/keys`. Put the new value straight into `.env` (gitignored) — never into a message, a commit, or a tracked file. All 22 prior revamp commits were audited: no `.env` and no secret files were committed. Compare env files by hash or key name only; never print values.
