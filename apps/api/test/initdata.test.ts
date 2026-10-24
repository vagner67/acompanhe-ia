import { describe, it, expect } from "vitest";
import { verifyTelegramInitData, signInitData } from "../src/security/telegram-initdata.js";

const BOT = "123456789:TEST_TOKEN_AAA-BBB";
const NOW = 1_800_000_000;

function baseFields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    auth_date: String(NOW - 10),
    query_id: "AAH-test",
    user: JSON.stringify({ id: 42, first_name: "Maria", username: "maria" }),
    ...overrides,
  };
}

describe("verifyTelegramInitData (doc 02 §3)", () => {
  it("aceita initData assinado corretamente", () => {
    const initData = signInitData(baseFields(), BOT);
    const res = verifyTelegramInitData(initData, BOT, { maxAgeSec: 300, nowSec: NOW });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.user?.id).toBe(42);
      expect(res.user?.username).toBe("maria");
    }
  });

  it("rejeita hash adulterado (constante ou campo)", () => {
    const initData = signInitData(baseFields(), BOT);
    const tampered = initData.replace(/hash=[0-9a-f]{6}/, "hash=ffffff");
    const res = verifyTelegramInitData(tampered, BOT, { maxAgeSec: 300, nowSec: NOW });
    expect(res).toEqual({ ok: false, reason: "bad_hash" });
  });

  it("rejeita assinatura feita com outro bot_token", () => {
    const initData = signInitData(baseFields(), "999:OTHER_TOKEN");
    const res = verifyTelegramInitData(initData, BOT, { maxAgeSec: 300, nowSec: NOW });
    expect(res).toEqual({ ok: false, reason: "bad_hash" });
  });

  it("rejeita replay fora da janela financeira (300 s)", () => {
    const initData = signInitData(baseFields({ auth_date: String(NOW - 301) }), BOT);
    const res = verifyTelegramInitData(initData, BOT, { maxAgeSec: 300, nowSec: NOW });
    expect(res).toEqual({ ok: false, reason: "expired_auth_date" });
  });

  it("rejeita replay fora da janela de login (24 h) mas aceita dentro dela", () => {
    const old = signInitData(baseFields({ auth_date: String(NOW - 86_401) }), BOT);
    expect(verifyTelegramInitData(old, BOT, { maxAgeSec: 86_400, nowSec: NOW })).toEqual({
      ok: false,
      reason: "expired_auth_date",
    });
    const ok = signInitData(baseFields({ auth_date: String(NOW - 86_000) }), BOT);
    expect(verifyTelegramInitData(ok, BOT, { maxAgeSec: 86_400, nowSec: NOW }).ok).toBe(true);
  });

  it("rejeita initData sem hash ou sem auth_date", () => {
    expect(verifyTelegramInitData("user=%7B%22id%22%3A1%7D", BOT, { maxAgeSec: 300, nowSec: NOW })).toEqual({
      ok: false,
      reason: "missing_hash",
    });
    const noAuth = signInitData({ user: JSON.stringify({ id: 1, first_name: "A" }) }, BOT);
    // signInitData inclui só o que recebeu — sem auth_date a verificação falha
    const res = verifyTelegramInitData(noAuth, BOT, { maxAgeSec: 300, nowSec: NOW });
    expect(res.ok).toBe(false);
  });

  it("funciona com caracteres UTF-8 (nome acentuado)", () => {
    const initData = signInitData(baseFields({ user: JSON.stringify({ id: 7, first_name: "José da Conceição" }) }), BOT);
    const res = verifyTelegramInitData(initData, BOT, { maxAgeSec: 300, nowSec: NOW });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.user?.first_name).toBe("José da Conceição");
  });
});
