# ADR 002 — Robustesse et mise en production (lots 1 et 2)

Date : 2026-11-27 · Statut : accepté

## Contexte

Préparation du passage en production réelle : durcissement du code (lot 1) puis
config, sécurité réseau, CI et documentation (lot 2).

## Décisions

### Lot 1 — robustesse du code

1. **Gardes d'ajout atomiques** : la création d'un paiement et les remboursements s'évaluent
   en SQL dans la transaction d'ajout au journal, sous verrou transactionnel **par point de
   vente** (`pg_advisory_xact_lock(hashtext('journal:'||pos_id))`) — sûr entre instances, et
   deux terminaux ne se bloquent jamais l'un l'autre (chaîne `seq` shardée par `pos_id`,
   migration 011).
2. **Remboursements pré-journalisés** : `refund_pending` écrit avant l'appel PSP, cumul plafonné
   au montant payé ; une réponse perdue se reprend avec le même numéro sans double remboursement.
3. **Verrous de cluster par paiement** : un seul pilote par paiement (verrou consultatif de session,
   libéré si l'instance tombe) ; le scanner reprend les orphelins.
4. **Rotation des clés** : signatures du journal préfixées par `kid` (`JOURNAL_KEY_ID`,
   `JOURNAL_KEYS_PREVIOUS`), secrets PSP chiffrés par version (`MASTER_KEY_VERSION`,
   `MASTER_KEYS_PREVIOUS`) ; `pnpm rotate-secrets` pour le rechiffrement.
5. **Garde pooler** : une `DATABASE_URL` de pooler en mode transaction est refusée au démarrage
   (les verrous consultatifs de session n'y survivent pas) ; `DATABASE_POOLED_OK=true` pour forcer.
6. **File de webhooks tolérante à l'arrêt** : insertion insensible à la fermeture du pool.

### Lot 2 — production

7. **Gardes de démarrage** : refus sans `DATABASE_URL` (sauf démo/fichier/test/`ALLOW_EPHEMERAL`),
   `DEMO_SEED` + clé live refusé, `ALLOW_TEST_BASE_URL` + clé live refusé (porte SSRF).
8. **Passerelles TCP bornées** : 64 Ko de trame, 200 connexions simultanées, inactivité 2 min —
   liées sur loopback, jamais exposées publiquement (ni dans Fly ni dans l'image).
9. **Limites de débit authentifiées** : 120/min/IP + 300/min/org, rapprochement 6/min/IP,
   échecs d'auth 60/min/IP comptés avant la recherche de clé.
10. **Webhooks par organisation** : URL propre à l'org (`PUT /v1/org/webhook`, repli sur le global),
    validée à l'appel — https + hôte public hors mode test ; l'appel HTTP sort du verrou de ligne
    (marquage `next_at` + 5 min au lieu de `FOR UPDATE` pendant l'appel — supérieur au pire cas
    du batch de 20 livraisons × 5 s de timeout HTTP).
11. **XML nexo durci** : `processEntities: false`, DOCTYPE refusé, `fast-xml-parser` épinglé à 5.12.1.
12. **Rétention `audit_log`** : DELETE possible seulement au-delà de 370 jours (migration 009),
    purge horaire ; PCI DSS exige 1 an.
13. **CI/CD** : actions épinglées par SHA de commit ; déploiement prod manuel
    (`workflow_dispatch` + `environment: production`) sur `infra/fly/api.prod.toml`.
14. **Image** : Node fixe (22.23.5-alpine), deps de production uniquement, `EXPOSE 8080` seul,
    `NODE_OPTIONS=--max-old-space-size=384` (VM 512 Mo).
15. **Agent edge** : jeton d'API locale obligatoire (généré, persisté 0600, imprimé une fois) ;
    remplacement d'agent audité (`agent_replaced`).

## Conséquences

- Le relais edge est multi-instance : les connexions WebSocket restent en mémoire, mais une
  requête reçue par l'instance B pour un agent rattaché à A est relayée par PostgreSQL
  LISTEN/NOTIFY (`edge_cmd`/`edge_resp`, payload < 8 Ko) — résolu, plus de restriction
  de scaling pour les agents.
- Le secret de webhook est global ; `secret` par org est accepté mais ignoré — point ouvert.
- Validation des URLs de webhook littérale sur le hostname, sans épinglage DNS — rebinding
  DNS hors périmètre.
