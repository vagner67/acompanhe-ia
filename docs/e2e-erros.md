# Erros E2E — 2026-10-24T20:57:29.224Z

### TC-B02 — botão WebApp no chat do usuário (requer /start dele)
- Severidade: S2
- Repro: runner E2E (node tools/e2e/run-e2e.mjs), caso TC-B02
- Atual: sem chat iniciado ainda (Bad Request: user not found) — usuário precisa enviar /start
- Evidência: saída do runner anexada em docs/relatorio-e2e.md
- Suspeita de causa: (análise após leitura do código — ver seção de correções)
- Status: aberto
