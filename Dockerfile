FROM node:24-slim

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

RUN mkdir -p /app/data /app/auth

EXPOSE 3000

CMD ["pnpm", "start"]
