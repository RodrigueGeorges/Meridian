-- Meridian : schéma initial. Journal append-only, points de vente multi-pays, clés API hachées.

CREATE TABLE IF NOT EXISTS organizations (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('editor', 'reseller', 'psp', 'admin')),
  webhook_url text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id         text PRIMARY KEY,
  org_id     text NOT NULL REFERENCES organizations(id),
  prefix     text NOT NULL,
  hash       text NOT NULL UNIQUE,
  mode       text NOT NULL CHECK (mode IN ('test', 'live')),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS pos (
  id              text PRIMARY KEY,
  org_id          text NOT NULL REFERENCES organizations(id),
  label           text NOT NULL,
  country         char(2) NOT NULL,
  currency        char(3) NOT NULL,
  locale          text NOT NULL,
  timezone        text NOT NULL,
  primary_module  text,
  fallback_module text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pos_module_config (
  pos_id           text NOT NULL REFERENCES pos(id) ON DELETE CASCADE,
  module_id        text NOT NULL,
  config_encrypted bytea NOT NULL,
  key_version      int NOT NULL DEFAULT 1,
  base_url         text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pos_id, module_id)
);

CREATE TABLE IF NOT EXISTS journal (
  seq        bigint PRIMARY KEY,
  ts         timestamptz NOT NULL,
  pos_id     text NOT NULL,
  reference  text NOT NULL,
  type       text NOT NULL,
  data       jsonb NOT NULL,
  prev       char(64) NOT NULL,
  hash       char(64) NOT NULL UNIQUE,
  sig        char(64) NOT NULL
);
CREATE INDEX IF NOT EXISTS journal_ref_idx ON journal (pos_id, reference);

-- Append-only : toute modification ou suppression du journal est refusée.
CREATE OR REPLACE FUNCTION journal_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'journal is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS journal_no_update ON journal;
CREATE TRIGGER journal_no_update BEFORE UPDATE OR DELETE ON journal
  FOR EACH ROW EXECUTE FUNCTION journal_append_only();

CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
