-- Migration 011: People Register, company links, per-document signatories

CREATE TABLE IF NOT EXISTS people (
    id SERIAL PRIMARY KEY,
    full_name VARCHAR(500) NOT NULL,
    nationality VARCHAR(100),
    nrc_passport_no VARCHAR(100),
    gender VARCHAR(20),
    date_of_birth DATE,
    phone VARCHAR(50),
    email VARCHAR(255),
    residential_address TEXT,
    created_by_email VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_people_name ON people(full_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_people_nrc ON people(nrc_passport_no)
    WHERE nrc_passport_no IS NOT NULL AND nrc_passport_no <> '';

CREATE TABLE IF NOT EXISTS company_people (
    id SERIAL PRIMARY KEY,
    company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
    person_id INTEGER REFERENCES people(id) ON DELETE CASCADE,
    role VARCHAR(30) NOT NULL DEFAULT 'director',
    number_of_shares VARCHAR(100),
    capital_amount VARCHAR(100),
    share_class VARCHAR(100),
    appointed_date DATE,
    resigned_date DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_company_people_company ON company_people(company_id);
CREATE INDEX IF NOT EXISTS idx_company_people_person ON company_people(person_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_company_people_uniq ON company_people(company_id, person_id, role);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_company_people_role') THEN
        ALTER TABLE company_people ADD CONSTRAINT chk_company_people_role
            CHECK (role IN ('director', 'individual_shareholder', 'both'));
    END IF;
END $$;

-- Per-document chosen parties. A signatory is either an individual (person_id)
-- or a corporate entity (corporate_company_id) signing through a representative.
CREATE TABLE IF NOT EXISTS document_signatories (
    id SERIAL PRIMARY KEY,
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
    slot VARCHAR(100) NOT NULL,
    position INTEGER DEFAULT 1,
    party_type VARCHAR(20) NOT NULL DEFAULT 'individual',
    person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
    corporate_company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
    representative_person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_document_signatories_doc ON document_signatories(document_id);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_document_signatories_party') THEN
        ALTER TABLE document_signatories ADD CONSTRAINT chk_document_signatories_party
            CHECK (party_type IN ('individual', 'corporate'));
    END IF;
END $$;

-- Shareholder entity discriminator. Existing rows default to individual.
ALTER TABLE companies
    ADD COLUMN IF NOT EXISTS shareholder_links JSONB DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_companies_shareholder_links_gin
    ON companies USING GIN (shareholder_links);

-- Template grouping, so new-company setup shows only its own five templates.
ALTER TABLE templates
    ADD COLUMN IF NOT EXISTS template_group VARCHAR(60);

CREATE INDEX IF NOT EXISTS idx_templates_group ON templates(template_group);

UPDATE templates SET template_group = 'new_company_setup'
WHERE template_group IS NULL AND (
    name ILIKE '%Director Consent Form%Group Member Appointment%'
    OR name ILIKE '%Director Consent Form%Non-Group Member Appointment%'
    OR name ILIKE '%Individual Shareholder Consent Form%'
    OR name ILIKE '%Corporate Shareholder Consent%'
    OR name ILIKE '%Individual Shareholder and director Consent%'
);

-- Migration 009 declared these TEXT but its ADD COLUMN IF NOT EXISTS was a no-op,
-- because migration 005 had already created them as DATE. Free-form values such as
-- "31 March" cannot be cast to DATE, so convert for real.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'companies'
          AND column_name = 'financial_year_end_date'
          AND data_type = 'date'
    ) THEN
        ALTER TABLE companies
            ALTER COLUMN financial_year_end_date TYPE TEXT
            USING financial_year_end_date::TEXT;
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'companies'
          AND column_name = 'next_financial_year_end_date'
          AND data_type = 'date'
    ) THEN
        ALTER TABLE companies
            ALTER COLUMN next_financial_year_end_date TYPE TEXT
            USING next_financial_year_end_date::TEXT;
    END IF;
END $$;

DROP TRIGGER IF EXISTS trg_people_updated_at ON people;
CREATE TRIGGER trg_people_updated_at BEFORE UPDATE ON people
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_company_people_updated_at ON company_people;
CREATE TRIGGER trg_company_people_updated_at BEFORE UPDATE ON company_people
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
