# --- Build stage ---
FROM node:20-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# --- Production stage ---
FROM node:20-slim AS production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

ENV NODE_ENV=production

COPY --from=build /app/build ./build
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=build /app/src/lib/server/db ./src/lib/server/db
COPY start.sh ./start.sh
RUN chmod +x ./start.sh

EXPOSE 3000
ENV PORT=3000
# Uploads the portal takes: chat files up to 10 MB, Engagement reels up to
# 20 MB, HR spreadsheets. adapter-node refuses any body over 512 KB otherwise.
ENV BODY_SIZE_LIMIT=26M
ENV HOST=0.0.0.0

CMD ["./start.sh"]
