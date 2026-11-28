# Montée en charge — Meridian

Modèle de passage à l'échelle, chiffres mesurés, paliers de sizing et procédures.

## Ce qui change à l'échelle (déjà en place)

| Mécanisme | Avant | Maintenant |
|---|---|---|
| Journal chaîné | Un verrou transactionnel **global** (`pg_advisory_xact_lock(7426001)`) sérialisait tous les événements de toutes les organisations | Chaîne `seq` **par point de vente** (`pos_id`), verrou par POS — deux terminaux ne se bloquent jamais (migration `011_pos_chains.sql`) |
| Relais edge | Mono-instance : les agents d'un magasin devaient joindre l'instance qui pilote leurs paiements | Multi-instance : la requête est relayée à l'instance détentrice du socket par PostgreSQL **LISTEN/NOTIFY** (`edge_cmd`/`edge_resp`, payload < 8 Ko), testée à 2 instances (`cluster.test.ts`) |
| Pool PostgreSQL | Défaut pg (10 connexions/instance) | `DATABASE_POOL_MAX` configurable |
| Observabilité | `/v1/ops` JSON seulement | `GET /v1/ops?format=prometheus` scrapable (bearer = clé d'API) |

## Chiffres mesurés (benchmark local)

Outil : `DATABASE_URL=postgres://… pnpm bench [total] [pos] [concurrence] [orgs]` (`tools/bench.ts`).
Environnement : Windows, PostgreSQL 16 local, runtime `tsx` interprété, simulateur PSP
(~270 ms de latence par autorisation — un vrai PSP est comparable ou plus lent).

| Paiements | POS | Orgs | Concurrence | Résultat | Débit |
|---|---|---|---|---|---|
| 200 | 20 | 1 | 20 | 200/200 autorisés | ~43 paiements/s |
| 300 | 30 | 3 | 30 | 300/300 autorisés | ~50 paiements/s |
| 600 | 60 | 6 | 60 | 600/600 autorisés | ~60 paiements/s |
| 600 | 120 | 6 | 120 | 600/600 autorisés | ~68 paiements/s |

**Lecture** : le débit est borné par la latence du pipeline (~1 s/paiement : autorisation PSP +
sondages moteur + écritures journal) multipliée par la concurrence — **plus par un verrou global**.
Sur une instance 512 Mo partagée, ~65-70 paiements/s simultanés par instance en local ; en prod
Fly + MPG fra↔cdg (~10 ms DB), compter plutôt 30-50 paiements/s par instance avant d'autres
goulots (CPU, pool). `pos=1` reproduit la sérialisation d'un terminal seul.

### Plafonds produit (par conception, pas des bugs)

- **Rate limits** : 120 req/min par IP sur les routes authentifiées, **300 req/min par
  organisation** (bucket `api_org`) — soit ~5 req/s soutenues par marchand, largement au-dessus
  du besoin réel (un magasin dense fait 1-2 paiements/min/terminal). Relever `api_org` dans
  `server.ts` si un marchand dépasse.
- **Un paiement par terminal** : `terminal_busy` — sémantique métier, pas un bug.
- **pg_notify** : payload edge < 8 Ko — les requêtes terminal plus grosses restent locales.

## Sizing recommandé

| Palier | Machines API | Base MPG | `DATABASE_POOL_MAX` | Usage |
|---|---|---|---|---|
| Démarrage | 1 × shared-cpu-1x / 512 Mo | Basic (1 Go) | 10 (défaut) | Pilot, quelques marchands |
| Croissance | 2 × shared-cpu-1x / 512 Mo (cdg) | Basic | 10 | HA + ~60-100 paiements/s cumulés |
| Charge | 2-4 × shared-cpu-2x / 1 Go | Scale (2-4 Go) | 20 | Pics, >100 paiements/s cumulés |
| Forte charge | 4+ × dedicated-cpu-1x | Scale + réplica lecture | 25 | À dimensionner après bench réel |

Règle pool : `~2 × vCPU par instance`, et la somme `DATABASE_POOL_MAX × instances` doit rester
< `max_connections` du cluster MPG (≈ 100 Basic, ≈ 300 Scale — vérifier `SHOW max_connections`).
Rappel : le MPG délivre une URL **pgbouncer** et une URL **directe** — utiliser la directe
(verrous consultatifs de session ; le garde au boot refuse `-pooler`/`6543` sinon).

## Procédures

### Passer à N instances

```bash
fly scale count 2 --region cdg -a meridian-2ejyig
```

Rien d'autre : coordination paiements par verrous consultatifs, file webhooks en base,
relais edge via LISTEN/NOTIFY. L'arrêt reste propre (drain 20 s < kill_timeout 30 s).

### Multi-région

Aujourd'hui : API cdg, base fra (~10 ms). Pour servir plusieurs régions : déployer des
machines dans les régions proches des magasins, la base reste à fra (leader unique) — la
latence DB s'ajoute à chaque append du journal (~10-15 ms de RTT). Un réplica de lecture MPG
peut servir les lectures lourdes (rapprochement, console) hors du chemin d'écriture — chantier
distinct, non requis aux paliers ci-dessus.

### Observabilité externe

```
GET /v1/ops?format=prometheus   # Authorization: Bearer <clé d'API>
```

Métriques : `meridian_uptime_seconds`, `meridian_payments_pending`, `meridian_payments_stuck`
(alerte : >0 durable), `meridian_edge_agents`, `meridian_journal_events`, `meridian_db_up`,
`meridian_db_pool_total/idle/waiting` (saturation si `waiting` > 0 → augmenter le pool),
`meridian_memory_rss_bytes`. Prometheus : `bearer_token_file` ou `authorization.credentials`.

### Test de restauration (à faire avant de dépendre des backups MPG)

```bash
# 1. Restaurer un snapshot dans un cluster dédié
fly mpg snapshots -c <cluster_id> ; fly mpg restore <snapshot_id> -n meridian-restore-test
# 2. Brancher une app de test sur l'URL directe restaurée, laisser les migrations s'appliquer
# 3. Vérifier /v1/journal/verify (intégrité des chaînes par POS) et /health db:true
# 4. Détruire le cluster de test
```

Objectif mesurable : temps de restauration réel (RTO) vs perte de données maximale (RPO —
snapshot le plus récent couvrant la période d'incident).

### Rejouer le benchmark

```bash
DATABASE_URL=postgres://meridian:meridian@localhost:55432/meridian pnpm bench 600 60 60 6
```

Vérifier à la fin : `états.authorized == paiements`, `débitsPsp == paiements`,
`échoués == 0`. `restésEnCours > 0` = saturation (latence > waitMs).
