-- Demandes de contact du site public (éditeurs et PSP).
CREATE TABLE IF NOT EXISTS contact_requests (
  id          text PRIMARY KEY,
  role        text NOT NULL CHECK (role IN ('software', 'psp', 'other')),
  name        text NOT NULL,
  company     text NOT NULL,
  email       text NOT NULL,
  country     text,
  message     text,
  lang        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
