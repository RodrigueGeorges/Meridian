-- Rétention du journal d'audit : DELETE autorisé uniquement sur les lignes de plus de 370 jours
-- (PCI DSS exige 1 an de conservation ; exporter au-delà si besoin). UPDATE toujours interdit.
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.at < now() - interval '370 days' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;
