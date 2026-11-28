# Image unique : API (par défaut) ou simulateurs (CMD ["pnpm","sim"]).
FROM node:22.23.5-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# Manifests copiés seuls : l'installation ne dépend pas des sources.
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/modules/package.json packages/modules/
COPY packages/engine/package.json packages/engine/
COPY packages/store-pg/package.json packages/store-pg/
COPY packages/sdk-js/package.json packages/sdk-js/
COPY packages/bridges/package.json packages/bridges/
COPY apps/api/package.json apps/api/
COPY apps/sim/package.json apps/sim/
COPY apps/portal/package.json apps/portal/
COPY packages/mcp/package.json packages/mcp/
COPY packages/terminals/package.json packages/terminals/
COPY packages/ai/package.json packages/ai/
COPY apps/edge/package.json apps/edge/

# Deps de production seulement : ni vitest ni fast-check dans l'image finale.
FROM manifests AS deps
RUN pnpm install --frozen-lockfile --prod

FROM base AS runtime
ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=384
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/apps ./apps
COPY . .
RUN addgroup -S meridian && adduser -S meridian -G meridian && chown -R meridian:meridian /app
USER meridian
# 8080 : API REST + nexo. Pas d'EXPOSE 8888/20007 : les passerelles caisse (Concert, ZVT) sont liées
# sur 127.0.0.1 et ne sortent jamais du réseau privé du magasin — voir infra/fly/api.prod.toml.
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT:-8080}/health || exit 1
CMD ["pnpm", "api"]
