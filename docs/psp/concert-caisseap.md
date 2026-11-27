# Concert / Caisse-AP — référence protocole

Source(s) : https://associationdupaiement.fr/protocoles/protocole-caisse/ (organe officiel — « CAISSE-AP », v3.20 depuis juillet 2020, v3.30 depuis juillet 2026) · https://payxpert-docs.atlassian.net/wiki/spaces/docs/pages/699039746/AP+Concert+Protocol (format TLV documenté par un intégrateur certifié) · https://www.simax.fr/aide/fonctions/portcom.tpe.html (extrait de norme : table des tags) · https://github.com/akretion/caisse-ap-ip (implémentation de référence open-source, simulateur de TPE, port 8888) · consulté le 2026-11-27 · **spec complète à acquérir auprès de l'Association du Paiement**

Passerelle : `packages/bridges/src/concert.ts` — Meridian joue le rôle **TPE**, TCP port 8888, une requête par connexion.

## Format de trame

TLV ASCII **non-BER** : `Type` = 2 octets alpha, `Length` = 3 octets numériques (zéro-remplis à gauche), `Value` = ASCII 0x20–0x7F. `CZ` (version protocole) toujours en premier ; l'ordre des autres tags est libre. Parser `parseTlv` (l.11-24) + builder `buildTlv` (l.26-31, CZ d'abord). ✅ conforme au format documenté.

## Tags que nous traitons

Requête (caisse → TPE) :

| Tag | Rôle | Traitement |
|---|---|---|
| `CZ` | Version protocole | obligatoire, écho dans la réponse (l.98-101) |
| `CJ` | Identifiant protocole caisse (IPC, 12 car.) | obligatoire, écho |
| `CA` | N° de caisse (2 car.) | obligatoire → `posFor(CA)` mappe vers un point de vente Meridian (l.37, l.46) |
| `CB` | Montant (≤ 10 chiffres, unités mineures) | obligatoire, entier > 0 (l.48-49) |
| `CD` | Type d'action : `0` débit, `1` crédit/remboursement, `2` annulation | `0`→pay, `1`→refund du dernier remboursable de ce montant, `2`→cancel/refund du dernier annulable de ce montant (l.51-65) |
| `CE` | Devise ISO numérique (3 car., `978`=EUR) | obligatoire → `ISO_NUMERIC` (l.47) |
| `BA` | `1` = réponse immédiate | ACK précoce `AE=11` puis réponse finale (l.101-103) |
| `CC` | Sélection application (`001` bancaire, `00C` chèque…) | ignoré en entrée ; renvoyé fixe `001` en réponse succès |

Réponse (TPE → caisse) : écho des tags reçus (sauf `BA`, l.42-44) + `AE` résultat, `AF` motif, `AC` n° autorisation (6 chiffres), `AA` PAN masqué, `CC` mode, `CI` type de lecture.

## Idempotence

**Aucune** — limite documentée du protocole : pas de référence transaction côté caisse (commentaire l.7). Meridian génère `bridgeRef('CONCERT', CA)` par débit. Remboursement et annulation ciblent « la dernière opération **de ce montant** sur cette caisse » (`lastRefundable`/`lastCancellable`, `target.ts`) — choix défensif (la spec dit « annulation de la dernière opération » ; nous restreignons par montant pour éviter d'annuler une opération d'un montant différent).

## Erreurs et statuts

- `AE` : `10` fait · `01` non fait (+`AF` motif) · `11` pris en compte (réponse immédiate `BA=1`, sans `AF`). ✅ corroboré par l'implémentation de référence.
- `AF` (complément, présent seulement sur `AE=01`) : `04` refus · `05` interdit · `08` délai/timeout · `09` erreur format · `11` abandon client. Notre mapping : cancelled→`11`, pending→`08`, declined→`04`, config/format→`09`/`05` (l.45-49, l.73-75). ✅ corroboré (`abandon:11, timeout:08, refused:04, forbidden:05`).
- Trame malformée → `AE=01` `AF=09` immédiat (l.93-97) ; tags obligatoires manquants → `09` (l.45) — aligné sur la référence.
- Bornes : trame 64 Ko, 200 connexions, inactivité 2 min.

## Divergences constatées

- ✅ Format TLV 2+3+valeur, `CZ` en premier, liste des tags obligatoires `CZ CJ CA CB CD CE` — conforme aux références publiques.
- ✅ `AE` 10/01/11 + codes `AF` 04/05/08/09/11 — identiques à l'implémentation de référence et aux extraits de norme.
- ✅ `CD` : `0` débit, `1` crédit, `2` annulation — valeurs conformes (la norme en a d'autres : `3` duplicata, `4` pré-auto, `5`/`6`, `B` télécollecte, `I` identification → nous répondons `AF=05` interdit : acceptable mais à documenter).
- ✅ Port 8888, une requête par connexion, ASCII.
- ⚠️ **`BA=1` — sémantique à double réponse** : nous émettons `AE=11` (pris en compte) **puis** la réponse définitive sur la même connexion (l.101-103). L'implémentation de référence ne renvoie que `AE=11`. La norme définit la « réponse immédiate » ; selon la caisse, une seconde trame peut être inattendue (connexion déjà refermée) ou attendue. À trancher avec la spec + un vrai monétique.
- ⚠️ **`CC`/`CI` de réponse codés en dur** (`CC=001`, `CI=2`) : `001` = « bancaire contact » alors que `CI=2` = sans contact dans la référence — incohérent entre eux, et devrait refléter le mode réel (`001`/`00B` CB sans contact, `002`/`00D` Amex, `00V` ANCV). À aligner sur le reçu (`card.type`).
- ⚠️ `AA` : nous émettons `############` + last4 (16 car.) ; la référence utilise 6 `#` + last4 (10 car.). Format norme = PAN masqué, longueur à confirmer.
- ⚠️ `CB` en annulation (`CD=2`) : la norme vise « la dernière opération » — notre filtre par montant est plus strict ; si la caisse envoie `CB=0` pour « dernière quelconque », nous rejetterons `05` (`amount <= 0` l.49 → `fail('05')` en fait avant même le `CD=2` — vérifier le séquencement : `amount<=0` est refusé **avant** la recherche d'annulable, donc `CD=2 + CB=0` échoue).
- ⚠️ v3.30 (juillet 2026) ajoute l'« abandon de transaction » et des tags d'enrichissement — notre implémentation cible le socle v3.20 ; `CZ` est écho donc la version est propagée, mais les nouveaux tags seront ignorés.
- ⚠️ `AC` = `proof.seq` interne paddé à 6 (l.71) : le n° d'autorisation réel de la transaction n'est pas celui du PSP — valeur de forme correcte mais non traçable vers l'autorisation acquéreur.

## Ce que la doc ne dit pas (spec à acquérir)

- Sémantique exacte de `BA` (une ou deux réponses ; la caisse ferme-t-elle la connexion après `AE=11` ?).
- Longueurs/format normés de `AA`, `AC`, `AI`, `AB`, `CF`, `CG` (reçu complet TPE).
- Liste exhaustive des `CD` supportés par les TPEs cibles et les `AF` associés (v3.30 ajoute l'abandon explicite).
- Si `CB=0`/absent est licite pour `CD=2` (annulation de la toute dernière opération indépendamment du montant).
- Échanges hors paiement (`I` identification, `B` télécollecte) exigés par certaines caisses — aujourd'hui `AF=05`.
