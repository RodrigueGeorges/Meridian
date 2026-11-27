# Adyen Terminal API (cloud) — référence API

Source(s) : https://docs.adyen.com/point-of-sale/design-your-integration/terminal-api/ · https://docs.adyen.com/point-of-sale/basic-tapi-integration/verify-transaction-status/ · https://docs.adyen.com/point-of-sale/design-your-integration/choose-your-architecture · https://docs.adyen.com/api-explorer/terminal-api/latest/overview · consulté le 2026-11-27 · Terminal API v1, messages nexo `ProtocolVersion: "3.0"`

Module : `packages/modules/catalog/adyen-terminal.json` (version 0.1.0, `maturity: "preview"`)
Base URL : `https://terminal-api-test.adyen.com` (l.7) — **endpoints legacy** : Adyen recommande désormais les endpoints *Cloud Device API* `https://device-api-test.adyen.com/v1/merchants/{merchantAccount}/devices/{deviceId}/{sync|async}`.

## Endpoints que nous utilisons

- `POST /async` (l.72) — paiement : `SaleToPOIRequest.MessageHeader` (`ProtocolVersion 3.0`, `MessageClass Service`, `MessageCategory Payment`, `MessageType Request`, `SaleID`, `ServiceID={{tx.serviceId}}`, `POIID`) + `PaymentRequest` { `SaleData.SaleTransactionID` { `TransactionID={{tx.reference}}`, `TimeStamp` }, `PaymentTransaction.AmountsReq` { `Currency`, `RequestedAmount` (unités majeures) } }. Réponse immédiate : texte brut `"ok"` (`acceptText: true`, l.73) — le résultat arrive ensuite en event notification ou se relit via TransactionStatus.
- `POST /sync` (l.34, l.108) — TransactionStatus : `MessageHeader` catégorie `TransactionStatus` + `TransactionStatusRequest` { `ReceiptReprintFlag:false`, `MessageReference` { `SaleID`, `ServiceID={{tx.serviceId}}` original, `MessageCategory:Payment` } }. Utilisé à la fois comme `lookup` (pré-rejeu) et source de `status`.
- `POST /async` (l.169) — Abort : `MessageCategory Abort` + `AbortRequest` { `AbortReason:"MerchantAbort"`, `MessageReference` { `SaleID`, `ServiceID` original, `MessageCategory:Payment`, `POIID` } }.
- `POST /sync` (l.197) — Reversal (remboursement référencé) : `MessageCategory Reversal` + `ReversalRequest` { `OriginalPOITransaction.POITransactionID` { `TransactionID`, `TimeStamp` } lus depuis le reçu, `ReversalReason:"MerchantCancel"`, `ReversedAmount` }.

## Authentification

