FROM oven/bun:1.3.13-alpine

WORKDIR /app

# Instalar curl para health checks y python3 para subprocess gbrain
RUN apk add --no-cache curl python3

COPY package.json bun.lock* package-lock.json* ./
RUN bun install --frozen-lockfile || bun install

COPY index.js ./

ENV NODE_ENV=production
ENV PORT=8765

EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8765/health || exit 1

CMD ["bun", "run", "index.js"]
