# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/bot/package.json apps/bot/package.json
COPY apps/gacha/package.json apps/gacha/package.json
RUN npm ci

COPY apps ./apps
ARG VITE_DISCORD_APPLICATION_ID
ENV VITE_DISCORD_APPLICATION_ID=${VITE_DISCORD_APPLICATION_ID}
RUN npm run gacha:build \
    && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps ./apps

USER node
EXPOSE 6969
CMD ["node", "apps/bot/src/index.js"]
