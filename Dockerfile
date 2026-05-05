FROM node:24-slim AS builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY src ./src
COPY tsconfig.json ./

ENV NODE_ENV=production

RUN pnpm build \
  && pnpm prune --prod

FROM node:24-slim AS runner

WORKDIR /app

RUN corepack enable

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

ENV NODE_ENV=production

RUN mkdir -p /app/data /app/data/auth

EXPOSE 3000

CMD ["node", "dist/index.js"]
