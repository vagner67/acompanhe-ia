/**
 * Compartilhado (plano.md §7) — dispatcher de alertas e jobs.
 * Cenários com dados realistas; dedupe prova que alerta repetido NÃO spamma.
 */
import { describe, expect, it } from "vitest";

import {
  InMemoryAlertSink,
  alertDedupeKey,
  jobPollProcessos,
  jobVencimentoParcelas,
  jobMatchExpirando,
} from "../src/jobs/dispatcher.js";

describe("dispatcher — dedupe por (user|kind|ref|janela)", () => {
  it("mesma janela = 1 alerta; janela nova = novo alerta", async () => {
    const sink = new InMemoryAlertSink();
    const a = { userId: "u1", kind: "prazo_inscricao" as const, refId: "contest:x", detail: "faltam 7d", dedupeKey: alertDedupeKey("u1", "prazo_inscricao", "contest:x", "2026-11-01") };
    expect((await sink.emit(a)).inserted).toBe(true);
    expect((await sink.emit(a)).inserted).toBe(false); // spam bloqueado
    expect((await sink.emit({ ...a, dedupeKey: alertDedupeKey("u1", "prazo_inscricao", "contest:x", "2026-11-02") })).inserted).toBe(true);
    expect(await sink.list("u1")).toHaveLength(2);
  });
});

describe("jobPollProcessos (RB4) — 1 alerta consolidado por usuário-tribunal/janela", () => {
  it("5 movimentos de 3 processos = 1 alerta para u1/tjmt; outro usuário = outro alerta", async () => {
    const sink = new InMemoryAlertSink();
    const n = await jobPollProcessos(
      sink,
      [
        { userId: "u1", tribunal: "tjmt", numeroProcesso: "p1", total: 2 },
        { userId: "u1", tribunal: "tjmt", numeroProcesso: "p2", total: 3 },
        { userId: "u2", tribunal: "tjmt", numeroProcesso: "p3", total: 1 },
        { userId: "u1", tribunal: "tjrj", numeroProcesso: "p4", total: 4 },
      ],
      "2026-10-23T12:00:00.000Z",
    );
    expect(n).toBe(3); // u1/tjmt, u2/tjmt, u1/tjrj
    const alertsU1 = await sink.list("u1", "novo_movimento");
    expect(alertsU1).toHaveLength(2);
    const tjmt = alertsU1.find((a) => a.refId === "tjmt")!;
    expect(tjmt.detail).toContain("5"); // 2+3 consolidado

    // mesma janela rodando de novo → 0 novos
    const n2 = await jobPollProcessos(sink, [{ userId: "u1", tribunal: "tjmt", numeroProcesso: "p1", total: 9 }], "2026-10-23T12:00:00.000Z");
    expect(n2).toBe(0);
  });
});

describe("jobVencimentoParcelas (RF-E05) — alerta aos DOIS lados, 1× por vencimento", () => {
  it("devedor E credor recebem; repetição não spamma", async () => {
    const sink = new InMemoryAlertSink();
    const parcelas = [{ matchId: "lm1", devedorId: "d1", credorId: "c1", vencimento: "2026-11-23", valorCents: 17_853 }];
    expect(await jobVencimentoParcelas(sink, parcelas)).toBe(2);
    expect(await jobVencimentoParcelas(sink, parcelas)).toBe(0);
    expect(await sink.list("d1", "vencimento_parcela")).toHaveLength(1);
    expect(await sink.list("c1", "vencimento_parcela")).toHaveLength(1);
  });
});

describe("jobMatchExpirando (doc 03 §3.3) — aviso faltando ≤6h", () => {
  it("faltando 2h → alerta; faltando 10h → não; expirado → não", async () => {
    const sink = new InMemoryAlertSink();
    const agora = "2026-10-23T18:00:00.000Z";
    const n = await jobMatchExpirando(
      sink,
      [
        { id: "m1", userId: "u1", expiraEm: "2026-10-23T20:00:00.000Z" }, // 2h
        { id: "m2", userId: "u1", expiraEm: "2026-10-24T04:00:00.000Z" }, // 10h
        { id: "m3", userId: "u1", expiraEm: "2026-10-23T17:00:00.000Z" }, // já expirou
      ],
      agora,
    );
    expect(n).toBe(1);
    const alerts = await sink.list("u1", "match_expirando");
    expect(alerts[0]!.refId).toBe("m1");
    expect(alerts[0]!.detail).toContain("min");
  });
});
