/**
 * Testes dos módulos OSINT (email/phone/domain/report) — vetores reais:
 * MD5 "test@example.com" = 55502f40dc8b7c769880b10874abc9d0 (calculado em
 * 22/10/2026), MD5 "abc" = 900150983cd24fb0d6963f7d28e17f72 (NIST/FIPS).
 * Fontes HTTP sempre injetadas — nenhum teste depende de rede.
 */
import { describe, it, expect } from "vitest";

import { checkEmail, gravatarHash, localPartCandidates } from "../src/osint/email.js";
import { parsePhone } from "../src/osint/libphone.js";
import { checkPhone } from "../src/osint/phone.js";
import { checkDomain } from "../src/osint/domain.js";
import { buildReport, sha256Hex, canonicalize } from "../src/osint/report.js";
import type { OsintCheck, OsintFinding, OsintTarget } from "../src/osint/types.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("email — Gravatar/HIBP/MX/pivô (fontes reais verificadas)", () => {
  it("md5 normalizado (vetor real)", () => {
    expect(gravatarHash("test@example.com")).toBe("55502f40dc8b7c769880b10874abc9d0");
    expect(gravatarHash("  Test@Example.COM ")).toBe(gravatarHash("test@example.com"));
  });

  it("sem chave HIBP → 'unavailable' explícito, nunca resultado inventado", async () => {
    const seen: string[] = [];
    const res = await checkEmail("fulano@exemplo.com.br", {
      hibpApiKey: undefined,
      fetchFn: async (url) => {
        seen.push(url);
        return new Response(null, { status: 404 });
      },
    });
    const hibp = res.findings.find((f) => f.sourceId === "hibp");
    expect(hibp?.status).toBe("unknown");
    expect((hibp?.raw as { unavailable?: boolean }).unavailable).toBe(true);
    // a URL do HIBP NUNCA é chamada sem chave
    expect(seen.some((u) => u.includes("haveibeenpwned.com"))).toBe(false);
  });

  it("HIBP 200 = achado com lista de vazamentos; 404 = not_found com significado", async () => {
    const resFound = await checkEmail("fulano@exemplo.com.br", {
      hibpApiKey: "0123456789abcdef0123456789abcdef",
      fetchFn: async (url) => {
        if (url.includes("haveibeenpwned.com")) {
          return jsonResponse(200, [{ Name: "ExemploVaz", Title: "Exemplo", BreachDate: "2024-01-01", Domain: "exemplo.com" }]);
        }
        return new Response(null, { status: 404 });
      },
    });
    const hibpFound = resFound.findings.find((f) => f.sourceId === "hibp");
    expect(hibpFound?.status).toBe("found");
    expect(hibpFound?.evidenceUrl).toContain("haveibeenpwned.com/fulano@exemplo.com.br");

    const resMissing = await checkEmail("fulano@exemplo.com.br", {
      hibpApiKey: "0123456789abcdef0123456789abcdef",
      fetchFn: async (url) => {
        if (url.includes("haveibeenpwned.com")) return new Response(null, { status: 404 });
        return new Response(null, { status: 404 });
      },
    });
    const hibpMissing = resMissing.findings.find((f) => f.sourceId === "hibp");
    expect(hibpMissing?.status).toBe("not_found");
    expect((hibpMissing?.raw as { meaning?: string }).meaning).toContain("sem vazamento");
  });

  it("gravatar 404 = not_found; pivô do local-part gera candidatos de username", async () => {
    const res = await checkEmail("joao.silva@exemplo.com", {
      hibpApiKey: undefined,
      fetchFn: async () => new Response(null, { status: 404 }),
    });
    expect(res.findings.find((f) => f.sourceId === "gravatar")?.status).toBe("not_found");
    expect(res.candidates).toContain("joaosilva");
    expect(res.candidates).toContain("joao.silva");
    expect(res.candidates).toContain("jsilva");
  });

  it("e-mail sintaticamente inválido → not_found em email-syntax (curto-circuito honesto)", async () => {
    const res = await checkEmail("não-é-email", { fetchFn: async () => new Response(null, { status: 500 }) });
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]?.sourceId).toBe("email-syntax");
    expect(res.findings[0]?.status).toBe("not_found");
  });
});

describe("phone — google-libphonenumber real", () => {
  it("E.164 BR válido → found com tipo MOBILE", async () => {
    const res = await checkPhone("+55 65 99999-9999", { parse: parsePhone }, "BR");
    const f = res.findings[0];
    expect(f?.status).toBe("found");
    const raw = f?.raw as { e164?: string; type?: string; region?: string };
    expect(raw.e164).toBe("+5565999999999");
    expect(raw.type).toBe("MOBILE");
    expect(raw.region).toBe("BR");
  });

  it("lixo → not_found (não é número válido)", async () => {
    const res = await checkPhone("abc123", { parse: parsePhone }, "BR");
    expect(res.findings[0]?.status).toBe("not_found");
  });
});

