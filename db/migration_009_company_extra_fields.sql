-- Migration 009: Add user-input fields to companies table
-- These don't come from DICA — manual entry. Used by templates (auditor, FY end).

ALTER TABLE companies
    ADD COLUMN IF NOT EXISTS financial_year_end_date TEXT,
    ADD COLUMN IF NOT EXISTS next_financial_year_end_date TEXT,
    ADD COLUMN IF NOT EXISTS auditor_name TEXT,
    ADD COLUMN IF NOT EXISTS auditor_fee TEXT;
