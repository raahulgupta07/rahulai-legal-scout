-- Migration 021 — correct tool names inside legal_skills bodies
--
-- A skill body is an instruction sheet the model reads at L2 (load_skill). When
-- a body says "call `preview_document`" and no tool by that name is registered,
-- nothing raises: the model follows the instruction, finds no such tool, and the
-- step simply does not happen. No error, no log, no failed run — the document is
-- produced without the review step the skill exists to enforce.
--
-- This is the third time the same defect has shipped in this codebase. It was in
-- the system prompt (`generate_dica_extract`, `list_companies`,
-- `preview_document`), it was in scout/knowledge/routing/intents.json
-- (`generate_document_tool`, which reaches the prompt as DATA and so is
-- invisible to any source search), and it is here. The prompt path is now
-- guarded — _build_tool_inventory() renders the list from the live registry and
-- startup RAISES on a mismatch. Skill bodies are NOT covered by that audit:
-- they live in this table, they are editable from the admin UI, and nothing
-- checks the tool names inside them.
--
-- Measured 2026-08-06 against the live registry (scout/agent.py:_tools_to_add):
--
--   preview_document       6 occurrences, in agm-meeting-chain,
--                          board-minutes-style, director-appointment,
--                          director-resignation, director-resolutions,
--                          new-company-setup.
--                          The export-dict key in smart_doc is
--                          "preview_document", but the underlying function is
--                          `def preview_doc` and _as_json uses @wraps — so the
--                          name agno registers is preview_doc. The dict key is
--                          not the tool name.
--
--   list_tracked_documents 1 occurrence, in document-review-tabular.
--                          scout/agent.py does
--                            list_tracked_documents = document_tracker["list_documents"]
--                          The Python variable name is invisible to agno, which
--                          reads __name__ — so the tool is list_documents.
--
-- Every other tool named in a seeded body is registered under exactly that name:
-- get_company, get_directors, get_shareholders, find_matching_templates,
-- prepare_document, generate_document, lookup_director_candidates,
-- choose_director, quick_info, load_skill. The `description` column (L1, injected
-- into the system prompt) names no tools at all and is left alone.
--
-- WHY regexp_replace AND NOT replace():
--   preview_doc is a PREFIX of preview_document. A plain replace() is safe in
--   THIS direction (once preview_document is gone there is nothing left to
--   match, so a second run is a no-op) but it is not safe against neighbouring
--   text: a body that later grows a preview_documents or preview_document_url
--   would be silently corrupted into preview_docs / preview_doc_url. \m and \M
--   are Postgres word-boundary constraints, and underscore counts as a word
--   character, so only the standalone token is rewritten.
--
-- IDEMPOTENT: each statement's WHERE clause is the same pattern it rewrites, so
-- a second run matches zero rows and touches no updated_at. Migration 014 seeds
-- with ON CONFLICT (name) DO NOTHING, so a re-seed cannot reintroduce the old
-- text either.
--
-- VERSION IS DELIBERATELY NOT BUMPED. Migration 014 seeds every skill at '1.0.0';
-- migration 018 edits seeded data but its table has no version column; and
-- PUT /api/skills/{name} only writes version when the caller explicitly supplies
-- one — it never auto-bumps on a body edit. There is no existing convention to
-- follow, and inventing a '1.0.1' here would put a number in the admin UI that
-- diverges from every hand-edit made through the API. updated_at IS set, because
-- that is what the update endpoint does on every body change.

UPDATE legal_skills
SET body = regexp_replace(body, '\mpreview_document\M', 'preview_doc', 'g'),
    updated_at = now()
WHERE body ~ '\mpreview_document\M';

UPDATE legal_skills
SET body = regexp_replace(body, '\mlist_tracked_documents\M', 'list_documents', 'g'),
    updated_at = now()
WHERE body ~ '\mlist_tracked_documents\M';


-- Verification — run by hand; expects ZERO rows.
--
-- Left commented rather than live: the migration runner (db/migrate.py) calls
-- cur.execute(sql) and never fetches, so a trailing SELECT would run and have
-- its result discarded. RAISE NOTICE was considered and rejected for the same
-- reason — psycopg routes server notices to the `psycopg` logger, which has no
-- handler configured in the entrypoint, so the check would report into nowhere.
-- A verification that cannot be seen is the bug this migration is fixing.
--
--   SELECT name,
--          (body ~ '\mpreview_document\M')       AS has_preview_document,
--          (body ~ '\mlist_tracked_documents\M') AS has_list_tracked_documents
--   FROM legal_skills
--   WHERE body ~ '\mpreview_document\M'
--      OR body ~ '\mlist_tracked_documents\M';
--
-- Broader sweep — every snake_case token a body names, to diff against the live
-- registry after any skill edit. This table has no equivalent of the startup
-- audit that guards the system prompt, so it is a manual step for now:
--
--   SELECT DISTINCT name, m[1] AS token
--   FROM legal_skills, regexp_matches(body, '`([a-z][a-z0-9_]*_[a-z0-9_]+)`', 'g') AS m
--   ORDER BY token, name;
