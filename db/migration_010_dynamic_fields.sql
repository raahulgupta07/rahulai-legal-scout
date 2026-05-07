-- Migration 010: Dynamic custom fields per company + global field registry

ALTER TABLE companies
    ADD COLUMN IF NOT EXISTS custom_fields JSONB DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS company_field_registry (
    field_key TEXT PRIMARY KEY,
    label TEXT,
    description TEXT,
    field_type TEXT DEFAULT 'text',
    used_by_templates TEXT[] DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_companies_custom_fields_gin ON companies USING GIN (custom_fields);
