# ESS portal + Postgres + MongoDB + Redis in one image, for Cloudflare Containers.
# Built by wrangler with the repo root as context (see wrangler.jsonc).
# The entrypoint (cloudflare/ess-box.sh) explains how data survives restarts via R2.

# --- Build the app (same as ../Dockerfile) ---
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim AS node

# --- Runtime: the official MongoDB 7 image (Ubuntu 22.04, ships mongod,
# mongosh, mongodump, mongorestore) + Postgres 14 + Redis + AWS CLI for R2 ---
FROM mongo:7 AS production

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      postgresql postgresql-client redis-server awscli ca-certificates util-linux \
 && rm -rf /var/lib/apt/lists/*

# Node 20 from the official image.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

ENV NODE_ENV=production

COPY --from=build /app/build ./build
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=build /app/src/lib/server/db ./src/lib/server/db
COPY start.sh ./start.sh
COPY cloudflare/ess-box.sh /usr/local/bin/ess-box
RUN chmod +x ./start.sh /usr/local/bin/ess-box

EXPOSE 3000
ENV PORT=3000
ENV HOST=0.0.0.0

ENTRYPOINT ["/usr/local/bin/ess-box"]
CMD []
