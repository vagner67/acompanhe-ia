# Acompanhe.IA — imagem única: API (Fastify) + worker + bot Python (aiogram)
# Runtime: docker no Render (build na nuvem; não requer docker local)
FROM node:22-bookworm-slim

# Python para o bot (apps/bot usa aiogram/pydantic/python-dotenv)
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv python3-pip curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# pnpm via corepack (imagem própria — sem EROFS, somos root no filesystem do container)
RUN corepack enable

# --- camada de dependências (cache) ---
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

# --- código-fonte ---
COPY . .

# --- build (mesma ordem provada localmente) ---
# find: nenhum tsbuildinfo pode sobreviver (tsc -b confiaria no incremental e pularia emits)
RUN find /app -name "tsconfig.tsbuildinfo" -delete \
 && cd packages/db && pnpm exec prisma generate && pnpm run build \
 && pnpm --filter @acompanhe/shared build \
 && pnpm --filter @acompanhe/api build \
 && pnpm --filter @acompanhe/web build

# --- venv do bot ---
RUN python3 -m venv /opt/botvenv \
 && /opt/botvenv/bin/pip install --no-cache-dir -r apps/bot/requirements.txt

ENV PORT=3000
EXPOSE 3000
CMD ["bash", "deploy/start.sh"]
