/**
 * Testes do SherlockRunner — fixture = SAÍDA REAL capturada em 22/10/2026
 * (sherlock v0.16.2 instalado; `sherlock octocat --site GitHub --site Medium
 * --csv --folderoutput ...` e `--print-all` para o caso negativo).
 * Nenhum valor de fixture foi inventado.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  mergeSherlockClaim,
  parseSherlockCsv,
  parseSherlockStdout,
  runSherlock,
  type SherlockExec,
} from "../src/osint/sherlock.js";
import type { OsintFinding } from "../src/osint/types.js";
import {
  REAL_CSV_FOUND_2 as REAL_CSV,
  REAL_CSV_NONE,
  REAL_STDOUT_FOUND_2 as REAL_STDOUT_FOUND,
  REAL_STDOUT_NONE,
} from "./fixtures/sherlock-capture.js";

describe("parseSherlockCsv (schema real verificado)", () => {
  it("linhas Claimed viram registros com as 7 colunas reais", () => {
    const rows = parseSherlockCsv(REAL_CSV);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      username: "octocat",
      name: "GitHub",
      url_main: "https://www.github.com/",
      url_user: "https://www.github.com/octocat",
      exists: "Claimed",
      http_status: "200",
      response_time_s: "0.5454852370000935",
    });
  });
  it("CSV vazio (só header) = 0 achados — nunca erro", () => {
    expect(parseSherlockCsv(REAL_CSV_NONE)).toEqual([]);
  });
  it("header desconhecido → vazio (não alucinar schema novo)", () => {
    expect(parseSherlockCsv("a,b,c\n1,2,3\n")).toEqual([]);
  });
});

describe("parseSherlockStdout (formato real [+]/[-]/[*]/Error:)", () => {
  it("achados e resumo", () => {
    const lines = parseSherlockStdout(REAL_STDOUT_FOUND);
    expect(lines.filter((l) => l.kind === "found")).toHaveLength(2);
    expect(lines.find((l) => l.kind === "summary")?.count).toBe(2);
  });
  it("Not Found! vira not_found; Error: vira site_error", () => {
    const lines = parseSherlockStdout(REAL_STDOUT_NONE + "Error: Desired sites not found: 'reddit'.\n");
    expect(lines.find((l) => l.kind === "not_found")?.siteName).toBe("GitHub");
    expect(lines.find((l) => l.kind === "site_error")?.message).toBe("Desired sites not found: 'reddit'.");
  });
});

describe("runSherlock (orquestração + classificação)", () => {
  function fakeExec(stdout: string, csv: string): SherlockExec {
    return async (args) => {
      // Escreve o CSV no folderoutput exatamente como o binário real faria.
      const folderIdx = args.indexOf("--folderoutput");
      const dir = args[folderIdx + 1] ?? tmpdir();
      const user = args[0] ?? "user";
      await writeFile(join(dir, `${user}.csv`), csv, "utf8");
      return { stdout, stderr: "", exitCode: 0, timedOut: false };
    };
  }

  it("encontrados (Claimed) → findings found com evidenceUrl real", async () => {
    const { findings, raw } = await runSherlock("octocat", {
      sites: ["GitHub", "Medium"],
      exec: fakeExec(REAL_STDOUT_FOUND, REAL_CSV),
    });
    const gh = findings.find((f) => (f.raw as { siteName?: string }).siteName === "GitHub");
    expect(gh?.status).toBe("found");
    expect(gh?.evidenceUrl).toBe("https://www.github.com/octocat");
    expect(gh?.sourceId).toBe("sherlock");
    expect(gh?.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(raw.summary).toBe(2);
  });

  it("ausente → not_found; site pedido sem linha → unknown (nunca inventar)", async () => {
    const { findings } = await runSherlock("zzznobodyzzz99x", {
      sites: ["GitHub", "Reddit"],
      exec: fakeExec(REAL_STDOUT_NONE, REAL_CSV_NONE),
    });
    expect(findings.find((f) => (f.raw as { siteName?: string }).siteName === "GitHub")?.status).toBe("not_found");
    expect(findings.find((f) => (f.raw as { siteName?: string }).siteName === "Reddit")?.status).toBe("unknown");
  });

  it("preserva raw sem interpretar (http_status, response_time_s)", async () => {
    const { findings } = await runSherlock("octocat", {
      sites: ["GitHub"],
      exec: fakeExec(REAL_STDOUT_FOUND, REAL_CSV),
    });
    const gh = findings.find((f) => (f.raw as { siteName?: string }).siteName === "GitHub");
    const raw = gh?.raw as Record<string, unknown>;
    expect(raw.http_status).toBe("200");
    expect(raw.exists).toBe("Claimed");
    expect(raw.response_time_s).toBe("0.5454852370000935");
  });

  it("repassa `bin` (SHERLOCK_BIN) ao exec — regressão do spawn fixo", async () => {
    let seenBin: string | undefined;
    const spy: SherlockExec = async (args, bin) => {
      seenBin = bin;
      const folderIdx = args.indexOf("--folderoutput");
      const dir = args[folderIdx + 1] ?? tmpdir();
      const user = args[0] ?? "user";
      await writeFile(join(dir, `${user}.csv`), REAL_CSV, "utf8");
      return { stdout: REAL_STDOUT_FOUND, stderr: "", exitCode: 0, timedOut: false };
    };
    await runSherlock("octocat", { sites: ["GitHub"], exec: spy, bin: "/opt/sherlock-venv/bin/sherlock" });
    expect(seenBin).toBe("/opt/sherlock-venv/bin/sherlock");
  });
});

describe("mergeSherlockClaim (doc 13, R11.2 — função pura, 3 ramos)", () => {
  const found = (id: string, extra: Record<string, unknown> = {}): OsintFinding => ({
    id,
    sourceId: "sherlock",
    status: "found",
    retrievedAt: "2026-10-23T10:00:00.000Z",
    raw: { siteName: "GitHub", ...extra },
  });
  const notFound = (id: string): OsintFinding => ({
    id,
    sourceId: "sherlock",
    status: "not_found",
    retrievedAt: "2026-10-23T10:00:00.000Z",
    raw: { siteName: "GitHub" },
  });
  const unknown = (id: string): OsintFinding => ({
    id,
    sourceId: "sherlock",
    status: "unknown",
    retrievedAt: "2026-10-23T10:00:00.000Z",
    raw: { siteName: "GitHub" },
  });

  it("sem existente → incoming", () => {
    expect(mergeSherlockClaim(undefined, found("a"))).toEqual(found("a"));
  });

  it("ramo 1: dois found → funde raw, mantém id do existente", () => {
    const merged = mergeSherlockClaim(found("a", { stdoutUrl: "x" }), found("b", { exists: "Claimed" }));
    expect(merged.id).toBe("a");
    expect(merged.raw).toEqual({ siteName: "GitHub", stdoutUrl: "x", exists: "Claimed" });
  });

  it("ramo 2: existente found + incoming não-found → existente permanece", () => {
    const existing = found("a");
    expect(mergeSherlockClaim(existing, notFound("b"))).toBe(existing);
    expect(mergeSherlockClaim(existing, unknown("c"))).toBe(existing);
  });

  it("ramo 3: incoming found (ou existente unknown) → incoming substitui (novo id)", () => {
    expect(mergeSherlockClaim(notFound("a"), found("b"))).toEqual(found("b"));
    expect(mergeSherlockClaim(unknown("a"), notFound("b"))).toEqual(notFound("b"));
    // borda: not_found + not_found → existente permanece
    expect(mergeSherlockClaim(notFound("a"), notFound("b"))).toEqual(notFound("a"));
  });
});
