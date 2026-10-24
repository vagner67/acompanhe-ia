import { describe, expect, it } from "vitest";
import { InMemoryGameStore, makeGameService, XP_ACTIONS, levelFor, isoWeek } from "../src/gamificacao/service.js";
import { XP } from "@acompanhe/shared";

function fixedNow(dayOffset = 0, hour = 12) {
  return () => new Date(Date.UTC(2026, 9, 23 + dayOffset, hour, 0, 0));
}

describe("gamificação", () => {
  it("XP por ação real, nível e streak", async () => {
    const store = new InMemoryGameStore();
    const svc = makeGameService(store, fixedNow());
    const r = await svc.award("u1", XP.notaCriada);
    expect(r.xpGanho).toBe(XP_ACTIONS.nota_criada);
    expect(r.xpTotal).toBe(5);
    expect(r.streak).toBe(1);
    // dia seguinte → streak 2; antes disso → streak reinicia
    const r2 = await makeGameService(store, fixedNow(1)).award("u1", XP.gastoCriado);
    expect(r2.streak).toBe(2);
    const r3 = await makeGameService(store, fixedNow(40)).award("u1", XP.syncManual);
    expect(r3.streak).toBe(1);
    expect(levelFor(5).level).toBe(1);
    expect(levelFor(120).level).toBe(2);
  });

  it("login_diario vale 1x por dia", async () => {
    const store = new InMemoryGameStore();
    const svc = makeGameService(store, fixedNow());
    const a = await svc.award("u1", XP.loginDiario);
    expect(a.xpGanho).toBe(10);
    const b = await svc.award("u1", XP.loginDiario);
    expect(b.xpGanho).toBe(0);
  });

  it("conquistas: primeira_nota e explorador (3 produtos)", async () => {
    const store = new InMemoryGameStore();
    const s1 = makeGameService(store, fixedNow());
    const r1 = await s1.award("u2", XP.notaCriada);
    expect(r1.novasConquistas).toContain("primeira_nota");
    await s1.award("u2", XP.casoInvestiga);
    const r3 = await s1.award("u2", XP.propostaEmprestimo);
    expect(r3.novasConquistas).toContain("explorador");
    const snap = await s1.snapshot("u2");
    expect(snap.conquistas.map((b) => b.badge)).toContain("primeira_nota");
    expect(snap.catalogoConquistas.length).toBeGreaterThanOrEqual(8);
  });

  it("missão semanal: 5 notas = +30xp ao concluir", async () => {
    const store = new InMemoryGameStore();
    const svc = makeGameService(store, fixedNow());
    for (let i = 0; i < 5; i++) await svc.award("u3", XP.notaCriada);
    const snap = await svc.snapshot("u3");
    const missao = snap.missoes.find((m) => m.code === "m_notas_5");
    expect(missao?.done).toBe(true);
    expect(snap.perfil.xp).toBe(5 * 5 + 30); // 5 notas + bônus da missão
    expect(isoWeek(new Date("2026-10-23T12:00:00Z"))).toMatch(/2026-W/);
  });

  it("ranking é opt-in", async () => {
    const store = new InMemoryGameStore();
    const svc = makeGameService(store, fixedNow());
    await svc.award("u4", XP.syncManual);
    expect((await store.ranking("SP", 10)).length).toBe(0);
    await svc.toggleRanking("u4", true);
    const r = await store.ranking("SP", 10);
    expect(r.length).toBe(1);
    expect(r[0]!.xp).toBeGreaterThan(0);
  });
});
