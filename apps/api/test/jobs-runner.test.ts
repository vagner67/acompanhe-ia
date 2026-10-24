/**
 * Política de entrega do worker (jobs/runner.ts) — semântica tgstack:
 * rate limit sem rajada · 429 pausa tudo · 403 bloqueia sem retry · 5xx até 3.
 */
import { describe, expect, it } from "vitest";
import {
  deliverPending,
  InMemoryDeliveryQueue,
  type AlertSender,
  type PendingAlert,
  type SendResult,
} from "../src/jobs/runner.js";

function alert(id: string, over: Partial<PendingAlert> = {}): PendingAlert {
  return { id, userId: `u${id}`, chatId: `c${id}`, topic: "prazo_inscricao", detail: "x", channel: "telegram", status: "queued", attempts: 0, ...over };
}

function seqSender(results: SendResult[]): { sender: AlertSender; seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    sender: {
      async send(chatId: string) {
        seen.push(chatId);
        return results.shift() ?? { ok: true };
      },
    },
  };
}

const noSleep = { ...{ ratePerSecond: 1000, maxAttempts: 3, batchLimit: 50, sleep: async () => {} } };

describe("worker de entrega", () => {
  it("entrega, marca delivered e respeita o rate limit sem rajada", async () => {
    const q = new InMemoryDeliveryQueue([alert("1"), alert("2"), alert("3")]);
    const { sender, seen } = seqSender([{ ok: true }, { ok: true }, { ok: true }]);
    const sleeps: number[] = [];
    const s = await deliverPending(q, sender, { ...noSleep, ratePerSecond: 4, sleep: async (ms) => void sleeps.push(ms) });
    expect(s.sent).toBe(3);
    expect(seen).toEqual(["c1", "c2", "c3"]);
    expect(q.alerts.every((a) => a.status === "delivered")).toBe(true);
    // 4/s = intervalo de 250ms entre envios (2 pausas entre 3 envios + 1 final)
    expect(sleeps.every((ms) => ms === 250)).toBe(true);
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
  });

  it("429 pausa a ENTREGA inteira por retry_after e encerra o ciclo", async () => {
    const q = new InMemoryDeliveryQueue([alert("1"), alert("2"), alert("3")]);
    const { sender, seen } = seqSender([
      { ok: true },
      { ok: false, kind: "rate_limited", retryAfterSec: 7 },
      { ok: true },
    ]);
    const s = await deliverPending(q, sender, noSleep);
    expect(s.sent).toBe(1);
    expect(s.pausedForSec).toBe(7);
    expect(seen).toEqual(["c1", "c2"]); // o 3º NÃO foi enviado depois da pausa
    expect(q.alerts.find((a) => a.id === "2")!.status).toBe("queued"); // volta à fila
  });

  it("403 marca blocked sem retry", async () => {
    const q = new InMemoryDeliveryQueue([alert("1")]);
    const { sender } = seqSender([{ ok: false, kind: "blocked" }]);
    const s = await deliverPending(q, sender, noSleep);
    expect(s.blocked).toBe(1);
    expect(q.alerts[0]!.status).toBe("blocked");
    expect(q.alerts[0]!.attempts).toBe(0); // nunca re-tentou
  });

  it("erro retryable tenta até maxAttempts e então falha de vez", async () => {
    const q = new InMemoryDeliveryQueue([alert("1")]);
    const fail: SendResult = { ok: false, kind: "retryable", message: "http_502" };
    // ciclo 1 e 2: guarda tentativa; ciclo 3: estoura o teto
    let s = await deliverPending(q, seqSender([fail]).sender, noSleep);
    expect(s.retried).toBe(1);
    expect(q.alerts[0]!.attempts).toBe(1);
    s = await deliverPending(q, seqSender([fail]).sender, noSleep);
    expect(s.retried).toBe(1);
    s = await deliverPending(q, seqSender([fail]).sender, noSleep);
    expect(s.failed).toBe(1);
    expect(q.alerts[0]!.status).toBe("failed");
  });

  it("4xx (não 403) falha sem retry; sem chatId falha sem chamar o sender", async () => {
    const q = new InMemoryDeliveryQueue([alert("1"), alert("2", { chatId: null })]);
    const { sender, seen } = seqSender([{ ok: false, kind: "client_error", code: 400 }]);
    const s = await deliverPending(q, sender, noSleep);
    expect(s.failed).toBe(2);
    expect(seen).toEqual(["c1"]); // o sem chatId nunca chegou ao sender
    expect(q.alerts.every((a) => a.status === "failed")).toBe(true);
  });
});
