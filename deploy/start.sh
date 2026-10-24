#!/usr/bin/env bash
# Sobe os 3 processos do Acompanhe.IA num único container (plano free do Render):
#   1) API Fastify  — porta $PORT (Render injeta PORT=10000)
#   2) worker       — entregas de alertas + purge + sync
#   3) bot Telegram — polling (aiogram), TOKEN via env BOT_TOKEN
# Se QUALQUER processo cair, o container inteiro sai e o Render reinicia (supervisão do plano).
set -uo pipefail

echo "[start] aguardando DATABASE_URL..."
if [ -z "${DATABASE_URL:-}" ]; then
  echo "[start] FATAL: DATABASE_URL ausente"; exit 1
fi

echo "[start] prisma db push (schema → banco)"
cd /app/packages/db
if ! npx prisma db push --skip-generate 2>&1 | tail -3; then
  echo "[start] FATAL: db push falhou"; exit 1
fi

cd /app/apps/api
node dist/server.js &
API_PID=$!
node dist/worker.js &
WORKER_PID=$!

/opt/botvenv/bin/python /app/apps/bot/bot/main.py &
BOT_PID=$!

echo "[start] api=$API_PID worker=$WORKER_PID bot=$BOT_PID — no ar (porta ${PORT:-3000})"

# Espera o primeiro que cair; derruba o resto para o Render reiniciar o container limpo.
wait -n $API_PID $WORKER_PID $BOT_PID
EC=$?
echo "[start] processo filho saiu com código $EC — derrubando container para restart"
kill $API_PID $WORKER_PID $BOT_PID 2>/dev/null
exit 1
