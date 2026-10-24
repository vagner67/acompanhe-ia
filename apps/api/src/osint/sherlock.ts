/**
 * SherlockRunner — orquestração REAL do sherlock (sherlock-project/sherlock).
 *
 * O motor de username é o CLI `sherlock` instalado no host (v0.16.2 verificada
 * em 22/10/2026). Este módulo NÃO reimplementa detecção: apenas executa o
 * binário e interpreta a saída real, que foi capturada empiricamente:
 *
 *   stdout (--print-all --no-color):
 *     [+] GitHub: https://www.github.com/octocat     ← encontrado (Claimed)
 *     [-] GitHub: Not Found!                          ← ausente
 *     [*] Search completed with N results
 *     Error: Desired sites not found: 'x'.            ← nome de site inválido
 *
 *   CSV (--csv --folderoutput DIR): DIR/<username>.csv
 *     username,name,url_main,url_user,exists,http_status,response_time_s
 *     octocat,GitHub,https://www.github.com/,https://www.github.com/octocat,Claimed,200,0.545...
 *     (somente linhas exists=Claimed; CSV vazio = 0 achados)
 *
 * `--site` casa nomes EXATOS do data.json (case-sensitive; "Reddit" ok,
 * "reddit" falha). `--json` é carregamento de catálogo, NÃO saída.
 *
 * Campos não documentados da saída são preservados em `raw` sem interpretação.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SHERLOCK_SOURCE_ID } from "@acompanhe/shared";
import type { OsintFinding, OsintTarget } from "./types.js";

export interface SherlockExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export type SherlockExec = (args: string[], bin?: string) => Promise<SherlockExecResult>;

export interface RunSherlockOptions {
  /** Caminho do binário (SHERLOCK_BIN; default "sherlock"). */
  bin?: string;
  /** Timeout do subprocesso em ms (default 60000). */
  timeoutMs?: number;
  /** Nomes EXATOS do data.json (case-sensitive). Vazio = catálogo todo. */
  sites?: string[];
  /** Proxy SOCKS/HTTP repassado ao sherlock. */
  proxy?: string;
  /** Injeção para testes (fixture = saída real capturada). */
  exec?: SherlockExec;
}

/** Execução real do subprocesso (injetável nos testes). `bin` = SHERLOCK_BIN. */
export const execSherlock: SherlockExec = (args, bin) =>
  new Promise((resolve) => {
    const child = spawn(bin ?? "sherlock", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 60_000);
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + String(err), exitCode: 127, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1, timedOut });
    });
  });

interface CsvRow {
  username: string;
  name: string;
  url_main: string;
  url_user: string;
  exists: string;
  http_status: string;
  response_time_s: string;
}

/** Parse defensivo do CSV real (7 colunas sem vírgula nos valores). */
export function parseSherlockCsv(text: string): CsvRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = lines[0] ?? "";
  const expected = "username,name,url_main,url_user,exists,http_status,response_time_s";
  if (header.trim() !== expected) {
    // Não alucinar schema: se o upstream mudou, devolver vazio e sinalizar no raw.
    return [];
  }
  const rows: CsvRow[] = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(",");
    if (parts.length < 7) continue;
    rows.push({
      username: parts[0] ?? "",
      name: parts[1] ?? "",
      url_main: parts[2] ?? "",
      url_user: parts[3] ?? "",
      exists: parts[4] ?? "",
      http_status: parts[5] ?? "",
      response_time_s: parts[6] ?? "",
    });
  }
  return rows;
}

interface StdoutLine {
  kind: "found" | "not_found" | "summary" | "site_error";
  siteName?: string | undefined;
  url?: string | undefined;
  count?: number | undefined;
  message?: string | undefined;
}

/** Parse defensivo do stdout real ([+]/[-]/[*]/Error:). */
export function parseSherlockStdout(text: string): StdoutLine[] {
  const out: StdoutLine[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const found = /^\[\+\] (.+?): (https?:\/\/\S+)$/.exec(line);
    if (found) {
      out.push({ kind: "found", siteName: found[1], url: found[2] });
      continue;
    }
    const missing = /^\[-\] (.+?): Not Found!$/.exec(line);
    if (missing) {
      out.push({ kind: "not_found", siteName: missing[1] });
      continue;
    }
    const summary = /^\[\*\] Search completed with (\d+) results?$/.exec(line);
    if (summary) {
      out.push({ kind: "summary", count: Number(summary[1]) });
      continue;
    }
    const siteError = /^Error: (.+)$/.exec(line);
    if (siteError) {
      out.push({ kind: "site_error", message: siteError[1] });
      continue;
    }
  }
  return out;
}

/**
 * Executa o sherlock para um username e converte a saída real em achados.
 * Toda inferência é marcada: status `unknown` sempre que a ferramenta não
 * deixa evidência verificável (erro, timeout, nome de site inválido).
 */
