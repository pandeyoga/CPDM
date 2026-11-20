# Bot CP Live. Build: docker build -t cp-sistem-bot ./bot
FROM node:22-slim AS build
WORKDIR /app
# better-sqlite3 dikompilasi dari sumber bila binari prebuilt tidak tersedia.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Foto acuan untuk `npm run smoke:extract` di VPS.
COPY test/fixtures/screens ./test/fixtures/screens
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "dist/src/server.js"]
