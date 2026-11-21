-- Multi-instance : une seule création par (point de vente, référence), même en cas de course entre instances.
CREATE UNIQUE INDEX IF NOT EXISTS journal_created_unique ON journal (pos_id, reference) WHERE type = 'created';
CREATE INDEX IF NOT EXISTS journal_type_idx ON journal (type, pos_id, reference);

-- Webhooks persistants : rejoués après redémarrage, quelle que soit l'instance.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id          text PRIMARY KEY,
  org_id      text NOT NULL,
  url         text NOT NULL,
  event       text NOT NULL,
  payload     jsonb NOT NULL,
  attempts    int NOT NULL DEFAULT 0,
  next_at     timestamptz NOT NULL DEFAULT now(),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_pending_idx ON webhook_deliveries (status, next_at);
