# ZVT (VDT) — référence protocole

Source(s) : http://www.terminalhersteller.de/downloads/PA00P015_13.13_final.pdf (spec officielle VDT, *ECR-Interface ZVT-Protocol*, rev. 13.13 du 17.06.2025, EN — commandes/bitmaps/erreurs) · http://www.terminalhersteller.de/downloads/PA00P016_04_en.pdf (rev. 04, transport TCP/IP + structure APDU) · https://www.terminalhersteller.de/Downloads.aspx (portail VDT, téléchargement libre) · consulté le 2026-11-27

Passerelle : `packages/bridges/src/zvt.ts` — Meridian joue le rôle **PT** (terminal) côté ECR (caisse), serveur TCP. La spec VDT est publique ; ce document cote chaque point implémenté contre elle (« spec acquise » — référence : PA00P015 EN 13.13).

## Trames / transport

- APDU : `CLASS INSTR LEN DATA` ; `LEN` = 1 octet (0–254) ou `0xFF` + 2 octets pour data > 254 (l.14-18, 20-31). TCP/IP : trames brutes, sans DLE/STX/ETX/CRC (conforme PA00P016 §4 : en TCP on envoie l'APDU directement, la caisse doit gérer le découpage arbitraire — notre buffer accumule jusqu'à trame complète ✓).
- Bornes propres à l'implémentation : trame max 64 Ko, 200 connexions, inactivité 2 min (l.57-69).

## Commandes que nous traitons (ECR → PT)

| Cmd | Rôle spec | Traitement (zvt.ts) |
|---|---|---|
| `06 00` | Registration | ACK + Completion `06 0F` (l.76) — aucune config lue |
| `06 02` | Log-Off | ACK + Completion (l.77) |
| `06 01` | Authorization | BMP `04` montant BCD 6 o., BMP `49` devise BCD 2 o. → `pay` ; succès → `04 0F` {`27 00` résultat, `04` montant, `87` n° reçu BCD 2 o.} + `06 0F` ; échec → `06 1E` code (l.104-128) |
| `06 30` | Reversal | BMP `87` n° reçu → remboursement du résiduel ; `04 0F` {`27 00`, `87` reçu} + `06 0F`, sinon `06 1E [B4]` (l.129-143) |
| `06 31` | Refund | BMP `04` montant → remboursement du dernier remboursable de ce montant ; mêmes réponses, sinon `06 1E [B4]` (l.89-102) |
| `06 B0` | Abort | ACK puis cancel de la transaction en cours (l.103) |
| `06 50` | End-of-Day | `04 0F` {`27 00`, `04` total jour net} + `06 0F` ; compteur remis à zéro (l.78-88) |
| `05 01` | Status Enquiry | ACK + Completion (l.77) |
| `06 70` | Diagnosis | ACK + Completion (l.77) |
| autre | — | `84 83` « fonction non supportée » (l.145) |

## Réponses (PT → ECR)

