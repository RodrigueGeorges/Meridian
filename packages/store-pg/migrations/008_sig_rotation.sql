-- Rotation des clés de signature : la signature peut être préfixée par l'identifiant de clé (« kid:hex »).
ALTER TABLE journal ALTER COLUMN sig TYPE text;
