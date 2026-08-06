-- Migration 015 — extra identity fields on the People register
--
-- business_occupation: DICA already publishes it for every director, but the
--   register had nowhere to put it, so the company→people sync was discarding
--   it. Adding the column makes the register lossless against the filing.
--
-- country_of_residence: not in the DICA extract, entered by hand. Consent forms
--   distinguish resident from non-resident directors, so it needs its own field
--   rather than being buried in the residential address.

ALTER TABLE people ADD COLUMN IF NOT EXISTS business_occupation VARCHAR(255);
ALTER TABLE people ADD COLUMN IF NOT EXISTS country_of_residence VARCHAR(100);
