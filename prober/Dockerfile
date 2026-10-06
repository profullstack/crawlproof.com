# CrawlProof port-drift prober (docs/uptime-monitoring-prd.md §12), as run on
# dev2 by .github/workflows/deploy-prober.yml. nmap ships in the image so the
# host needs nothing installed; the scan is -sT (TCP connect), so no root and
# no extra capabilities are needed.
FROM node:20-slim AS build
WORKDIR /prober
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends nmap ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /prober
COPY --from=build /prober/node_modules ./node_modules
COPY --from=build /prober/dist ./dist
COPY package.json ./
USER node
CMD ["node", "dist/index.js"]
