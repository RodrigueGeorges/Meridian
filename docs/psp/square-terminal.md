# Square Terminal API — référence API

Source(s) : https://developer.squareup.com/reference/square/terminal-api/create-terminal-checkout · https://developer.squareup.com/reference/square/objects/TerminalCheckout · https://developer.squareup.com/reference/square/terminal-api/cancel-terminal-checkout · https://developer.squareup.com/docs/build-basics/common-api-patterns/idempotency · consulté le 2026-11-27 · API version courante 2026-11-18 (module épinglé `Square-Version: 2025-10-16`, l.13)

Module : `packages/modules/catalog/square-terminal.json` (version 0.1.0, `maturity: "preview"`)
Base URL : `https://connect.squareup.com` (l.7)

## Endpoints que nous utilisons

- `POST /v2/terminals/checkouts` (l.22) : `idempotency_key` (requis, 1–64 car.) + `checkout` { `amount_money { amount (minor units, entier), currency }`, `reference_id`, `device_options { device_id }` }. Réponse : `checkout.id` → `checkoutId`. Statut initial typique `PENDING`.
- `GET /v2/terminals/checkouts/{checkoutId}` (l.36) : statut — `checkout.status` ∈ `PENDING` | `IN_PROGRESS` | `CANCEL_REQUESTED` | `CANCELED` | `COMPLETED` ; `cancel_reason` (présent si `CANCELED`) ; `payment_ids[]` (paiements créés).
- `POST /v2/terminals/checkouts/{checkoutId}/cancel` (l.42) : demande d'annulation (passe le checkout en `CANCEL_REQUESTED` puis `CANCELED` si le Terminal n'a pas déjà encaissé).
- `POST /v2/refunds` (l.45, Refunds API globale) : `idempotency_key`, `payment_id` (lu via `receipt.paymentId` = `checkout.payment_ids[0]`), `amount_money`.

## Authentification

`Authorization: Bearer {{config.accessToken}}` (l.12) — jeton OAuth du marchand, scope `PAYMENTS_WRITE`. En-tête fixe `Square-Version: 2025-10-16` (l.13) — format daté conforme (la version courante observée est 2026-11-18 ; l'épinglage est légitime). `errorCodePath: "errors.0.code"` (l.15) — correspond au format d'erreur Square `{ "errors": [ { "code", "category", "detail" } ] }`. ✅

## Idempotence

`idempotency: { inBody: true }` (l.16) : pas d'en-tête — la clé est le champ `idempotency_key` du corps, obligatoire pour `CreateTerminalCheckout` et `RefundPayment`.

- `checkout`: `idempotency_key = {{tx.reference}}` — un rejeu de la même référence renvoie le même checkout (dedup côté Square). ✅
- `refund`: `idempotency_key = {{tx.reference}}-refund-{{refund.number}}` — dédup par remboursement n° n. ✅
- Contrainte documentée : clé unique par requête, **max 64 caractères**.
- Rétention de la clé : non chiffrée publiquement (Square documente le mécanisme, pas la fenêtre).

## Erreurs et statuts

- Règles (l.37-40) : `COMPLETED` → authorized ; `CANCELED` → cancelled (détail `checkout.cancel_reason`, valeurs ex. `BUYER_CANCELED`, `SELLER_CANCELED`, `TIMED_OUT`) ; `PENDING`/`IN_PROGRESS`/`CANCEL_REQUESTED` → pending. ✅
- `deadline_duration` : par défaut 5 min — un checkout `PENDING` non récupéré devient `CANCELED` avec `cancel_reason: TIMED_OUT`. Le module n'envoie pas de deadline explicite → le défaut s'applique (le champ est déprécié dans les versions récentes, remplacé par un délai géré côté device).
- Refus : un paiement décliné sur le terminal produit un `checkout` `COMPLETED` dont le `payment_ids[]` peut contenir un paiement `FAILED` — ⚠️ la doc ne garantit pas qu'un échec carte ⇒ `CANCELED`.
- `busyCodes: []` (l.42) : pas de code occupé déclaré — un `cancel` sur checkout `COMPLETED` échoue en 400 (`errors[].code`) qui remonte comme erreur, pas `too_late`.

## Divergences constatées

- ✅ `POST /v2/terminals/checkouts` — corps conforme champ pour champ à l'exemple officiel (`idempotency_key`, `amount_money`, `reference_id`, `device_options.device_id`).
- ✅ `GET` + enum de statut + `cancel_reason` + `payment_ids` — conforme à l'objet `TerminalCheckout`.
- ✅ `POST …/cancel` — endpoint documenté.
- ✅ `POST /v2/refunds {idempotency_key, payment_id, amount_money}` — endpoint Refunds documenté (remboursement partiel accepté par montant inférieur).
- ✅ `errors.0.code` — chemin d'erreur conforme.
- ⚠️ **`idempotency_key` ≤ 64 caractères** : `{{tx.reference}}` vient de l'appelant ; une référence > 64 car. ferait échouer la création avec 400 — à borner en amont (le format `bridgeRef` reste ≪ 64, référence marchande externe à vérifier).
- ⚠️ **Échec carte ≠ `CANCELED`** : si le client présente une carte refusée, Square peut terminer le checkout en `COMPLETED` avec un payment `FAILED` (ou redemander la carte selon config). Notre règle `COMPLETED → authorized` pourrait alors marquer authorized un paiement refusé — à confirmer en sandbox : le statut du `payment_ids[0]` n'est pas relu. **Risque le plus sérieux du module.**
- ⚠️ Remboursement via `/v2/refunds` (API Refunds) — correct pour un paiement encaissé ; il existe aussi la Terminal Refund API (`/v2/terminals/refunds`) orientée device, non nécessaire ici mais à connaître.
- ⚠️ `device_id` : provient des Devices API (`POST /v2/devices/codes` + appairage) — le module le prend en config ; aucune vérification que le terminal appartient à la `location_id` du checkout (Square la déduit ; un device_id d'une autre location échoue).

## Ce que la doc ne dit pas

- Comportement précis de `checkout.status` quand la carte est refusée (vs le statut du `Payment` sous-jacent) — à trancher en sandbox ; détermine si `COMPLETED` suffit à conclure `authorized`.
- Fenêtre de rétention des `idempotency_key`.
- Ordre/atomicité entre `cancel` et la fin du tender sur l'appareil (`CANCEL_REQUESTED` observable, résultat final via poll ou webhook `terminal.checkout.updated`).