`x-API-key: {{config.apiKey}}` (l.27-29) — conforme à la doc (clé API générée dans le Customer Area, portée par l'en-tête `x-API-key`). JSON (`encoding: json`, l.30). `errorCodePath: "errorCode"` (l.31) — correspond au format d'erreur HTTP d'Adyen (`errorCode`, `errorType`, `message`).

## Idempotence

Pas de clé d'idempotence HTTP : la déduplication repose sur le triplet **`SaleID` + `ServiceID` + `POIID`** (`SaleTransactionID.TransactionID` identifie la vente).

- `ServiceID` : 1–10 caractères alphanumériques, **unique dans les dernières 48 h pour un POIID donné** (doc « Make a payment »). Notre `{{tx.serviceId}}` = 10 caractères base36 dérivés de SHA-256(référence) — déterministe par référence : un rejeu de la même référence réutilise exactement le même `ServiceID`, ce qui est précisément le mécanisme de dédup attendu. ✅
- `lookup` (l.32-66) : avant tout rejeu, TransactionStatus interroge `MessageReference.ServiceID={{tx.serviceId}}` ; `notFound` = `TransactionStatusResponse.Response.ErrorCondition == "NotFound"` → le paiement n'a jamais été reçu, rejeu possible. Confirme la doc (« NotFound → you can retry the original transaction »). ✅
- Fenêtre de dédup documentée : 48 h (durée de mémoire des ServiceID côté terminal).

## Erreurs et statuts

- `PaymentResponse.Response.Result` : `Success` | `Failure` (+ `ErrorCondition` : `Aborted`, `Cancel`, `Refusal`, `Busy`, `InProgress`, `NotFound`, `MessageFormat`, `NotAllowed`, …).
- `TransactionStatusResponse.Response.Result` : `Success` = transaction terminée (le résultat original est dans `RepeatedMessageResponse.RepeatedResponseMessageBody`) ; `Failure` + `ErrorCondition` `InProgress` (tender en cours) ou `NotFound` (inconnu / jamais reçu).
- Règles du module (l.132-165) : `…PaymentResponse.Response.Result == "Success"` → authorized ; `Failure` + `ErrorCondition == "Cancel"` → cancelled ; autre `Failure` → declined (détail = `ErrorCondition`). `InProgress` et `NotFound` tombent en pending par défaut. ✅
- Reçu (l.222-227) : `PaymentResult.PaymentInstrumentData.CardData.PaymentBrand` / `MaskedPan` / `POIData.POITransactionID.{TransactionID,TimeStamp}` — champs documentés. ✅
- Timeout doc : paiement ~120 s (local) / 150 s (cloud) avant de basculer en vérification de statut.

## Divergences constatées

- ✅ Corps `SaleToPOIRequest` Payment/TransactionStatus/Abort/Reversal — noms de champs conformes à la doc et aux exemples officiels (MessageHeader, SaleData, AmountsReq, MessageReference, OriginalPOITransaction, ReversalReason `MerchantCancel`, AbortReason `MerchantAbort`).
- ✅ Réponse `/async` = texte `"ok"` → `acceptText` correct.
- ✅ Chemins de statut `RepeatedMessageResponse.RepeatedResponseMessageBody.PaymentResponse…` — conformes à la structure documentée.
- ⚠️ **Endpoint legacy** : `terminal-api(-test).adyen.com` reste fonctionnel mais la doc recommande la Cloud Device API avec `merchantAccount` + `deviceId` dans l'URL — le module n'a pas de config `merchantAccount`; une migration demandera un nouveau paramètre.
- ⚠️ **Annulation initiée POS** : la doc distingue `ErrorCondition "Aborted"` (annulation par la caisse via AbortRequest) de `"Cancel"` (annulation sur le terminal). Notre Abort passe par `/async` → le `PaymentResponse` relu aura `Aborted`, qui tombe dans la règle générique `Failure → declined` au lieu de `cancelled`. Incohérent avec les autres modules (où notre propre annulation produit `cancelled`).
- ⚠️ `lookup`/`status` relancent un TransactionStatus complet avec un `ServiceID` frais (`{{now.nonce}}`) — conforme (chaque requête a son ServiceID) mais note : la doc précise que sans `MessageReference` on reçoit `NotFound` + `AdditionalResponse` avec le dernier SaleID/ServiceID du terminal — piste de récupération non exploitée.
- ⚠️ Le remboursement utilise `/sync` avec le timeout HTTP par défaut du runtime (8 s, `runtime.ts` l.78) ; Adyen documente des traitements cloud pouvant dépasser ce délai pour un nouveau tender — le rejeu après timeout est couvert par le lookup (même `ServiceID` frais mais `MessageReference` retrouve l'original), à valider en sandbox.
- ⚠️ `POIID` en config = `modele-numeroserie` (ex. `V400m-123456789`) — format documenté ✅, mais le module accepte n'importe quelle chaîne (pas de validation).

## Ce que la doc ne dit pas

- Durée de vie exacte du tender côté cloud quand l'event notification n'est pas reçu (on s'appuie sur le polling TransactionStatus, recommandé par la doc).
- Ordre garanti entre la réception de notre `Abort` et la fin du tender (race Abort vs Success — la doc promet un résultat unique relisible par TransactionStatus).
- Comportement du legacy `terminal-api` sur la durée (date de retrait non annoncée ; la doc dit seulement « strongly recommend migrating »).
- Présence systématique de `PaymentInstrumentData` dans les réponses de test (reçus sans brand sur certaines cartes de test).
