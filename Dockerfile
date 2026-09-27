# labbook: one image, the Fastify API serving the built React app.
# Built for linux/arm64 on the kw BuildKit or the arc-azrtydxb-publish runners (no emulation).
#
# NPM_REGISTRY points npm at the Nexus proxy in CI. BuildKit does not carry the cluster CA,
# hence strict-ssl off for that registry only (docs/nexus-endpoints.md in internal-lab).
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ARG NPM_REGISTRY=
COPY package.json package-lock.json ./
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY" && npm config set strict-ssl false; fi \
 && npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
RUN npm run build

FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
ARG NPM_REGISTRY=
COPY package.json package-lock.json ./
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY" && npm config set strict-ssl false; fi \
 && npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

FROM ${NODE_IMAGE}
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY client ./client
USER node
EXPOSE 8080
CMD ["node", "dist/server/index.js"]
