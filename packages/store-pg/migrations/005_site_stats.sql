-- Mesure d'audience du site public : uniquement des compteurs agrégés par jour (aucun identifiant, aucune IP).
CREATE TABLE IF NOT EXISTS site_stats (
  day    date NOT NULL,
  path   text NOT NULL,
  event  text NOT NULL,
  lang   text NOT NULL DEFAULT '',
  ref    text NOT NULL DEFAULT '',
  n      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, path, event, lang, ref)
);
