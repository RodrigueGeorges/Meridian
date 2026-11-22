# Mise en ligne : les 4 actions qui demandent vos accès

Tout le reste est fait et testé (54 tests, dont 2 instances sur une même base).

## 1. GitHub
```bash
cd meridian-repo && git init -b main && git add . && git commit -m "Meridian MVP"
gh repo create meridian --private --source . --push
```
La CI (`ci.yml`) lance alors typecheck, tests sur PostgreSQL et gitleaks.

## 2. Secret sandbox Stripe
Settings → Secrets → Actions → `STRIPE_TEST_KEY` = une clé **sk_test** neuve (régénérez celle collée dans le chat).
Puis Actions → « Sandbox Stripe » → Run : un rapport par pays (FR, BE, NL, DE, ES, IT).
En local : `STRIPE_TEST_KEY=sk_test_… COUNTRY=FR pnpm sandbox`.

## 3. Fly.io (Paris)
```bash
fly auth login
fly launch --config infra/fly/sim.toml --no-deploy && fly deploy --config infra/fly/sim.toml
fly launch --config infra/fly/api.toml --no-deploy
fly secrets set --config infra/fly/api.toml DATABASE_URL=… JOURNAL_KEY=$(openssl rand -hex 32) MASTER_KEY=$(openssl rand -hex 32) BOOTSTRAP_API_KEY=mk_test_$(openssl rand -hex 16)
fly deploy --config infra/fly/api.toml && fly scale count 2 --config infra/fly/api.toml
```
Base : voir `infra/postgres-eu.md` (Neon/Supabase/Scaleway en région UE). Pour la CI : secret `FLY_API_TOKEN`.

## 4. Image Docker
`docker compose up --build` en local (API 8080, Concert 8888, ZVT 20007, portail sur `/portal/`).
Les étapes de l'image ont été rejouées sans Docker : installation figée OK, démarrage OK.

## Variables du site public (ajoutées en semaine 1 de l'audit)

| Variable | Rôle | Valeur en production |
| --- | --- | --- |
| `TRUST_PROXY` | Lit l'IP client derrière le proxy Fly (limites de débit par visiteur) | `true` (déjà dans `infra/fly/api.toml`) |
| `PUBLIC_URL` | URL absolue du site pour canonical, hreflang, Open Graph, robots.txt et sitemap | `https://<domaine>` |
| `CONTACT_RETENTION_DAYS` | Conservation des demandes de contact, purge automatique horaire | `1095` (3 ans, valeur par défaut) |

Avant la mise en ligne : compléter les champs surlignés de `mentions-legales.html`, `legal-notice.html`, `confidentialite.html` et `privacy.html` (société, siège, RCS, directeur de la publication, adresse de l'hébergeur, mécanisme de transfert Fly.io, contact données personnelles).
