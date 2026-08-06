-- Remove Indian legal citations from a Myanmar corporate-law product.
--
-- Measured 2026-08-06: all 15 rows in `templates` carried legal_references drawn
-- from Indian company law —
--
--   ["Companies Act 2013 - Section 152", "SEBI (LODR) Regulations 2015"]
--   ["Companies Act 2013 - Section 189",
--    "Companies (Management and Administration) Rules 2014"]
--   ["Companies Act 2013"]
--
-- The Companies Act 2013 is India's; SEBI is India's securities regulator and
-- has no jurisdiction in Myanmar. This product drafts under the Myanmar
-- Companies Law 2017 and files with DICA.
--
-- The strings did not come from the model. They were hardcoded in
-- app/main.py:_get_legal_refs_from_name(), chosen by substring match on the
-- template filename, and used whenever the AI analysis step fell back — which,
-- given every row matches the hardcoded values exactly, was every time. That
-- function now returns an empty list and logs the failure instead.
--
-- These rows are cleared rather than corrected. The correct citations come from
-- the deep-training legal step, which prompts for Myanmar Companies Law sections
-- and DICA filing obligations; writing section numbers by hand here would repeat
-- the original mistake in a form that is harder to notice. An empty citation
-- list reads as incomplete. A confident wrong one does not.
--
-- Re-run template training to repopulate. Anything it proposes is a draft for
-- the firm's lawyers to confirm, not an authority.

UPDATE templates
SET legal_references = '[]'::jsonb
WHERE legal_references IS NOT NULL
  AND (
    legal_references::text ILIKE '%Companies Act 2013%'
    OR legal_references::text ILIKE '%Companies Act, 2013%'
    OR legal_references::text ILIKE '%SEBI%'
  );

-- "DIN Application" is an Indian Director Identification Number filing. Myanmar
-- records directors with DICA.
UPDATE templates
SET related_documents = replace(
        related_documents::text,
        '"DIN Application"',
        '"DICA Director Particulars Filing"'
    )::jsonb
WHERE related_documents IS NOT NULL
  AND related_documents::text LIKE '%DIN Application%';
