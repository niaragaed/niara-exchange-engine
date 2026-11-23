# Niara Exchange order service: TESTNET ONLY (no real assets, no real money).
#
# Railway builds this file (it always builds a Dockerfile found at the repository root).
# Settings that are not in this file (healthcheck path, replicas, restart policy,
# variables) are set in the Railway service: see docs/deploy-railway.md.
#
# Run exactly ONE replica: the service holds a Postgres advisory lock that lets only
# one instance serve and settle (docs/deploy-railway.md, "Why exactly one replica").

# Node 22, pinned (>= 22.18 runs the TypeScript sources directly, type stripping).
FROM node:22.23.4-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Production dependencies only, exactly as locked; no install scripts.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# The service reads only src/ (code, the program IDL) and config/ (chain settings and
# the public Supabase root CA). No keys and no .env go into the image: secrets are
# Railway variables (see .dockerignore).
COPY src ./src
COPY config ./config

USER node

# Railway injects PORT; on Railway HOST defaults to 0.0.0.0.
EXPOSE 8787
CMD ["node", "src/service/main.ts"]
