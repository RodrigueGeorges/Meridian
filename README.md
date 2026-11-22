# Meridian

Connecteur de paiement universel pour caisses, bornes et kiosques. Un seul SDK côté caisse, un catalogue de solutions de paiement branchables, un moteur qui garantit **zéro double débit** (journal signé, idempotence par étape, reprise après crash, bascule). Européen dès le lancement : FR, BE, NL, DE, ES, IT (et AT, CH).

## Démarrer en local (5 minutes)

```bash
corepack enable && pnpm install
cp .env.example .env
pnpm sim            # simulateurs Stripe Terminal + PSP de secours (ports 12111, 12112)
pnpm api            # API + site sur http://localhost:8080/ (console : /portal/console.html)
```

Sans `DATABASE_URL`, l'API tourne en mémoire. Avec Docker : `docker compose up --build` (PostgreSQL inclus).
Clé de démo : `mk_test_demo0123456789abcdef`. Six points de vente de démo sont créés (`pos_demo_FR` … `pos_demo_IT`).

```bash
curl -X POST localhost:8080/v1/payments -H "authorization: Bearer mk_test_demo0123456789abcdef" \
  -H "content-type: application/json" \
  -d '{"posId":"pos_demo_FR","reference":"CMD-0412","amount":2450,"currency":"EUR","waitMs":8000}'
```

## Démo pour rendez-vous

```bash
pnpm demo                       # tout en mémoire : simulateurs, API, site, passerelles Concert (8888) et ZVT (20007)
pnpm caisse 24.50               # une caisse Concert envoie sa trame habituelle à Meridian
pnpm caisse 112.45 --panne      # idem avec une coupure réseau de 2,5 s en plein paiement : accepté, 1 débit
```

## Tests

Tests : moteur, conformité Stripe, module Adyen et Tap to Pay contre imitation de leur API, propriétés, API mémoire et PostgreSQL, rapprochement, statut public, MCP, passerelles, cluster). Les tests PostgreSQL et cluster tournent si `DATABASE_URL` est défini.

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
| `packages/bridges` | Passerelles caisse : Concert/Caisse-AP (TCP 8888 : débit, remboursement, annulation), ZVT (TCP 20007 : Registration, Authorization, Reversal, Refund, Abort, End-of-Day, Log-Off, Status Enquiry, Diagnosis), nexo Retailer JSON et XML (`POST /v1/nexo` : Login, Logout, Payment, Reversal, TransactionStatus, Abort, Reconciliation) |
| `packages/terminals` | Pilotes de TPE côté caisse : Caisse-AP sur IP, ZVT, nexo ; service terminal idempotent écrit sur disque ; TPE simulés |
| `apps/edge` | Agent du magasin : API locale identique à l'API cloud (127.0.0.1:8787) et relais cloud par connexion sortante (`/v1/edge/connect`) |
| `packages/mcp` | Serveur MCP pour assistants de code : lecture du catalogue, des points de vente, de leur PSP et du journal ; paiement de test (clé `mk_test_` uniquement) ; ni annulation ni remboursement |
| `packages/sdk-js` | SDK caisse : `pay`, `status`, `cancel`, `refund`, `receipt`, `waitForFinal` |
| `apps/api` | API REST + worker intégré + portail statique |
| `apps/sim` | Simulateurs PSP fidèles aux API, injection de pannes (`POST /__faults`) |
| `apps/portal` | Site public : `build.ts` génère au démarrage 24 pages pré-rendues (4 pages × 6 langues, URL localisées, hreflang) et 22 pages FR/EN (`content/` : sécurité, développeurs, contact, protocoles, Stripe Terminal, statut des PSP, accessibilité, mentions légales, confidentialité), `/llms.txt` ; gabarit `public/index.html` ; console `/portal/console.html` (vue d'ensemble, paiements et journal, rapprochement avec export CSV, PSP de chaque caisse, catalogue, borne de démo) |
| `conformance` | 8 scénarios de la spec + test de propriétés |
| `tools/sandbox-check` | Test contre la sandbox Stripe réelle, par pays |
| `infra`, `.github/workflows` | Docker, Fly.io (Paris), CI, sandbox nocturne, déploiement |

## Démo publique

`POST /v1/demo/run` (mode démo uniquement, 12 essais par minute et par IP) lance un vrai paiement sur le moteur et injecte une vraie panne dans le simulateur PSP : `nominal`, `network`, `lost_response`, `declined`. La réponse contient le journal, le nombre de débits mesuré côté PSP et la vérification de la chaîne. Hors ligne, le site rejoue une exécution réelle enregistrée (`demo-recorded.json`).

## Passerelles caisse existantes

Une caisse déjà intégrée en Concert (FR), ZVT (DE/AT/CH) ou nexo passe par Meridian sans changer une ligne :
- **Concert** : `CONCERT_PORT=8888`, `CONCERT_POS_MAP=01=pos_demo_FR` (n° de caisse → point de vente).
- **ZVT** : `ZVT_PORT=20007`, `ZVT_POS=pos_demo_DE` (un point de vente par port).
- **nexo** : `POST /v1/nexo` avec un `SaleToPOIRequest` en JSON ou en XML (`content-type: application/xml`, réponse XML) : Login, Logout, Payment, Reversal, TransactionStatus, Abort, Reconciliation ; `POIID` = point de vente.
- **Italie** : pas de passerelle ECR17 / Protocollo 17 à ce jour ; les caisses italiennes passent par nexo ou le SDK.

Codes de réponse ZVT à confirmer avec la spécification VDT officielle avant certification.

## Journal d'audit

Les actions d'administration (création de point de vente, changement de PSP, annulation, remboursement, échec d'authentification) sont tracées dans `audit_log`, en ajout seul, sans aucun secret ni identifiant PSP. Lecture : `GET /v1/audit`.