- `80 00` ACK ✓ ; `06 0F 00` Completion ✓ ; `04 0F` Status-Information avec BMP `27` (code résultat 1 octet, `00` = succès), BMP `04` montant, BMP `87` n° reçu ✓ ; `06 1E` Abort + octet d'erreur (`6C` abandon, `FF` autre/refus, `B4` opération impossible) ; `84 83` commande inconnue.
- Vraisemblance : le mécanisme CCRC/APRC (`80` positif / `84` négatif + id d'erreur) décrit dans PA00P016 correspond à notre `84 83` (négatif, erreur `83` = « function not possible »).

## Idempotence

Aucune au niveau protocole : ZVT n'a pas de référence transaction — Meridian génère `bridgeRef('ZVT', posId-suffix)` par autorisation (l.109). La cohérence ECR↔PT passe par le **n° de reçu** (BMP `87`, 2 oct. BCD, compteur 1–9999 interne l.115) que l'ECR cite dans Reversal `06 30`. Perte du mapping `receipts` au redémarrage → `06 1E [B4]` (reçu inconnu). Limitation documentée.

## Erreurs et statuts

- `04 0F` BMP `27` : octet résultat — nous n'émettons que `00` (succès) ; la table complète des result-bytes est en annexe bitmaps de PA00P015.
- `06 1E` : octet d'erreur — `6C` (abandon client/abort), `FF` (autre erreur), `B4` (rien à rembourser / reçu inconnu / non remboursable). Chapitre « Error Messages » de PA00P015 liste les codes ; nos trois choix sont des valeurs usuelles mais à confirmer code par code.
- Parsing BMP entrant (l.40-53) : `04` amount 6 o. BCD, `49` currency 2 o. BCD (ex. `09 78` = 978 EUR), `87` receipt 2 o. BCD ; `01`,`19`,`02` sautés 2 o. ; tout BMP inconnu arrête le parse — le montant est en tête en pratique donc les BMP optionnels postérieurs (spec : `[19][2D][0E][22][23][24][01][02][05][3A][3C][8A][06]`) sont ignorés sans erreur.

## Divergences constatées

- ✅ Structure APDU + transport TCP (pas de DLE/STX en TCP) — conforme PA00P016.
- ✅ Codes de commande `06 00/01/02/30/31/50/70`, `05 01`, `06 B0` — conformes PA00P015 (le tableau de la tâche disait « Authorization 0631 » : c'est `06 01` Authorization et `06 31` Refund dans la spec — notre code est correct).
- ✅ Réponses `80 00`, `06 0F`, `04 0F` avec BMPs `27`/`04`/`87` — conformes aux trames documentées.
- ✅ BMP `04` = 6 octets BCD montant, `49` = 2 octets BCD devise, `87` = 2 octets BCD reçu — longueurs conformes.
- ⚠️ **Ordre des octets de longueur étendue** : notre émetteur/lecteur utilise `0xFF` + *low byte puis high byte* (little-endian, l.16 & 26). PA00P016 spécifie la forme 3 octets mais l'extrait public ne tranche pas l'ordre — implémentations communautaires usuelles = low-byte-first ; à confirmer dans la spec (notre propre implémentation est auto-cohérente, le risque n'existe qu'en face d'un ECR réel avec trames > 254 o.).
- ⚠️ **Registration sans TLV** : la spec 13.x recommande fortement l'échange du TLV-container (BMP `06` avec tags 10/11/12/14/…) à la Registration ; notre `06 00` renvoie une Completion nue — les ECRs récents peuvent envoyer tag `06` + liste de commandes et attendre un écho (jeu de commandes autorisées, encodage). À valider sur terminal réel.
- ⚠️ **Codes d'erreur `06 1E`** (`6C`/`FF`/`B4`) — usuels mais non confirmés ligne à ligne dans l'extrait public ; le code `6C` correspond communément à « transaction aborted » ; `B4` choisi par nous pour « nothing to refund » ; à confronter à la table des Error-Messages.
- ⚠️ `06 30` Reversal sans montant : la spec permet montant partiel + BMP `87` ; nous ignorons tout BMP `04` éventuel et remboursons toujours le résiduel total (l.137) — partial reversal non supporté.
- ⚠️ `06 50` End-of-Day : la spec prévoit une réponse plus riche (totaux par type de carte, journaux) ; nous renvoyons seulement le total net jour — un ECR attendant les blocs de détail pourra afficher un rapport incomplet.
- ⚠️ Pas de `Print`/`Display Text` (`06 E0`/`E1`/…), pas de Pre-Auth (`06 22`/`06 23` etc.) → `84 83` correct mais fonctionnellement limité.
- ⚠️ `waitFinal` 120 s (l.113) : la spec impose au PT de déclarer ses timeouts via Registration ; un ECR peut abandonner avant — race entre `06 1E` côté ECR et notre réponse tardive.

## Ce que la doc ne dit pas (à trancher avec PA00P015 en main + sandbox)

- Ordre exact des 2 octets de la longueur étendue (vraisemblablement little-endian — à lire §5.2.4).
- Table exhaustive des codes d'erreur `06 1E` et des result-bytes `04 0F/27`.
- Comportement ECR attendu quand l'Authorization inclut des BMPs optionnels (`8A` indicateurs de carte, `3A`/`3C`, `06` TLV) — nous les ignorons silencieusement.
- Si `06 B0` Abort exige une réponse finale (`06 1E`) en plus de l'ACK — la spec documente l'abort-command et l'abort-response ; nous n'émettons que l'ACK puis laissons le `06 1E` naturel de l'Authorization en cours porter le résultat.
