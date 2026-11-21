# Meridian

Connecteur de paiement universel pour caisses, bornes et kiosques. Un seul SDK côté caisse, un catalogue de solutions de paiement branchables, un moteur qui garantit **zéro double débit** (journal signé, idempotence par étape, reprise après crash, bascule). Européen dès le lancement : FR, BE, NL, DE, ES, IT (et AT, CH).

## Démarrer en local (5 minutes)

```bash
corepack enable && pnpm install
cp .env.example .env
pnpm sim            # simulateurs Stripe Terminal + PSP de secours (ports 12111, 12112)
pnpm api            # API + portail sur http://localhost:8080/portal/
```

Sans `DATABASE_URL`, l'API tourne en mémoire. Avec Docker : `docker compose up --build` (PostgreSQL inclus).
Clé de démo : `mk_test_demo0123456789abcdef`. Six points de vente de démo sont créés (`pos_demo_FR` … `pos_demo_IT`).

```bash
curl -X POST localhost:8080/v1/payments -H "authorization: Bearer mk_test_demo0123456789abcdef" \
  -H "content-type: application/json" \
  -d '{"posId":"pos_demo_FR","reference":"CMD-0412","amount":2450,"currency":"EUR","waitMs":8000}'
```

## Tests

54 tests (moteur, conformité, propriétés, API mémoire et PostgreSQL, passerelles, cluster). Les tests PostgreSQL et cluster tournent si `DATABASE_URL` est défini.

```bash
pnpm typecheck
pnpm test                         # unitaires, 8 scénarios de conformité, propriétés, E2E
DATABASE_URL=postgres://… pnpm test   # ajoute l'E2E PostgreSQL (journal append-only vérifié)
PROP_RUNS=1000 pnpm conformance   # 1 000 séquences de pannes aléatoires
STRIPE_KEY=sk_test_… COUNTRY=DE pnpm sandbox   # sandbox Stripe réelle, par pays
```

## Structure

| Chemin | Rôle |
| --- | --- |
| `packages/core` | Pays, devises ISO 4217 (unités mineures), moyens de paiement locaux, types |
| `packages/modules` | Interpréteur de modules JSON, schéma, catalogue (`catalog/*.json`) |
| `packages/engine` | Moteur (5 appels), journal chaîné SHA-256 + HMAC, reprise, bascule |
| `packages/store-pg` | PostgreSQL : journal append-only, points de vente, secrets chiffrés AES-256-GCM, migrations |
| `packages/bridges` | Passerelles caisse : Concert/Caisse-AP (TCP 8888), ZVT (TCP 20007), nexo Retailer JSON (`POST /v1/nexo`) |
| `packages/sdk-js` | SDK caisse : `pay`, `status`, `cancel`, `refund`, `receipt`, `waitForFinal` |
| `apps/api` | API REST + worker intégré + portail statique |
| `apps/sim` | Simulateurs PSP fidèles aux API, injection de pannes (`POST /__faults`) |
| `apps/portal` | Portail en 6 langues : catalogue par pays, points de vente, paiements, borne de démo |
| `conformance` | 8 scénarios de la spec + test de propriétés |
| `tools/sandbox-check` | Test contre la sandbox Stripe réelle, par pays |
| `infra`, `.github/workflows` | Docker, Fly.io (Paris), CI, sandbox nocturne, déploiement |

## Passerelles caisse existantes

Une caisse déjà intégrée en Concert (FR), ZVT (DE/AT/CH) ou nexo passe par Meridian sans changer une ligne :
- **Concert** : `CONCERT_PORT=8888`, `CONCERT_POS_MAP=01=pos_demo_FR` (n° de caisse → point de vente).
- **ZVT** : `ZVT_PORT=20007`, `ZVT_POS=pos_demo_DE` (un point de vente par port).
- **nexo** : `POST /v1/nexo` avec un `SaleToPOIRequest` (Payment, Reversal, TransactionStatus, Abort) ; `POIID` = point de vente.

Codes de réponse ZVT à confirmer avec la spécification VDT officielle avant certification.

## Multi-instance

Avec `DATABASE_URL`, plusieurs instances partagent la base :
- un paiement n'est piloté que par une instance (verrou consultatif PostgreSQL, libéré automatiquement si l'instance tombe) ;
- les autres lisent l'état dans le journal partagé, reçoivent les annulations, reprennent les paiements orphelins (scan toutes les `SCAN_MS`, 3000 par défaut) ;
- index unique sur la création : la même référence envoyée à deux instances donne un seul paiement ;
- journal chaîné sous verrou transactionnel ; webhooks en file persistante (`webhook_deliveries`, `FOR UPDATE SKIP LOCKED`, 12 essais avec délai exponentiel).

Testé par `apps/api/src/cluster.test.ts` (deux API, une base, arrêt d'une instance en plein paiement : un seul débit).

## Ajouter une solution de paiement

Écrire `packages/modules/catalog/<psp>.json` (voir `stripe-terminal.json`), l'ajouter à `BUILTIN_MODULES`, faire passer `conformance/` contre son simulateur puis sa sandbox. Aucun code dans le moteur. Un module sans `idempotency` ni `lookup` est refusé.

## Règles non négociables

- L'IA n'est jamais dans le chemin d'un paiement.
- Journal écrit et durable avant tout appel au PSP.
- Erreur réseau = « en cours », jamais « échec » sans issue connue.
- Bascule de PSP uniquement sur connexion refusée **avant** tout envoi.
- Aucun numéro de carte complet ni fonds ; aucune clé live dans le dépôt.

Spécification complète : doc « Meridian — Spécification de build pour Devin ». Écarts assumés du MVP : `docs/adr/001-mvp.md`.
