# Next.js production image for Railway.
# Uses `output: "standalone"` from next.config.ts to keep the runtime small.

# ---------- builder ----------
FROM node:20-alpine AS builder
WORKDIR /app

# Native deps used by some optional packages.
RUN apk add --no-cache libc6-compat

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---------- runtime ----------
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 --ingroup nodejs nextjs

# Static + standalone server (output: 'standalone' from next.config.ts).
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
