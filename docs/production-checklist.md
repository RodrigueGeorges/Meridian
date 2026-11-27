# Checklist de mise en production Meridian

Ce qui est fait dans le code (lots 1 et 2) et ce qui reste à faire avec des accès externes.
ADR des choix : `docs/adr/002-production-readiness.md`.

## Mise en ligne en une commande

```bash
fly auth login            # une fois (flyctl : https://fly.io/docs/flyctl/install/)
./tools/go-live.sh        # app + PostgreSQL géré + secrets + déploiement + test de fumée
```

Le script est idempotent, provisionne un Managed Postgres `Basic` à Paris (sauvegardes incluses),
génère `JOURNAL_KEY`, `MASTER_KEY`, `BOOTSTRAP_API_KEY` (`mk_live_` aléatoire) dans `.secrets-prod.txt`
(chmod 600 — à ranger dans un coffre puis supprimer) et finit par `fly scale count 2`.
Variables : `APP`, `REGION`, `DB_NAME`, `DB_PLAN`, `SCALE`, `PUBLIC_URL`, `DATABASE_URL` (base externe,
connexion directe uniquement), `SKIP_DB=1`.

## Déjà fait (code)

- Gardes d'ajout atomiques : création par référence unique, verrou transactionnel sur le journal,
  remboursements pré-journalisés plafonnés au montant payé, verrous de cluster par paiement.
- Garde pooler : `DATABASE_URL` en mode transaction (`-pooler`, port 6543, `pgbouncer=true`) refusée
  sauf `DATABASE_POOLED_OK=true` (verrous consultatifs de session).
- Refus de démarrer sans `DATABASE_URL` sauf `DEMO_SEED`, `JOURNAL_FILE`, `NODE_ENV=test` ou
  `ALLOW_EPHEMERAL=true` ; `DEMO_SEED` + clé `mk_live_` refusé ; `ALLOW_TEST_BASE_URL` + clé live refusé.
- Rotation des clés : `JOURNAL_KEY_ID`/`JOURNAL_KEYS_PREVIOUS`, `MASTER_KEY_VERSION`/`MASTER_KEYS_PREVIOUS`,
  `pnpm rotate-secrets`.
- Journal d'audit append-only (UPDATE/DELETE interdits sous 370 jours, purge horaire au-delà ;
  PCI DSS = 1 an minimum).
- Passerelles TCP bornées : 64 Ko de trame, 200 connexions simultanées, inactivité 2 min, liées
  sur 127.0.0.1 par défaut (jamais exposées sur Internet).
- Limites de débit : API authentifiée 120/min/IP + 300/min/org, rapprochement 6/min/IP,
  échecs d'authentification 60/min/IP (429 avant la recherche de clé), relais edge 30/min/IP.
- Webhooks : URL par organisation (`PUT /v1/org/webhook`), https + hôte public requis hors mode test,
  file persistante sans verrou de ligne pendant l'appel HTTP.
- XML nexo durci : `processEntities: false`, DOCTYPE refusé, `fast-xml-parser` épinglé (5.12.1).
- Agent edge : jeton d'API locale obligatoire (généré + persisté 0600 si absent), remplacement
  d'agent tracé (`agent_replaced`).
- Observabilité : `/health` public, `GET /v1/ops` authentifié, log de boot structuré.
- CI : actions épinglées par SHA, `pnpm conformance` (PROP_RUNS=200), audit des deps prod, gitleaks.
- Déploiement : `infra/fly/api.prod.toml` (déclenché manuellement, environnement `production`),
  Dockerfile à deps de production uniquement, `kill_timeout=30s` pour le drain.

## À faire avec vos accès

Les points 1 à 3 sont couverts par `./tools/go-live.sh` ; le reste reste manuel.

1. **PostgreSQL managée UE** : `fly mpg create` (le script) ou base externe — région Paris + réplique + PITR (voir `infra/postgres-eu.md`).
   Connexion **directe** obligatoire (pas de pooler en mode transaction : les verrous consultatifs
   de session l'exigent) — port direct 5432, hôte sans `-pooler`.
2. **Secrets Fly** : `fly secrets set --config infra/fly/api.prod.toml DATABASE_URL=… JOURNAL_KEY=$(openssl rand -hex 32) MASTER_KEY=$(openssl rand -hex 32) BOOTSTRAP_API_KEY=mk_live_$(openssl rand -hex 16) PUBLIC_URL=https://<domaine>`.
   Noter `JOURNAL_KEY_ID` et `MASTER_KEY_VERSION` courants pour les futures rotations.
3. **PUBLIC_URL** : domaine définitif en https (sinon les URL absolues du site suivent l'en-tête Host).
4. **Pages légales** : compléter les `[[…]]` restants dans `apps/portal/content/` (hébergeur, DPF, base de données et e-mails déjà remplis — il ne manque que les champs de la société) :
   `legal.fr.html`, `legal.en.html`, `privacy.fr.html`, `privacy.en.html`, `security.fr.html`,
   `security.en.html` (et `developers.fr/en.html`, `stripe.fr/en.html` qui contiennent aussi des
   placeholders de validation).
5. **Sandbox Stripe par pays** : secret `STRIPE_TEST_KEY` (sk_test) dans GitHub, lancer le workflow
   « sandbox-stripe » (FR, BE, NL, DE, ES, IT) et archiver les rapports.
6. **Codes ZVT** : confirmer les codes de réponse avec la spécification VDT officielle avant
   certification (voir commentaire en tête de `packages/bridges/src/zvt.ts`).
7. **DPA Fly.io** : signer le Data Processing Agreement (données traitées en région cdg).
8. **DNS / domaine** : zone DNS + certificat `fly certs create <domaine>` sur l'app `meridian-api`,
   puis Search Console (sitemap.xml déjà servi).
9. **Test de restauration** : restaurer une sauvegarde PITR dans un environnement jetable et vérifier
   le journal (`GET /v1/journal/verify`).
10. **Test du relais edge en prod** : un agent réel connecté, `GET /v1/edge/agents` non vide,
    paiement de bout en bout sur le TPE du magasin.
11. **Supervision** : uptime externe sur `/health`, alerte sur les logs `payment_stuck` et
    `GET /v1/ops` (`stuck`, `db`).
12. **Export audit** : mettre en place l'export `audit_log` avant la purge à 370 jours si une
    conservation plus longue est exigée.
