-- Migration 013: Legal Skills engine (Anthropic Agent-Skills pattern)
-- L1 metadata (name + description) injected into the agent prompt on startup,
-- L2 body loaded on demand via the load_skill(name) tool.

CREATE TABLE IF NOT EXISTS legal_skills (
    id SERIAL PRIMARY KEY,
    name VARCHAR(64) UNIQUE NOT NULL,
    description TEXT NOT NULL,
    body TEXT NOT NULL,
    version VARCHAR(16) NOT NULL DEFAULT '1.0.0',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    source VARCHAR(16) NOT NULL DEFAULT 'manual',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
