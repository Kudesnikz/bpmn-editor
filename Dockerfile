FROM node:22-alpine AS build

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.15.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY index.html app.js export.js styles.css vite.config.js tsconfig.server.json ./
COPY src ./src
RUN pnpm build

FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data/diagrams \
    SEED_DIR=/app/seed

WORKDIR /app
RUN addgroup -S bpmn && adduser -S -G bpmn bpmn \
    && mkdir -p /app/seed /data/diagrams \
    && chown -R bpmn:bpmn /app /data/diagrams \
    && corepack enable \
    && corepack prepare pnpm@10.15.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile && pnpm store prune

COPY --from=build --chown=bpmn:bpmn /app/dist ./dist
COPY --chown=bpmn:bpmn diagrams/shop.bpmn diagrams/return.bpmn ./seed/

USER bpmn
EXPOSE 3000
VOLUME ["/data/diagrams"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
