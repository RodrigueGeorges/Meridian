-- Limites de débit partagées entre instances (démo publique, formulaire de contact).
-- La clé est une empreinte HMAC de l'adresse IP, jamais l'adresse en clair ; purgée après 24 h.
CREATE TABLE IF NOT EXISTS rate_hits (
  bucket  text NOT NULL,
  key     text NOT NULL,
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rate_hits_lookup ON rate_hits (bucket, key, at);
CREATE INDEX IF NOT EXISTS contact_requests_created ON contact_requests (created_at);