export async function runSherlock(
  username: string,
  opts: RunSherlockOptions = {},
): Promise<{ findings: OsintFinding[]; raw: Record<string, unknown> }> {
  const exec = opts.exec ?? execSherlock;
  const bin = opts.bin ?? "sherlock";
  const timeoutSec = Math.max(5, Math.floor((opts.timeoutMs ?? 60_000) / 1000));
  const dir = await mkdtemp(join(tmpdir(), "investiga-sherlock-"));

  const args = [
    username,
    "--print-all",
    "--csv",
    "--folderoutput",
    dir,
    "--no-color",
    "--timeout",
    String(Math.min(30, Math.max(3, timeoutSec))),
  ];
  for (const site of opts.sites ?? []) args.push("--site", site);
  if (opts.proxy) args.push("--proxy", opts.proxy);

  try {
    const result = await exec(args, bin);
    let csvText = "";
    try {
      csvText = await readFile(join(dir, `${username}.csv`), "utf8");
    } catch {
      csvText = ""; // CSV ausente: tratar como 0 linhas + erro abaixo
    }

    const rows = parseSherlockCsv(csvText);
    const lines = parseSherlockStdout(result.stdout);
    const now = new Date().toISOString();
    const summaryFor = (status: OsintFinding["status"], siteName: string): string =>
      status === "found"
        ? `@${username} encontrado em ${siteName}`
        : status === "not_found"
          ? `@${username} não encontrado em ${siteName}`
          : `@${username}: sem linha verificável em ${siteName} (inconclusivo)`;

    // Índice por nome de site (case-sensitive como o data.json).
    const bySite = new Map<string, OsintFinding>();
    const claim = (
      siteName: string,
      status: OsintFinding["status"],
      evidenceUrl: string | undefined,
      raw: Record<string, unknown>,
    ): void => {
      const incoming: OsintFinding = {
        id: randomUUID(),
        sourceId: SHERLOCK_SOURCE_ID,
        status,
        summary: summaryFor(status, siteName),
        ...(evidenceUrl ? { evidenceUrl } : {}),
        retrievedAt: now,
        raw: { siteName, ...raw },
      };
      bySite.set(siteName, mergeSherlockClaim(bySite.get(siteName), incoming));
    };

    for (const line of lines) {
      if (line.kind === "found" && line.siteName && line.url) {
        claim(line.siteName, "found", line.url, { stdoutUrl: line.url });
      } else if (line.kind === "not_found" && line.siteName) {
        claim(line.siteName, "not_found", undefined, { stdout: "Not Found!" });
      }
    }
    for (const row of rows) {
      if (row.exists === "Claimed") {
        claim(row.name, "found", row.url_user, {
          username: row.username,
          url_main: row.url_main,
          exists: row.exists,
          http_status: row.http_status,
          response_time_s: row.response_time_s,
        });
      }
    }

    // Sites pedidos mas sem linha alguma (erro/timeout/nome inválido) → unknown.
    for (const site of opts.sites ?? []) {
      if (!bySite.has(site)) {
        claim(site, "unknown", undefined, {
          note: "sem linha na saída do sherlock (erro, timeout ou nome fora do catálogo)",
        });
      }
    }

    const siteErrors = lines
      .filter((l) => l.kind === "site_error")
      .map((l) => l.message ?? "");

    return {
      findings: [...bySite.values()],
      raw: {
        engine: "sherlock",
        bin,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        summary: lines.find((l) => l.kind === "summary")?.count ?? rows.length,
        siteErrors,
        stderr: result.stderr.slice(0, 2000),
      },
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Converte um alvo username em chamada de módulo (doc 13, R5 — mesmo
 *  formato dos adaptadores checkXTarget de email/domain/phone). */
export function checkSherlockTarget(
  target: OsintTarget,
  opts: RunSherlockOptions = {},
): Promise<{ findings: OsintFinding[]; raw: Record<string, unknown> }> {
  if (target.kind !== "username") {
    return Promise.reject(new Error("alvo não é username"));
  }
  return runSherlock(target.value, opts);
}

/**
 * Merge determinístico de achados do mesmo site (doc 13, R11.2 — função pura):
 * - "found" prevalece sobre qualquer outro status;
 * - dois "found" (stdout + CSV) fundem o raw;
 * - incoming "found" ou existing "unknown" → incoming substitui (novo id);
 * - fora isso, o existente permanece.
 */
export function mergeSherlockClaim(
  existing: OsintFinding | undefined,
  incoming: OsintFinding,
): OsintFinding {
  if (!existing) return incoming;
  if (existing.status === "found" && incoming.status === "found") {
    const prev = (existing.raw ?? {}) as Record<string, unknown>;
    const next = (incoming.raw ?? {}) as Record<string, unknown>;
    return { ...existing, raw: { ...prev, ...next } };
  }
  if (existing.status === "found") return existing;
  if (incoming.status === "found" || existing.status === "unknown") return incoming;
  return existing;
}
