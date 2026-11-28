-- Chaînes de journal par point de vente : chaque POS a sa chaîne (prev = entrée précédente
-- du même POS), ce qui lève la sérialisation globale des écritures (le verrou advisory passe
-- de 7426001 global à hashtext('journal:'||pos_id)). seq devient un compteur par POS.
-- Note : les chaînes globales écrites avant cette migration ne vérifient plus par verify()
-- (prev croiserait un autre POS) — acceptable : le journal de production était vide.

ALTER TABLE journal DROP CONSTRAINT journal_pkey;
ALTER TABLE journal ADD PRIMARY KEY (pos_id, seq);

-- Un « dernier de la chaîne » efficace par POS.
CREATE INDEX IF NOT EXISTS journal_pos_seq_idx ON journal (pos_id, seq DESC);
