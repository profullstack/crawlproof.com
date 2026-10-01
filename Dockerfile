# CrawlProof — single-container image for Railway.
# Runs both the Next.js app (PORT, exposed to the internet) and the audit
# worker (WORKER_PORT, listening on localhost only). Includes Chromium for
# Playwright rendering + pandoc for Markdown -> HTML conversion.

# Bun is the package manager and the runtime for BOTH processes (Next standalone
# server and the audit worker). The runtime stays on the Playwright image for
# Chromium, fonts, pandoc and ffmpeg; the Bun binary is copied onto it. Node is
# still present in that base image, which keeps dev2's compose healthcheck
# (`node -e fetch(...)`) working unchanged.
FROM oven/bun:1.4.2-slim AS bun

# ---------- builder ----------
FROM oven/bun:1.4.2-slim AS builder
# git: @profullstack/autoblog is a GitHub dependency.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Build-time args for NEXT_PUBLIC_* values — Next.js inlines these into the
# client bundle at build time, so they must be present when `next build` runs.
# Railway exposes service env vars to the build whenever they're declared as
# ARG below.
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
ENV NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL}
ENV NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL}
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY}
ENV NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=${NEXT_SERVER_ACTIONS_ENCRYPTION_KEY}

# App + worker deps share lib/audit, so install both.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY worker/package.json worker/bun.lock ./worker/
RUN cd worker && bun install --frozen-lockfile

COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
# `bun --bun next build`: Next builds on Bun.
RUN bun run build

# ---------- runtime ----------
# Playwright base — ships Chromium + system fonts + the deps Chromium needs.
FROM mcr.microsoft.com/playwright:v1.60.0-jammy AS runtime
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app

# pandoc for canonical Markdown -> HTML conversion in the worker.
#
# ffmpeg for the five-second ad renderer, which runs in the worker half of this
# same container: it encodes the compositor's PNG frames into the MP4
# renditions and packages them as fMP4 HLS, and ffprobe is what validation
# decodes to count frames. worker/Dockerfile installs these too, but that image
# is only built when the worker runs as its own Railway service — on this
# project the worker is colocated with the app and THIS is the image that ships,
# so leaving it out here means every render job dies at the first spawn.
RUN apt-get update \
  && apt-get install -y --no-install-recommends pandoc tini ffmpeg \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
# Railway sets PORT (often 8080); worker uses a separate in-container port.
ENV WORKER_PORT=9080
ENV HOSTNAME=0.0.0.0
# Worker -> app talks over loopback inside the container.
ENV WORKER_URL=http://127.0.0.1:9080

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
