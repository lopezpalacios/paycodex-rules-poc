FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json .npmrc ./
RUN npm ci --legacy-peer-deps --omit=dev || npm ci --legacy-peer-deps

COPY scripts ./scripts
COPY data ./data
COPY .deployments ./.deployments

FROM node:20-alpine AS runtime

RUN addgroup -S paycodex && adduser -S paycodex -G paycodex

WORKDIR /app
COPY --from=builder /app /app

USER paycodex

ENV NODE_ENV=production \
    PORT=3001 \
    NETWORK=besu \
    WEB3SIGNER_URL=http://web3signer:9000

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3001/api/health || exit 1

CMD ["node", "scripts/server.mjs"]
