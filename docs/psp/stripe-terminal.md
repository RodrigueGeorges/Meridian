# Stripe Terminal (server-driven) — référence API

Source(s) : https://docs.stripe.com/api/terminal/readers/process_payment_intent · https://docs.stripe.com/api/terminal/readers/cancel_action · https://docs.stripe.com/api/payment_intents · https://docs.stripe.com/api/idempotent_requests · https://docs.stripe.com/terminal/payments/collect-card-payment · consulté le 2026-11-27 · API v1 (Stripe-Version courante observée : 2026-11-18.endive)

Module : `packages/modules/catalog/stripe-terminal.json` (version 1.0.0, maturity implicite `available`)
Base URL : `https://api.stripe.com` (module ligne 6)

## Endpoints que nous utilisons

- `POST /v1/payment_intents` (l.19) : création du PaymentIntent — `amount` (minor units), `currency` (minuscules, Stripe accepte la casse quelconque ISO 4217), `payment_method_types=["card_present"]`, `capture_method=automatic`, `metadata.meridian_ref`. Réponse utilisée : `id` → `vars.intentId`.
- `POST /v1/terminal/readers/{readerId}/process_payment_intent` (l.32) : remise du PI au lecteur — corps `payment_intent={id}`. Réponse : Reader avec `action.status` (`in_progress` → `succeeded`/`failed`). `retryErrors: ["terminal_reader_timeout"]`.
- `GET /v1/payment_intents/{intentId}?expand[]=latest_charge` (l.40) : statut — `status` ∈ `succeeded`, `requires_capture`, `canceled`, … + `latest_charge.payment_method_details.card_present.{brand,last4}` pour le reçu.
- `GET /v1/terminal/readers/{readerId}` (l.41, l.72) : statut lecteur + health — `action.status`, `action.failure_code`, `status` (online/offline).
- `POST /v1/terminal/readers/{readerId}/cancel_action` (l.63) : annulation de l'action en cours. `busyCodes: ["terminal_reader_busy"]`.
- `POST /v1/payment_intents/{intentId}/cancel` (l.66) : cleanup du PI resté non traité.
- `POST /v1/refunds` (l.69) : remboursement — `payment_intent` + `amount` (minor units). Remboursement partiel possible par montant inférieur.

## Authentification

`Authorization: Bearer {{config.secretKey}}` (l.11) — conforme (clé secrète `sk_…` ou restricted key `rk_…`). Corps encodé `application/x-www-form-urlencoded` (`"encoding": "form"`, l.12) — conforme à l'API v1.

## Idempotence

En-tête `Idempotency-Key` (l.13), envoyé par le runtime sous la forme `{reference}:{stepId}` pour les étapes de paiement et `{reference}:refund:{n}` pour les remboursements (`runtime.ts` l.90, l.144).

- Clé ≤ 255 caractères, générée par le client. ✅
- API v1 : le résultat (code + body) est sauvegardé après le **début** d'exécution du endpoint ; les clés sont purgées après **au moins 24 h**. Les requêtes rejetées en validation ou en conflit concurrent ne sont pas mémorisées et peuvent être rejouées. ✅
- La comparaison des paramètres entre rejets identiques produit une erreur (`idempotency_error`) si le corps diffère — notre clé inclut `stepId`, donc un corps différent n'arrive que sur changement de config. ✅

## Erreurs et statuts

- Erreurs API : corps `{ "error": { "type", "code", "message", … } }`. Le module n'a pas de `errorCodePath` explicite → défaut `error.code` (`schema.ts` l.34) ✅ correspond au format Stripe.
- Codes d'API documentés pertinents : `terminal_reader_timeout` (lecteur ne répond pas → retriable), `terminal_reader_busy` (action déjà en cours → `cancel` renvoie `too_late`), `terminal_reader_offline`, `payment_intent_unexpected_state`. ✅ confirmés dans l'énum des codes Stripe.
- `intent.status` : `requires_payment_method`, `requires_confirmation`, `requires_action`, `processing`, `requires_capture`, `canceled`, `succeeded`. Règles du module : `succeeded`/`requires_capture` → authorized, `canceled` → cancelled ; tout le reste → pending.
- `reader.action.status` : `in_progress`, `succeeded`, `failed`. En échec, `failure_code` + `failure_message` ; depuis le firmware lecteur 2.42+, un objet `action.api_error` (type/card_error, code, decline_code, doc_url) précise les échecs d'origine API (ex. `card_declined`) ; les échecs d'origine lecteur (annulation client) ont `api_error: null`.

## Divergences constatées

- ✅ `POST /v1/payment_intents` + champs (`card_present`, `capture_method`, `metadata`) — conforme.
- ✅ `POST /v1/terminal/readers/{id}/process_payment_intent` — URL et paramètre conformes à la doc.
- ✅ `cancel_action`, `payment_intents/{id}/cancel`, `refunds {payment_intent, amount}` — conformes.
- ✅ `GET` avec `expand[]=latest_charge` — syntaxe d'expansion conforme ; `card_present.brand`/`last4` existent dans `payment_method_details`.
- ✅ Idempotency-Key header + sémantique v1 — conforme.
- ⚠️ `reader.action.failure_code == "customer_canceled"` (l.49) : la valeur littérale n'est **pas énumérée** dans la doc publique (Stripe ne publie pas la liste des `failure_code` d'action). La doc confirme seulement qu'une annulation client = échec d'origine lecteur avec `api_error: null`. À valider en sandbox (candidats possibles : `customer_canceled`, `canceled`, …). Si la valeur diffère, un abandon client tombera dans la règle générique `failed → declined` au lieu de `cancelled`.
- ⚠️ `requires_capture → authorized` (l.45) : cohérent sémantiquement mais inatteignable avec `capture_method=automatic` envoyé à la création (l.24). Règle morte, sans effet ; un passage futur à `manual` exigerait en plus un appel `POST /v1/payment_intents/{id}/capture` qui n'existe pas dans le module.
- ⚠️ La doc recommande de piloter les échecs via `action.api_error.code`/`decline_code` (firmware ≥ 2.42) ; notre `detailPath` ne lit que `failure_code` — information plus pauvre mais correcte.

## Ce que la doc ne dit pas

- Liste exhaustive des `action.failure_code` (dont le code exact d'annulation par le client) — à trancher en sandbox/simulateur.
- Délai typique de transition `in_progress → succeeded` et timeout exact du `process_payment_intent` (le code `terminal_reader_timeout` existe, pas la durée officielle côté cloud).
- Comportement de `process_payment_intent` rappelé avec la même clé d'idempotence alors que le lecteur est `busy` — ordre de préséance entre l'erreur busy et la re-soumission idempotente.
