FROM node:24-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /app

RUN corepack enable

FROM base AS deps

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml ./

RUN pnpm config set store-dir /pnpm/store \
  && pnpm fetch --frozen-lockfile

RUN pnpm install --frozen-lockfile --offline

FROM deps AS builder

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production

RUN pnpm build \
  && pnpm prune --prod

FROM node:24-slim AS runner

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

ENV NODE_ENV=production

RUN mkdir -p /app/data /app/data/auth

EXPOSE 3000

CMD ["node", "dist/index.js"]
