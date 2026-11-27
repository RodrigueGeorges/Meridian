# nexo Retailer (SaleToPOI) — référence protocole

Source(s) : https://www.nexo-standards.org/standards/nexo-retailer-protocol (organe officiel ; spécification complète derrière adhésion) · https://developer.swedbankpay.com/pax-terminal/Nexo-Retailer/Quick-guide/messageformat/ (documentation vendeur publique, implémentation nexo) · https://docs.adyen.com/api-explorer/terminal-api/latest/overview (implémentation nexo d'Adyen, référence de fait) · consulté le 2026-11-27 · spec nexo Retailer v3.x (« spec à acquérir » pour les énumérations exhaustives)

Passerelle : `packages/bridges/src/nexo.ts` — Meridian joue le rôle **POI** (terminal) côté Sale system : JSON et XML sur HTTP. `MessageCategory` traités : Login, Logout, Payment, Reversal, Abort, TransactionStatus, Reconciliation.

## Endpoints/messages que nous traitons

Entrée : `body.SaleToPOIRequest` → `MessageHeader` (`POIID` = point de vente Meridian, `MessageCategory`, `ServiceID`, `SaleID`) + corps `{Category}Request`. Réponse : `SaleToPOIResponse` avec `MessageHeader` écho (`MessageType: "Response"`, `nexo.ts` l.10) + `{Category}Response`.

- **Login** (l.24-38) : `LoginResponse` { `Response.Result: Success`, `POISystemData` { `DateTime`, `POISoftware` { `ProviderIdentification`, `ApplicationName`, `SoftwareVersion` }, `POIStatus.GlobalStatus: OK` } }.
- **Logout** (l.39) : `LogoutResponse.Response.Result: Success`.
- **Payment** (l.64-91) : lit `PaymentRequest.SaleData.SaleTransactionID.TransactionID` (référence idempotente) + `PaymentTransaction.AmountsReq.{Currency, RequestedAmount}` (unités majeures → converties en minor). Réponse `PaymentResponse` { `Response` (`Success` ou `Failure`+`ErrorCondition`), `SaleData` écho, `POIData.POITransactionID { TransactionID, TimeStamp }`, `PaymentResult` { `AmountsResp.AuthorizedAmount`, `PaymentInstrumentData.CardData.{PaymentBrand, MaskedPAN}` } }. `Failure` mapping : cancelled→`Aborted`, pending→`InProgress`, autre→`Refusal` ; exception engine→`Busy`.
- **Reversal** (l.93-104) : `ReversalRequest.OriginalPOITransaction.POITransactionID.TransactionID` + `ReversedAmount` optionnel → remboursement total ou partiel. `ReversalResponse` { `Response.Result`, `ReversedAmount` }. Échec → `NotAllowed`.
- **TransactionStatus** (l.106-114) : référence lue dans `MessageReference.SaleID` (fallback `ServiceID` — ⚠️ voir divergences). Réponse : `Response` `Success` ou `Failure/InProgress` + champ custom `MeridianState`. Inconnu → `NotFound`.
- **Abort** (l.116-122) : annule la transaction visée par `MessageReference.ServiceID` ; répond `EventNotification { EventToNotify: "Abort" }`.
- **Reconciliation** (l.41-62) : `ReconciliationRequest.ReconciliationType` (défaut `SaleReconciliation`) → `ReconciliationResponse` { `Response`, `ReconciliationType`, `TransactionTotals[]` par devise { `PaymentInstrumentType:"Card"`, `PaymentCurrency`, `PaymentTotals[{TransactionType:"Debit", TransactionCount, TransactionAmount}]` } }.
- **XML** (l.127-155) : parse/build fast-xml-parser — scalaires en **attributs** (`@_`), `isArray` sur `TransactionTotals`/`PaymentTotals` ; DOCTYPE/ENTITY rejetés (durcissement XXE).

## Authentification

