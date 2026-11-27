#!/usr/bin/env bash
# Meridian — mise en production en une commande (Fly.io, région Paris).
#
# Prérequis (une fois) :
#   1. flyctl : https://fly.io/docs/flyctl/install/  (Windows : iwr https://fly.io/install.ps1 -useb | iex)
#   2. fly auth login
# Puis : ./tools/go-live.sh
#
# Le script : crée l'app si besoin, provisionne un PostgreSQL géré (Fly MPG, sauvegardes incluses),
# génère tous les secrets, déploie, met à l'échelle et fait un test de fumée.
# Tout est configurable par variables d'environnement ; relançable (idempotent).
#
#   APP=meridian-api           nom de l'app Fly (défaut : celui d'infra/fly/api.prod.toml)
#   REGION=cdg                 région (défaut : cdg, Paris)
#   DB_NAME=<app>-db           cluster Managed Postgres ; DB_PLAN=Basic ; DB_GB=10
#   SCALE=2                    nombre de machines après le premier déploiement (défaut : 1, puis 2)
#   PUBLIC_URL=https://…       défaut : https://$APP.fly.dev
#   DATABASE_URL=postgres://…  base externe existante : le script ne crée pas de MPG
#                              (connexion directe requise, pas de pooler en mode transaction)
#   SKIP_DB=1                  ne touche pas à la base (DATABASE_URL déjà posé en secret)
set -euo pipefail
cd "$(dirname "$0")/.."

APP="${APP:-meridian-api}"
REGION="${REGION:-cdg}"
DB_NAME="${DB_NAME:-$APP-db}"
DB_PLAN="${DB_PLAN:-Basic}"
PUBLIC_URL="${PUBLIC_URL:-https://$APP.fly.dev}"
FLY="$(command -v fly || command -v flyctl || true)"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
rand() { openssl rand -hex "$1" 2>/dev/null || node -e "console.log(require('crypto').randomBytes($1).toString('hex'))"; }

[ -n "$FLY" ] || die "flyctl introuvable. Installation : https://fly.io/docs/flyctl/install/"
"$FLY" auth whoami >/dev/null 2>&1 || die "Non connecté : lance « $FLY auth login » puis relance ce script."

say "1/5 App $APP ($REGION)"
if ! "$FLY" apps list 2>/dev/null | awk '{print $1}' | grep -Fxq "$APP"; then
  "$FLY" apps create "$APP" --org personal >/dev/null 2>&1 \
    || "$FLY" apps create "$APP" >/dev/null 2>&1 \
    || "$FLY" launch --config infra/fly/api.prod.toml --name "$APP" --region "$REGION" --no-deploy
fi
"$FLY" status -a "$APP" 2>/dev/null | head -3 || true

if [ -n "${DATABASE_URL:-}" ]; then
  say "2/5 Base externe fournie (pas de MPG créé)"
  case "$DATABASE_URL" in *-pooler*|*:6543*|*pgbouncer=true*) die "URL de pooler transactionnel détectée : les verrous de session exigent une connexion directe.";; esac
elif [ "${SKIP_DB:-0}" = "1" ]; then
  say "2/5 Base ignorée (SKIP_DB=1)"
else
  say "2/5 PostgreSQL géré : $DB_NAME (plan $DB_PLAN, $REGION)"
  if ! "$FLY" mpg status "$DB_NAME" >/dev/null 2>&1; then
    "$FLY" mpg create --name "$DB_NAME" --region "$REGION" --plan "$DB_PLAN" --pg-major-version 16
  fi
  "$FLY" mpg attach "$DB_NAME" -a "$APP" 2>/dev/null \
    || "$FLY" mpg attach "$DB_NAME" --app "$APP"
fi

SECRETS_FILE=".secrets-prod.txt"
say "3/5 Secrets"
if [ -f "$SECRETS_FILE" ]; then
  echo "  $SECRETS_FILE existe déjà : les secrets générés sont réutilisés (rotation manuelle si besoin)."
  # shellcheck disable=SC1090
  . "$SECRETS_FILE"
else
  JOURNAL_KEY="$(rand 32)"; MASTER_KEY="$(rand 32)"; BOOTSTRAP_API_KEY="mk_live_$(rand 16)"; METRICS_TOKEN="$(rand 16)"
  { echo "JOURNAL_KEY=$JOURNAL_KEY"; echo "MASTER_KEY=$MASTER_KEY"; echo "BOOTSTRAP_API_KEY=$BOOTSTRAP_API_KEY"; echo "METRICS_TOKEN=$METRICS_TOKEN"; } > "$SECRETS_FILE"
  chmod 600 "$SECRETS_FILE" 2>/dev/null || true
fi
METRICS_TOKEN="${METRICS_TOKEN:-$(rand 16)}" # les fichiers de secrets antérieurs n'en avaient pas
[ -z "${DATABASE_URL:-}" ] || "$FLY" secrets set -a "$APP" DATABASE_URL="$DATABASE_URL"
"$FLY" secrets set -a "$APP" \
  JOURNAL_KEY="$JOURNAL_KEY" MASTER_KEY="$MASTER_KEY" \
  BOOTSTRAP_API_KEY="$BOOTSTRAP_API_KEY" PUBLIC_URL="$PUBLIC_URL" METRICS_TOKEN="$METRICS_TOKEN"

say "4/5 Déploiement"
"$FLY" deploy --config infra/fly/api.prod.toml -a "$APP" --remote-only
"$FLY" scale count "${SCALE:-2}" -a "$APP" -y 2>/dev/null || true

say "5/5 Test de fumée"
sleep 8
curl -fsS "https://$APP.fly.dev/health" && echo
curl -fsS -o /dev/null -w '  GET /v1/status → %{http_code}\n' "https://$APP.fly.dev/v1/status"

say "Meridian en ligne : $PUBLIC_URL"
cat <<EOF
Clé d'administration initiale (aussi dans $SECRETS_FILE — à ranger dans un coffre puis supprimer) :
  BOOTSTRAP_API_KEY=$BOOTSTRAP_API_KEY
  curl -X POST $PUBLIC_URL/v1/payments -H "authorization: Bearer $BOOTSTRAP_API_KEY" …
Prochaines étapes : docs/production-checklist.md (domaine, mentions légales société, sandbox Stripe, uptime externe).
EOF
