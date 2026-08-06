-- Migration 016 — father's name on the People register
--
-- Myanmar legal drafting names a person against their father: "U Aung Kyaw,
-- son of U Tin Maung". Consent forms and resolutions carry it, so the register
-- has to hold it.
--
-- It is NOT in the DICA company extract — checked against the real filings,
-- which contain no "Father", "son of" or "F/N" field anywhere. So this is a
-- hand-entered field and the company→people sync will never populate it.

ALTER TABLE people ADD COLUMN IF NOT EXISTS father_name VARCHAR(500);
