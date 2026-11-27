# SumUp Solo (Cloud API) — référence API

Source(s) : https://developer.sumup.com/api/readers/create-checkout/ · https://developer.sumup.com/api/readers/terminate-checkout/ · https://developer.sumup.com/api/transactions/get/ · https://developer.sumup.com/api/transactions/refund/ · https://developer.sumup.com/terminal-payments/cloud-api/ · consulté le 2026-11-27 · API v0.1 (readers) / v2.1 (transactions) / v1.0 (refunds)

Module : `packages/modules/catalog/sumup-solo.json` (version 0.1.0, `maturity: "preview"`)
Base URL : `https://api.sumup.com` (l.7)
Prérequis device : Solo firmware ≥ 3.3.24.3 (checkout) et ≥ 3.3.28.0 (terminate).

## Endpoints que nous utilisons

- `POST /v0.1/merchants/{merchantCode}/readers/{readerId}/checkout` (l.28) : `total_amount { currency, value (entier, minor units), minor_unit }`, `description`, `affiliate { app_id, key, foreign_transaction_id={{tx.reference}} }`. Accepté si le lecteur est en ligne ; le système a **60 s** pour démarrer le paiement (un autre checkout sur le même lecteur est rejeté pendant ce délai). Réponse 202 = checkout accepté, **pas** résultat.
- `GET /v2.1/merchants/{merchantCode}/transactions?foreign_transaction_id={reference}` (l.20, l.38) : lookup + statut — transaction unique identifiée par `foreign_transaction_id`. Champs utilisés : `id` → `transactionId`, `status`, `card.type`, `card.last_4_digits`.
- `POST /v0.1/merchants/{merchantCode}/readers/{readerId}/terminate` (l.45) : arrêt du checkout en cours — asynchrone, n'aboutit que si le device attend une action porteur (carte, PIN) ; **aucune confirmation**. Un checkout terminé arrive `failed` sur `return_url` si fournie (nous ne la fournissons pas).
- `POST /v0.1/me/refund/{transactionId}` (l.48) : `amount` — **endpoint legacy**.

## Authentification

`Authorization: Bearer {{config.apiKey}}` (l.15) — conforme (docs : `apiKey` ou OAuth2 avec scopes `readers.write` / `transactions.read` / `payments` / `refunds.write`). JSON. `errorCodePath: "error_code"` (l.17).

## Idempotence

Pas d'en-tête d'idempotence côté SumUp. La protection repose sur :

1. `affiliate.foreign_transaction_id = {{tx.reference}}` posé à la création ;
2. `lookup` (l.18-22) : GET transactions `?foreign_transaction_id=` avant tout rejeu — 404 ou absence ⇒ jamais reçu, rejeu possible. ✅ mécanisme correct (le lookup par `foreign_transaction_id` est documenté).

Limite : pas de fenêtre de dedup atomique côté création — deux POST checkout quasi simultanés peuvent créer deux demandes ; seul le rejet « un autre checkout en cours (60 s) » protège partiellement.

## Erreurs et statuts

- `transaction.status` : `SUCCESSFUL` → authorized (l.40) ; `CANCELLED` → cancelled (l.41) ; `FAILED` → declined (l.42) ; autres (`PENDING`, …) → pending.
- HTTP : checkout → 202 accepté, 400 params invalides, 404 lecteur introuvable, 422 device hors-ligne/occupé. Terminate → 202 dispatched, 404, 422. Transactions GET → 200, 404 (inconnu → lookup renvoie null via `runtime.ts` l.107). ✅
- Format d'erreur : problem+json `{type,title,status,detail}` ou `{errors:[{type,detail}]}` sur les endpoints readers.

## Divergences constatées

- ✅ `POST …/readers/{id}/checkout` — endpoint, paramètres `total_amount{currency,value}`, `description`, `affiliate{app_id,key}` conformes ; la doc exige `app_id` **et** `key` ensemble (notre config impose les deux ✓).
- ✅ `POST …/terminate` — endpoint et sémantique (202, sans confirmation) conformes.
- ✅ `GET /v2.1/merchants/{mc}/transactions?foreign_transaction_id=` — endpoint documenté, ressource unique.
- ❌ **Remboursement — endpoint obsolète + unité douteuse** (l.47-49) : le module appelle `POST /v0.1/me/refund/{txn_id}` avec `amount` en **unités majeures** (`{{refund.amountMajor}}`). La doc courante publie `POST /v1.0/merchants/{merchant_code}/payments/{transaction_id}/refunds` avec `amount` en **unités mineures** (entier, ex. `500` = 5,00 €) — l'ancien `/v0.1/me/refund` n'est plus dans la référence. Si la redirection actuelle est appliquée : endpoint absent + montant 100× trop petit. À corriger vers l'endpoint v1.0 + `{{refund.amount}}` minor units.
- ⚠️ `total_amount.minor_unit: 2` (l.30) : le schéma documenté n'expose que `currency` + `value` — `minor_unit` n'est pas documenté (ignoré tolérant ou rejet 400 ; à valider en sandbox ; le `value` étant déjà en minor units, le champ est probablement inutile).
- ⚠️ `errorCodePath: "error_code"` (l.17) : les schémas d'erreur publiés (problem+json `{type,title,status,detail}` ou `{errors[].type}`) n'ont pas de champ `error_code` → `busyCodes`/`retryErrors` ne pourront jamais matcher un code. `busyCodes: []` actuel → inerte, mais le chemin est à corriger (p. ex. `errors.0.type`) si besoin.
- ⚠️ `status` lookup renvoie `null` seulement sur 404 HTTP ou `pick` vide — le `pick` lit `id` au premier niveau ✓ conforme à `TransactionFull`.
- ⚠️ `card.type`/`card.last_4_digits` (reçu) : champs présents dans la ressource transaction historique ; la doc `TransactionFull` liste `id`, `transaction_code`, `foreign_transaction_id`, … sans détailler `card.*` dans l'extrait public — à confirmer.
- ⚠️ Pas de `return_url` : on poll le statut — acceptable, mais entre « checkout accepté » et l'apparition de la transaction il y a un trou temporel où le GET 404 (lookup null) ; le statut de polling retombe sur pending car le `status` appelle le même GET — vérifier que le runtime tolère le 404 en `status.sources` (un 404 lève `RemoteError`, pas une réponse vide → **le statut peut échouer au lieu d'être pending** — à valider).

## Ce que la doc ne dit pas

- Si `/v0.1/me/refund/{id}` est encore servi (rétrocompat legacy non documentée).
- Si `total_amount.minor_unit` est accepté en v0.1 readers.
- Valeurs exactes possibles de `transaction.status` pour un flux lecteur (SUCCESSFUL/FAILED/CANCELLED/PENDING attendus — l'énum complet n'est pas publié dans l'extrait).
- Délai entre le 202 du checkout et la visibilité de la transaction par `foreign_transaction_id`.
- Si le terminate échoue quand le device traite déjà la carte (la doc : « no confirmation » → notre `cancel` peut renvoyer `sent` sans effet).
