-- Page de statut publique : issues agrégées par module et par heure. Aucun montant, marchand ni point de vente.
CREATE TABLE IF NOT EXISTS psp_status_hourly (
  module_id text NOT NULL,
  hour timestamptz NOT NULL,
  ok integer NOT NULL DEFAULT 0,
  ko integer NOT NULL DEFAULT 0,
  ms_sum bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (module_id, hour)
);
