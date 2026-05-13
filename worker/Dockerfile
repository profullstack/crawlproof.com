FROM mcr.microsoft.com/playwright:v1.60.0-jammy

# pandoc for canonical Markdown -> HTML conversion (the PDF path renders this
# via Playwright). A JS-based fallback (`marked`) runs when pandoc is absent.
RUN apt-get update \
  && apt-get install -y --no-install-recommends pandoc \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install root-level deps (engine code lives in /lib/audit).
COPY package.json package-lock.json* /app/repo/
WORKDIR /app/repo
RUN npm install --no-audit --no-fund

# Worker deps
WORKDIR /app/repo/worker
COPY worker/package.json /app/repo/worker/
RUN npm install --no-audit --no-fund

# Copy source.
WORKDIR /app/repo
COPY lib /app/repo/lib
COPY worker /app/repo/worker
COPY tsconfig.json /app/repo/

ENV NODE_ENV=production
EXPOSE 8080

CMD ["npx", "tsx", "/app/repo/worker/index.ts"]
