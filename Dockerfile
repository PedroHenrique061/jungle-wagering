FROM oven/bun:1-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json tsconfig.json ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun scripts ./scripts
USER bun
EXPOSE 3000
# Bun executa TypeScript direto; SIGTERM chega ao processo (exec form) e dispara o graceful shutdown.
CMD ["bun", "run", "src/main.ts"]
