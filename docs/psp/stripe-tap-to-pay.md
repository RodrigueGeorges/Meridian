# Stripe Tap to Pay — référence API

Source(s) : https://docs.stripe.com/api/terminal/connection_tokens/create · https://docs.stripe.com/terminal/payments/setup-integration · https://docs.stripe.com/terminal/payments/collect-card-payment · https://docs.stripe.com/api/idempotent_requests · consulté le 2026-11-27 · API v1

Module : `packages/modules/catalog/stripe-tap-to-pay.json` (version 0.1.0, `maturity: "preview"`)
Base URL : `https://api.stripe.com` (l.7)

Principe : le serveur crée le PaymentIntent et le ConnectionToken ; le `client_secret` du PI est remis à l'appareil qui effectue la collecte via le SDK Tap to Pay (iOS/Android). Le serveur ne parle jamais au lecteur — le statut se lit sur le PaymentIntent.

## Endpoints que nous utilisons

- `POST /v1/terminal/connection_tokens` (l.35, bloc `deviceToken`) : jeton de connexion SDK — corps `location={{config.locationId}}`, réponse `secret` (ex. `pst_…`) extraite par `pick`. Optionnel côté Stripe (sans `location`, le jeton vaut pour tous les lecteurs du compte ; la restriction par location ne s'applique qu'aux lecteurs connectés Internet).
- `POST /v1/payment_intents` (l.46) : `amount`, `currency`, `payment_method_types=["card_present"]`, `capture_method=automatic`, `metadata.meridian_ref`. Réponse utilisée : `id` → `intentId`, `client_secret` → `clientSecret` — tous deux déclarés dans `exposeVars` (l.29-32) pour remise à l'appareil.
- `GET /v1/payment_intents/{intentId}?expand[]=latest_charge` (l.69) : statut — mêmes champs que stripe-terminal.
- `POST /v1/payment_intents/{intentId}/cancel` (l.104) : annulation — `busyCodes: ["payment_intent_unexpected_state"]` (l.105-107).
- `POST /v1/refunds` (l.110) : `payment_intent` + `amount`.

## Authentification

`Authorization: Bearer {{config.secretKey}}` (l.22-24) — conforme. `encoding: form` (l.25).

## Idempotence

`Idempotency-Key` header (l.26-28), `{reference}:{stepId}` par le runtime. Même sémantique v1 que stripe-terminal : mémorisation du résultat après début d'exécution, purge ≥ 24 h. ✅

Note : `deviceToken` est appelé via `call()` sans clé (`runtime.ts` l.155) — non idempotent, mais un ConnectionToken est sans effet de bord financier (jeton éphémère à durée courte) : acceptable.

## Erreurs et statuts

- Format d'erreur `{error:{code,…}}` via `errorCodePath` par défaut `error.code`. ✅
- `intent.status` : `succeeded`/`requires_capture` → authorized, `canceled` → cancelled ; `requires_payment_method`/`processing`/etc. → pending. Pas de source `reader` (le device est le téléphone).
- `payment_intent_unexpected_state` : code API réel — émis quand le PI n'est plus annulable (déjà `processing` côté SDK, `succeeded`, ou `canceled`) → mappé `too_late` par `busyCodes`. ✅
- Le résultat final du paiement est posé sur le PI par le SDK : `succeeded` ou retour en `requires_payment_method` (échec de charge, `last_payment_error` renseigné). Notre règle `requires_payment_method → pending` couvre ce cas en attente.

## Divergences constatées

- ✅ `POST /v1/terminal/connection_tokens` + param `location` + `secret` — conforme à la référence API.
- ✅ Création du PI en `card_present` + remise de `client_secret` à l'appareil — conforme au flux documenté (create-then-collect côté SDK).
- ✅ Annulation par `POST /v1/payment_intents/{id}/cancel` et code `payment_intent_unexpected_state` — conforme.
- ✅ Remboursement `POST /v1/refunds {payment_intent, amount}` — conforme.
- ⚠️ `requires_capture → authorized` (l.83-90) : règle morte avec `capture_method=automatic` (idem stripe-terminal).
- ⚠️ Le SDK Tap to Pay requiert en pratique que l'intégration serveur fournisse aussi le `location` adapté et que le PI soit collecté dans un délai raisonnable ; un PI `requires_capture` manuel n'est pas géré (pas d'endpoint `/capture` dans le module) — à documenter côté intégrateur.
- ⚠️ `health` absent : pas de ping possible (il n'existe pas d'endpoint de santé Tap to Pay ; normal — la santé dépend du device, pas de Stripe).
- ⚠️ `lookup` absent : l'idempotence couvre les rejets d'étape ; la recherche par `metadata.meridian_ref` (POST /v1/payment_intents/search) existe chez Stripe mais n'est pas utilisée — la reprise repose sur `vars.intentId` persisté.

## Ce que la doc ne dit pas

- Durée de vie exacte du `client_secret` et délai au-delà duquel un PI non collecté devient inutilisable côté SDK (le PI expire côté API après ~24 h sans confirmation, non documenté précisément pour TTP).
- Comportement d'un `cancel` de PI pendant que le SDK a déjà présenté la carte (la race exacte entre `payment_intent_unexpected_state` et un `succeeded` tardif).
- Statuts intermédiaires renvoyés par le SDK au PI pendant la collecte (`processing` observable ?) — la règle pending par défaut le couvre.
