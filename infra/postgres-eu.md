# Base de données UE

- Production : PostgreSQL 16 managé en UE, région principale Paris (`cdg`), réplique synchrone Francfort (`fra`) pour le journal (perte de données nulle), reprise < 5 min.
- Options : Fly Postgres (`fly postgres create --region cdg` puis réplique `fra`), Neon (région `aws-eu-central-1`) ou Scaleway Managed Database (Paris + réplique).
- Migrations : `pnpm migrate` (appliquées aussi au démarrage de l'API).
- Le journal est append-only (trigger `journal_append_only`) : aucun rôle applicatif n'a besoin de `UPDATE`/`DELETE` dessus.
- Sauvegardes : PITR activé, rétention 30 jours minimum ; rétention du journal à définir avec l'avocat (preuve d'encaissement).
