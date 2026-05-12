# CrawlProof — single-container image for Railway.
# Runs both the Next.js app (PORT, exposed to the internet) and the audit
# worker (WORKER_PORT, listening on localhost only). Includes Chromium for
# Playwright rendering + pandoc for Markdown -> HTML conversion.

# ---------- builder ----------
FROM node:20-bullseye AS builder
WORKDIR /app

# App + worker deps share lib/audit, so install both.
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY worker/package.json ./worker/package.json
RUN cd worker && npm install --no-audit --no-fund

COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---------- runtime ----------
# Playwright base — ships Chromium + system fonts + the deps Chromium needs.
FROM mcr.microsoft.com/playwright:v1.48.0-jammy AS runtime
WORKDIR /app

# pandoc for canonical Markdown -> HTML conversion in the worker.
RUN apt-get update \
  && apt-get install -y --no-install-recommends pandoc tini \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV WORKER_PORT=8080
ENV HOSTNAME=0.0.0.0
# Worker -> app talks over loopback inside the container.
ENV WORKER_URL=http://127.0.0.1:8080

# Standalone Next.js output (output: 'standalone' in next.config.ts).
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Worker source + its own deps + shared engine code under lib/.
COPY --from=builder /app/worker ./worker
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/node_modules ./node_modules

# Process supervisor: starts both, forwards signals, exits when either dies.
COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/start.sh"]
