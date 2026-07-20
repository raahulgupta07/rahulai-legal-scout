-- Picker selections, held between the choose_* tool answering and the document
-- being generated.
--
-- The two steps are separate agent tool calls, so the chosen person has to
-- survive the gap without depending on the model remembering to pass it along.
-- document_signatories cannot carry this: it is keyed on a document row that
-- does not exist yet, and on people.id, which legacy companies.directors JSONB
-- entries do not have.

CREATE TABLE IF NOT EXISTS party_selections (
    id            SERIAL PRIMARY KEY,
    company_name  TEXT         NOT NULL,
    picker        VARCHAR(64)  NOT NULL,
    slot_kind     VARCHAR(64)  NOT NULL DEFAULT '',
    selection     JSONB        NOT NULL,
    created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

-- Lookups are always "the newest selection for this company and picker".
CREATE INDEX IF NOT EXISTS idx_party_selections_lookup
    ON party_selections (LOWER(company_name), picker, created_at DESC);
