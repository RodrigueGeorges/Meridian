-- Journal d'audit des actions d'administration (PCI DSS exigence 10) : en ajout seul, conservé 1 an minimum.
-- Jamais de secret ni d'identifiant PSP en clair : uniquement l'action, la cible, le préfixe de clé et une empreinte d'IP.
CREATE TABLE IF NOT EXISTS audit_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  org_id      text,
  action      text NOT NULL,
  target      text,
  key_prefix  text,
  ip_hash     text,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS audit_log_org_at ON audit_log (org_id, at DESC);
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
