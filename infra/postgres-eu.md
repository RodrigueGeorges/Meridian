# Base de données UE

- Production : PostgreSQL 16 managé en UE, région principale Paris (`cdg`), réplique synchrone Francfort (`fra`) pour le journal (perte de données nulle), reprise < 5 min.
- Options : Fly Postgres (`fly postgres create --region cdg` puis réplique `fra`), Neon (région `aws-eu-central-1`) ou Scaleway Managed Database (Paris + réplique).
- Migrations : `pnpm migrate` (appliquées aussi au démarrage de l'API).
- Le journal est append-only (trigger `journal_append_only`) : aucun rôle applicatif n'a besoin de `UPDATE`/`DELETE` dessus.
- Sauvegardes : PITR activé, rétention 30 jours minimum ; rétention du journal à définir avec l'avocat (preuve d'encaissement).

> **Connexion directe requise.** Pas de pooler en mode transaction : les verrous consultatifs de
> session (`pg_advisory_lock`, pilote unique par paiement, migrations) n'y survivent pas — ils sont
> rendus à chaque transaction. Utiliser le port direct `5432` et l'hôte **sans** suffixe `-pooler`.
> Le démarrage refuse les URL de pooler (`-pooler`, port `6543`, `pgbouncer=true`) sauf
> `DATABASE_POOLED_OK=true` — à n'utiliser qu'en connaissance de cause.