Aucune au niveau protocole (nexo Retailer suppose un lien de confiance local/VPN ; la sécurité nexo — security module — n'est pas implémentée). Transport HTTP, `Content-Type` JSON ou XML selon la caisse.

## Idempotence

- `SaleTransactionID.TransactionID` = référence Meridian : idempotente par construction (le moteur dédup sur `reference`). Un Payment rejoué avec le même `TransactionID` retrouve la même transaction. ✅
- `ServiceID` : identifie la paire requête/réponse ; pas utilisé pour la dedup financière chez nous.
- `POITransactionID` : notre réponse réutilise la référence de vente comme `TransactionID` (le spec nexo attend une référence générée par le POI — notre mapping est cohérent fonctionnellement mais non canonique).

## Erreurs et statuts

- `Response.Result` : `Success` | `Failure` + `ErrorCondition` ∈ énumération nexo (`Aborted`, `Busy`, `Cancel`, `InProgress`, `MessageFormat`, `NotAllowed`, `NotFound`, `Refusal`, `UnreachableHost`, …). Nos choix : `MessageFormat` (header incomplet / champs manquants), `Aborted`, `InProgress`, `Refusal`, `Busy`, `NotAllowed`, `NotFound` — tous des valeurs de l'énum standard. ✅
- Timeout interne `waitFinal` 120 s par défaut (`opts.timeoutMs`).
- Catégories inconnues → `Failure/NotAllowed` (l.124).

## Divergences constatées

- ✅ Enveloppe `SaleToPOIRequest/Response`, `MessageHeader` avec attributs XML (`ProtocolVersion`, `MessageClass`, `MessageCategory`, `MessageType`, `ServiceID`, `POIID`, `SaleID`) — conforme au format nexo documenté (Swedbank Pay, Adyen).
- ✅ `ProtocolVersion` : non fixé par nous — écho de la valeur reçue (nexo courant « 3.1 », Adyen « 3.0 ») : bonne stratégie de compat.
- ✅ `PaymentRequest` parsing (`SaleTransactionID`, `AmountsReq`) et `PaymentResponse` structure (`POIData`, `PaymentResult`, `AmountsResp`) — conformes.
- ✅ `ReversalRequest.OriginalPOITransaction.POITransactionID` + `ReversalReason` — conforme (exemple officiel).
- ⚠️ **TransactionStatus — structure non standard** : la spec attend `TransactionStatusResponse` contenant `RepeatedMessageResponse` { `MessageHeader` (de la requête originale) + `RepeatedResponseMessageBody` (la réponse originale, ex. `PaymentResponse`) + `MessageReference` }. Nous renvoyons un champ custom `MeridianState` + un `Response` simplifié : **une caisse nexo réelle ne trouvera pas le résultat original**. Comportement acceptable pour des caisses pilotées par Meridian, non conforme stricto sensu.
- ⚠️ **TransactionStatus lit `MessageReference.SaleID` comme référence** (l.107) : dans la spec, `MessageReference.ServiceID` identifie le message original et `SaleID` identifie le système de vente — la transaction est retrouvée via `ServiceID`/`POITransactionID`. Notre ordre (SaleID puis ServiceID) suppose que la caisse met la référence transaction dans `SaleID` — convention non standard, à documenter pour les intégrateurs.
- ⚠️ **Abort → `EventNotification`** : la spec encapsule l'abort dans `EventNotification` avec `EventToNotify:"Abort"` + `EventDetails` (référence du message avorté). Nous omettons `EventDetails` — probablement toléré, à valider.
- ⚠️ `LoginResponse.POISystemData.POISoftware` : la spec inclut `POIID` dans `POISoftware` ; nous l'omettons (mineur).
- ⚠️ `ReversalResponse` minimal : la spec inclut typiquement `POIData` (+ `PaymentReceipt` optionnels) — absent chez nous (mineur).
- ⚠️ `ReconciliationResponse` sans `POIReconciliationID` et `TransactionTotals` simplifié (pas de `AcquirerData`, pas de distinction Credit/Debit dans les totaux — les remboursements sont soustraits au débit, l.49 : `amount - refunded`). La spec distingue les totaux par `TransactionType` (Debit/Credit) — notre agrégation nette est une simplification.
- ⚠️ `MaskedPAN` (l.83) : orthographe spec `MaskedPAN` chez nexo / `MaskedPan` chez Adyen — nous émettons `MaskedPAN` en JSON ; vérifier la casse attendue par la caisse.
- ⚠️ XML → JSON : `isArray` uniquement sur `TransactionTotals`/`PaymentTotals` — un seul `PaymentTotals` reçu en XML resterait objet (OK car on n'émet que); les listes nexo fréquentes (`PaymentReceipt`, `TransactionConditions`) ne sont pas forcées en tableau — à étendre si la caisse envoie des listes.

## Ce que la doc ne dit pas (spec complète derrière adhésion nexo)

- Énumérations exhaustives `ErrorCondition`, `GlobalStatus`, `ReversalReason`, `ReconciliationType`, `PaymentInstrumentType` — vérifier contre la spec officielle acquise.
- Séquencement exact attendu des champs XML (« elements must be in schema order » chez certains terminaux — notre builder émet dans l'ordre d'insertion, conforme pour ce qu'on produit).
- Messages additionnels attendus par certaines caisses (`CardAcquisition`, `Diagnosis`, `Display`, `Input`, `Batch`/`Reconciliation` étendu) — aujourd'hui `NotAllowed`.
