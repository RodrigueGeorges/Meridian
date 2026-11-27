# Références PSP — docs/psp/

Vérification des modules/passerelles Meridian contre la documentation officielle de chaque solution de paiement. Un fichier par connecteur : endpoints utilisés, auth, idempotence, erreurs, divergences constatées, points à trancher en sandbox.

Consultation des sources : 2026-11-27. Règle : sources officielles uniquement ; « ⚠️ » = écart probable ou non confirmé par la doc publique ; « ❌ » = écart constaté avec la doc.

## Tableau récapitulatif

| Connecteur | Module / passerelle | Maturité | Doc officielle | Divergences |
|---|---|---|---|---|
| Stripe Terminal (server-driven) | `packages/modules/catalog/stripe-terminal.json` | available | ✅ docs.stripe.com API v1 | ⚠️ `failure_code:"customer_canceled"` littéral non documenté ; règle `requires_capture` morte |
| Stripe Tap to Pay | `catalog/stripe-tap-to-pay.json` | preview | ✅ docs.stripe.com | ⚠️ règle `requires_capture` morte ; pas de recherche par metadata |
| Adyen Terminal API | `catalog/adyen-terminal.json` | preview | ✅ docs.adyen.com | ⚠️ endpoints `terminal-api` legacy (Adyen recommande `device-api`) ; abort→`Aborted` mappé `declined` au lieu de `cancelled` ; timeout HTTP 8 s vs 150 s cloud |
| Mollie Point-of-sale | `catalog/mollie-pos.json` | preview | ✅ docs.mollie.com v2 | ❌ reçu `cardDetails.*` au lieu de `details.*` (brand/PAN vides) ; ⚠️ détail échec : `statusReason` est le canal POS documenté |
| Square Terminal | `catalog/square-terminal.json` | preview | ✅ developer.squareup.com | ⚠️ `COMPLETED` peut cacher un payment `FAILED` (statut du payment non relu) ; `idempotency_key` ≤ 64 car. non borné |
| SumUp Solo | `catalog/sumup-solo.json` | preview | ✅ developer.sumup.com | ❌ refund `/v0.1/me/refund` obsolète + montant en majeures (doc v1.0 + minor units) ; ⚠️ `minor_unit` non documenté ; `error_code` absent des schémas d'erreur |
| nexo Retailer | `packages/bridges/src/nexo.ts` | passerelle | 🟡 nexo-standards.org (spec adhérent) + docs vendeurs | ⚠️ `TransactionStatus` non standard (`MeridianState`, pas de `RepeatedMessageResponse`) ; `EventDetails` d'abort omis ; `POISoftware.POIID`, `POIReconciliationID` absents |
| ZVT (VDT) | `packages/bridges/src/zvt.ts` | passerelle | ✅ spec VDT publique PA00P015/PA00P016 | ⚠️ endianness longueur étendue à confirmer ; codes `06 1E` (6C/FF/B4) à confronter à la table ; Registration sans TLV-container ; partial reversal ignoré |
| Concert / Caisse-AP | `packages/bridges/src/concert.ts` | passerelle | 🟡 Association du Paiement (spec à acquérir) + références intégrateurs | ⚠️ `BA=1` double réponse vs référence (une seule) ; `CC`/`CI` réponse codés en dur incohérents ; `CD=2` filtré par montant + `CB=0` rejeté |

## Divergences ❌ à corriger (prioritaires)

1. **mollie-pos l.48** — `receipt.brand/maskedPan` pointent `p.cardDetails.*` ; le schéma v2 documente `details.cardLabel` / `details.cardNumber` (ou `cardMaskedNumber`). Reçus sans carte aujourd'hui.
2. **sumup-solo l.47-49** — refund sur endpoint legacy `/v0.1/me/refund/{id}` + `amount` en unités **majeures** ; la référence courante est `POST /v1.0/merchants/{mc}/payments/{id}/refunds` avec `amount` en **minor units** (entier).

## Divergences ⚠️ les plus risquées

- **square-terminal** : `COMPLETED → authorized` sans relire `payment_ids[0].status` — un refus carte peut être marqué autorisé si Square complète le checkout avec un payment `FAILED`.
- **adyen-terminal** : annulation initiée par Meridian (`Abort`) relue comme `ErrorCondition: Aborted` → règle `declined` au lieu de `cancelled`.
- **sumup-solo status** : le GET transactions renvoie 404 tant que la transaction n'existe pas → `status` peut lever une erreur au lieu de `pending` pendant la fenêtre checkout-accepté → transaction-visible.
- **concert `BA=1`** : deuxième trame de réponse possiblement inattendue par certaines caisses.

## Comment lire les fichiers

Chaque `<slug>.md` cite les URL officielles consultées, liste nos appels avec les lignes du module, puis cote **chaque** appel ✅/⚠️/❌ — ne sont confirmées que les sémantiques explicitement documentées. La section « Ce que la doc ne dit pas » liste les points à trancher en validation sandbox.
