# Mollie Point-of-sale — référence API

Source(s) : https://docs.mollie.com/reference/create-payment · https://docs.mollie.com/reference/extra-payment-parameters · https://docs.mollie.com/reference/get-payment · https://docs.mollie.com/reference/cancel-payment · https://docs.mollie.com/docs/integrating-mollie-terminals · https://docs.mollie.com/docs/handling-payment-status · https://docs.mollie.com/reference/status-reasons · https://docs.mollie.com/reference/api-idempotency · consulté le 2026-11-27 · API v2

Module : `packages/modules/catalog/mollie-pos.json` (version 0.1.0, `maturity: "preview"`)
Base URL : `https://api.mollie.com` (l.7)

## Endpoints que nous utilisons

- `POST /v2/payments` (l.21) : `amount { currency, value: "10.00" }` (chaîne en unités majeures), `description`, `method: "pointofsale"`, `terminalId` (paramètre spécifique au point de vente, identifiant `term_…`), `metadata.meridian_ref`. Réponse : `id` (`tr_…`) → `paymentId`.
- `GET /v2/payments/{paymentId}` (l.34) : statut — `status` ∈ `open` | `pending` | `authorized` | `paid` | `canceled` | `expired` | `failed`.
- `DELETE /v2/payments/{paymentId}` (l.42) : annulation — possible tant que `isCancelable` (422 sinon). `busyCodes: ["Unprocessable Entity"]`.
- `POST /v2/payments/{paymentId}/refunds` (l.45) : `amount { currency, value }` — remboursement partiel possible.

## Authentification

`Authorization: Bearer {{config.apiKey}}` (l.12) — conforme (clé `live_…`/`test_…`; OAuth `payments.write` accepté en alternative). JSON. `errorCodePath: "title"` (l.14) — les erreurs Mollie portent `title` (ex. `"Unprocessable Entity"` pour 422) + `detail`.

## Idempotence

`Idempotency-Key` header (l.15) — supporté par l'API Mollie depuis décembre 2022 : deux requêtes avec la même clé → la seconde est traitée comme un doublon ignoré. Clé émise par le runtime sous la forme `{reference}:{stepId}` / `{reference}:refund:{n}`. ✅

- Fenêtre de rétention de la clé : la doc parle d'une « timeframe » spécifique sans donner la durée exacte.
- La doc indique qu'en l'absence d'idempotence, rejouer une création de paiement POS produit simplement deux paiements (pas de dedup implicite) — notre clé couvre ce risque. ✅

## Erreurs et statuts

- `status` : `paid` → authorized (l.36) ; `canceled` → cancelled (l.37) ; `failed` → declined, détail `p.details.failureReason` (l.38) ; `expired` → declined (l.39) ; `open`/`pending`/`authorized` → pending par défaut. ✅
- Détail d'échec POS : la doc « Status reasons » précise que l'objet **`statusReason` { code, message }** est le canal documenté *pour les paiements Point-of-Sale* (codes ex. `terminal_busy`, `terminal_unreachable`, `refer_to_card_issuer`, refus schemes). `details.failureReason` est documenté pour les paiements **carte en ligne**.
- `cancel` : 200 (payment annulé) / 404 / **422** (plus annulable) / 429. Le 422 renvoie `title: "Unprocessable Entity"` → mappé `too_late` via `busyCodes`. ✅ plausible.
- Expiration : un paiement `open` finit par passer `expired` — durée variable par méthode (POS : non listée dans le tableau public).

## Divergences constatées

- ✅ `POST /v2/payments` + `method=pointofsale` + `terminalId` — conforme (paramètre listé dans « Method-specific parameters »).
- ✅ `GET /v2/payments/{id}` + statuts — conforme.
- ✅ `DELETE /v2/payments/{id}` + `POST /v2/payments/{id}/refunds` — conformes.
- ✅ `Idempotency-Key` — support documenté.
- ❌ **Reçu — mauvais chemin de champ** (l.48) : le module lit `p.cardDetails.cardLabel` / `p.cardDetails.cardNumber`. La structure documentée du Payment est `details.cardLabel` / `details.cardNumber` (et `details.cardMaskedNumber` pour le PAN masqué complet). `cardDetails` n'existe pas dans le schéma v2 → **brand et maskedPan seront toujours vides** sur les reçus. Correctif probable : `p.details.cardLabel` / `p.details.cardNumber` (last4) ou `p.details.cardMaskedNumber`.
- ⚠️ `detailPath: p.details.failureReason` (l.38) : pour un paiement POS, le canal de détail documenté est `statusReason.code`/`statusReason.message` ; `details.failureReason` est spécifié pour les cartes e-commerce et risque de rester vide en POS → préférer `p.statusReason.code` (ou `.message`).
- ⚠️ `busyCodes: ["Unprocessable Entity"]` (l.42) : repose sur `errorCodePath: "title"`. Le `title` 422 exact est conforme au format Mollie (`"Unprocessable Entity"`), mais c'est une chaîne *humaine* susceptible de changer ; la doc expose aussi `status`/`type`. À valider en sandbox.
- ⚠️ `status == "authorized"` non traité : reste pending (cohérent — ce statut n'apparaît que si la méthode supporte les captures ; le POS standard capte directement en `paid`).

## Ce que la doc ne dit pas

- Durée de rétention exacte des `Idempotency-Key` (fenêtre non chiffrée dans la doc publique).
- Délai d'expiration d'un paiement `pointofsale` `open` (absent du tableau d'expiry par méthode) — probablement calé sur le timeout du terminal.
- Si `details.*` carte est rempli aussi en `pointofsale` (brand/last4 sur reçu) — la sandbox devra confirmer quels champs `details` sont renseignés pour la méthode POS.
- Comportement exact d'un second `DELETE` sur un paiement déjà `canceled` (404 vs 200 idempotent).