describe("domain — RDAP/crt.sh/wayback (endpoints reais verificados)", () => {
  it("RDAP 200 + CT logs + snapshot → found com evidenceUrl; DNS injetado", async () => {
    const res = await checkDomain("exemplo.com.br", {
      fetchFn: async (url) => {
        if (url.includes("rdap.org")) {
          return jsonResponse(200, {
            ldhName: "exemplo.com.br",
            status: ["active"],
            events: [{ eventAction: "registration", eventDate: "2000-01-01T00:00:00Z" }],
            entities: [{ roles: ["registrant"], handle: "X" }],
          });
        }
        if (url.includes("crt.sh")) {
          return jsonResponse(200, [{ name_value: "exemplo.com.br\nwww.exemplo.com.br", not_before: "2024-01-01", not_after: "2025-01-01" }]);
        }
        return jsonResponse(200, { archived_snapshots: { closest: { url: "https://web.archive.org/x", timestamp: "20230101", status: "200" } } });
      },
      resolveNs: async () => ["ns1.exemplo.com.br"],
    });
    const sources = res.findings.map((f) => f.sourceId).sort();
    expect(sources).toEqual(["crtsh", "dns-ns", "rdap", "wayback"]);
    expect(res.findings.every((f) => f.status === "found")).toBe(true);
    expect(res.findings.find((f) => f.sourceId === "rdap")?.evidenceUrl).toBe("https://rdap.org/domain/exemplo.com.br");
  });

  it("RDAP 404 = not_found com significado; erro de rede = unknown (nunca negativo)", async () => {
    const res = await checkDomain("naoexiste.example", {
      fetchFn: async (url) => {
        if (url.includes("rdap.org")) return new Response(null, { status: 404 });
        if (url.includes("crt.sh")) return jsonResponse(200, []);
        return jsonResponse(200, {});
      },
    });
    expect(res.findings.find((f) => f.sourceId === "rdap")?.status).toBe("not_found");

    const resErr = await checkDomain("erro.example", {
      fetchFn: async () => {
        throw new Error("timeout");
      },
    });
    expect(resErr.findings.every((f) => f.status === "unknown")).toBe(true);
  });
});

describe("report — proveniência, veredicto humano e sha256", () => {
  const target: OsintTarget = { kind: "username", value: "octocat" };
  const check: OsintCheck = {
    id: "c1",
    caseId: "case1",
    target,
    legalBasis: "execução de contrato (LGPD art. 7º, V)",
    purpose: "verificação de identidade para onboarding",
    quotaConsumed: 1,
    status: "completed",
    executedAt: "2026-10-22T12:00:00.000Z",
  };
  const findings: OsintFinding[] = [
    { id: "f1", checkId: "c1", sourceId: "sherlock", status: "found", evidenceUrl: "https://www.github.com/octocat", retrievedAt: "2026-10-22T12:00:01.000Z", raw: { siteName: "GitHub" } },
    { id: "f2", checkId: "c1", sourceId: "sherlock", status: "not_found", retrievedAt: "2026-10-22T12:00:01.000Z", raw: { siteName: "Reddit" } },
    { id: "f3", checkId: "c1", sourceId: "hibp", status: "unknown", retrievedAt: "2026-10-22T12:00:02.000Z", raw: { unavailable: true } },
  ];

  it("veredicto é SEMPRE 'LEAD — verificar manualmente'; summary conta por status", () => {
    const report = buildReport({ caseId: "case1", targets: [target], checks: [check], findings });
    expect(report.verdict).toBe("LEAD — verificar manualmente");
    expect(report.summary).toMatchObject({ total: 3, found: 1, notFound: 1, unknown: 1 });
    expect(report.summary.bySource.sherlock).toEqual({ found: 1, notFound: 1, unknown: 0 });
    expect(report.legalNotice.limitations.join(" ")).toContain("LEADS");
  });

  it("sha256 do corpo canônico é estável e muda com o conteúdo", () => {
    const a = buildReport({ caseId: "case1", targets: [target], checks: [check], findings, now: () => "2026-10-22T13:00:00.000Z" });
    const b = buildReport({ caseId: "case1", targets: [target], checks: [check], findings, now: () => "2026-10-22T14:00:00.000Z" });
    expect(a.integrity.sha256).toBe(b.integrity.sha256); // generatedAt fora do corpo
    expect(a.integrity.sha256).toMatch(/^[0-9a-f]{64}$/);
    const c = buildReport({ caseId: "case1", targets: [target], checks: [check], findings: findings.slice(0, 2) });
    expect(c.integrity.sha256).not.toBe(a.integrity.sha256);
  });

  it("canonicalize ordena chaves (hash determinístico entre execuções)", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    // sha256("abc") = ba7816bf... (FIPS 180-2 known answer)
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