## Multi-instance

Avec `DATABASE_URL`, plusieurs instances partagent la base :
- un paiement n'est piloté que par une instance (verrou consultatif PostgreSQL, libéré automatiquement si l'instance tombe) ;
- les autres lisent l'état dans le journal partagé, reçoivent les annulations, reprennent les paiements orphelins (scan toutes les `SCAN_MS`, 3000 par défaut) ;
- index unique sur la création : la même référence envoyée à deux instances donne un seul paiement ;
- journal chaîné sous verrou transactionnel ; webhooks en file persistante (`webhook_deliveries`, `FOR UPDATE SKIP LOCKED`, 12 essais avec délai exponentiel).

Testé par `apps/api/src/cluster.test.ts` (deux API, une base, arrêt d'une instance en plein paiement : un seul débit).

## Ajouter une solution de paiement

Écrire `packages/modules/catalog/<psp>.json` (voir `stripe-terminal.json`), l'ajouter à `BUILTIN_MODULES`, faire passer `conformance/` contre son simulateur puis sa sandbox. Aucun code dans le moteur. Un module sans `idempotency` ni `lookup` est refusé. Sans clé d'idempotence, le moteur appelle `lookup` avant tout renvoi d'une étape incertaine (`notFound` décrit la réponse « inconnu »).

Un module nouveau porte `"maturity": "preview"` tant qu'il n'a pas passé les scénarios contre la sandbox réelle du PSP : il reste utilisable en mode test seulement et n'apparaît pas sur la page de statut publique. C'est le cas d'`adyen-terminal` (API Terminal, format nexo) et de `stripe-tap-to-pay` (encaissement sur l'appareil, secret client remis à la caisse dans `device`, jeton SDK par `POST /v1/pos/{id}/device-token`).

## Tous les branchements

| Mode | Chemin | État |
| --- | --- | --- |
| PSP dans le cloud | Caisse → API Meridian → API du PSP | Stripe disponible ; Adyen en aperçu |
| TPE du magasin, en local | Caisse installée → agent (127.0.0.1:8787) → TPE | Pilotes testés sur TPE simulés ; validation sur matériel à faire |
| TPE du magasin, caisse en ligne | Caisse SaaS → API Meridian → relais → agent → TPE | Idem |
| Caisse existante | Trame Concert, ZVT ou nexo → passerelle Meridian → PSP | Démonstration |
| Tap to Pay | App → SDK du PSP, suivi par Meridian | Aperçu |

Démo : `pnpm demo`, puis `pnpm tpe 24.50 --local` ou `pnpm tpe 24.50 --cloud`. Agent réel : `pnpm edge` (variables dans `apps/edge/src/main.ts`).

Le relais cloud tient les connexions des agents en mémoire de l'instance : en multi-instance, les agents doivent joindre l'instance qui reçoit les paiements de leur organisation (à traiter avant la mise à l'échelle).

## PSP de la caisse, statut, rapprochement

Meridian est un connecteur et un catalogue, pas un orchestrateur : le PSP de chaque caisse est celui choisi dans le catalogue (`PUT /v1/pos/{id}/psp`), avec un PSP de secours facultatif utilisé seulement si le premier est injoignable avant tout envoi. Meridian ne choisit jamais le PSP paiement par paiement.

- `GET /v1/status` (public) : taux de réponse et délai moyen par PSP, agrégés par heure (migration 008), sans volume, rien sous 20 paiements. Page `/fr/statut/`.
- `POST /v1/reconcile` : redemande au PSP l'état de chaque paiement terminé et signale tout débit sans « autorisé » au journal, ou l'inverse.

## Règles non négociables

- L'IA n'est jamais dans le chemin d'un paiement.
- Journal écrit et durable avant tout appel au PSP.
- Erreur réseau = « en cours », jamais « échec » sans issue connue.
- Bascule de PSP uniquement sur connexion refusée **avant** tout envoi.
- Aucun numéro de carte complet ni fonds ; aucune clé live dans le dépôt.

Spécification complète : doc « Meridian — Spécification de build pour Devin ». Écarts assumés du MVP : `docs/adr/001-mvp.md`.
