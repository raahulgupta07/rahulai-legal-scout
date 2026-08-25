-- Migration 029: Tag new-company-setup templates AT INSERT, not once at deploy
-- ===========================================================================
--
-- WHY THIS EXISTS
-- ---------------
-- Migration 011 already tags the setup templates:
--
--     UPDATE templates SET template_group = 'new_company_setup'
--     WHERE template_group IS NULL AND (name ILIKE '%Director Consent Form%' ...)
--
-- and on this tree it tagged NOTHING. A migration runs once, against the rows
-- that exist at that moment. When 011 ran, `templates` was empty — the register
-- had been wiped and the 15 `.docx` were re-uploaded afterwards, through the
-- admin Upload page. The UPDATE matched zero rows, and every template that
-- arrived later carried template_group = NULL.
--
-- MEASURED CONSEQUENCE (2026-08-24)
-- ---------------------------------
-- All 15 templates had a NULL group, so `get_templates_by_group` returned []
-- and `list_new_company_setup_templates` took its empty branch on every call.
-- Asked "What documents are required to set up a company?", the agent had no
-- list to answer from and answered from its own legal knowledge instead —
-- naming documents like "Group Director Consent Form" that do not exist in the
-- register. The user copies that name back, it does not resolve, the run dies.
-- Tagging the four templates by hand fixed it; nothing carried that fix into a
-- fresh install, which is what this migration is for.
--
-- WHY A TRIGGER AND NOT ANOTHER UPDATE
-- ------------------------------------
-- Another one-shot UPDATE would fix THIS database and reproduce the same bug on
-- the next install that uploads its templates after migrating — which is the
-- normal order, because templates arrive through the UI. Two code paths insert
-- into this table today (template_analyzer.save_template_knowledge:254 and
-- scripts/sync_templates.py:27) and neither sets the group. A trigger covers
-- both, plus any future path and any hand-written INSERT.
--
-- INSERT ONLY, deliberately. Admin → Registers → Templates has a Setup toggle
-- that clears the tag by writing NULL (app/main.py:2502 → set_template_group).
-- A BEFORE UPDATE trigger would put the tag straight back and the toggle would
-- look broken. An explicit human decision outranks the name rule.

CREATE OR REPLACE FUNCTION tag_new_company_setup_template()
RETURNS TRIGGER AS $$
BEGIN
    -- Only ever fills a hole. An INSERT that names its own group keeps it.
    IF NEW.template_group IS NULL AND (
           NEW.name ILIKE '%Director Consent Form%Group Member Appointment%'
        OR NEW.name ILIKE '%Director Consent Form%Non-Group Member Appointment%'
        OR NEW.name ILIKE '%Individual Shareholder Consent Form%'
        OR NEW.name ILIKE '%Corporate Shareholder Consent%'
        -- The combined director+shareholder consent the client's test tracker
        -- marks "(new template)". Not in the register and not in their OneDrive
        -- master folder as of 2026-08-24, so this pattern matches nothing today.
        -- It is here so the tag is automatic on the day they upload it, rather
        -- than depending on someone remembering the Setup toggle.
        OR NEW.name ILIKE '%Shareholder%director%Consent%'
        OR NEW.name ILIKE '%director%Shareholder%Consent%'
    ) THEN
        NEW.template_group := 'new_company_setup';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tag_new_company_setup ON templates;

CREATE TRIGGER trg_tag_new_company_setup
    BEFORE INSERT ON templates
    FOR EACH ROW
    EXECUTE FUNCTION tag_new_company_setup_template();

-- Backfill whatever is already here. Idempotent: NULL-guarded, so it cannot
-- overwrite a group an admin chose, and re-running changes nothing.
UPDATE templates SET template_group = 'new_company_setup'
WHERE template_group IS NULL AND (
       name ILIKE '%Director Consent Form%Group Member Appointment%'
    OR name ILIKE '%Director Consent Form%Non-Group Member Appointment%'
    OR name ILIKE '%Individual Shareholder Consent Form%'
    OR name ILIKE '%Corporate Shareholder Consent%'
    OR name ILIKE '%Shareholder%director%Consent%'
    OR name ILIKE '%director%Shareholder%Consent%'
);


-- ---------------------------------------------------------------------------
-- REVERSING DDL (commented — run by hand to roll this migration back, and
-- delete the matching row from schema_migrations afterwards)
-- ---------------------------------------------------------------------------
-- DROP TRIGGER IF EXISTS trg_tag_new_company_setup ON templates;
-- DROP FUNCTION IF EXISTS tag_new_company_setup_template();
-- DELETE FROM schema_migrations WHERE filename = 'migration_029_template_group_on_insert.sql';
