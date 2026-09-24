FROM mcr.microsoft.com/playwright:v1.60.0-jammy

# pandoc for Markdown -> HTML (the PDF path renders that via Playwright).
# ffmpeg for the five-second ad renderer: it encodes the compositor's PNG frames
# into the MP4 renditions and packages them as fMP4 HLS, and ffprobe is what
# validation decodes to count frames. Both binaries must exist or every video
# render job fails at the first spawn.
RUN apt-get update \
  && apt-get install -y --no-install-recommends pandoc ffmpeg \
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
