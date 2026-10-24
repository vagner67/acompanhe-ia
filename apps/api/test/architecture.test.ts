/**
 * Regras de arquitetura de docs/arquitetura.md — checadas a cada `vitest run`
 * para um refactor não poder violá-las silenciosamente.
 * Mecanismo adaptado de tgstack (apps/server/test/architecture.spec.ts, MIT):
 * varre as fontes, parseia imports e falha com o par arquivo → alvo.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

function sourceFiles(dir: string): string[] {
  if (!readdirSyncExists(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    if (["node_modules", "dist", "generated", ".git"].includes(entry)) return [];
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts") ? [full] : [];
  });
}
function readdirSyncExists(dir: string): boolean {
  try {
    statSync(dir);
    return true;
  } catch {
    return false;
  }
}

/** Especificadores de import de um arquivo: `from "x"`, `import("x")`, `import "x"`. */
function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1] ?? "");
}

const rel = (file: string) => path.relative(repoRoot, file).split(path.sep).join("/");
const filesIn = (dir: string) => sourceFiles(path.join(repoRoot, dir));

describe("limites de pacote (docs/arquitetura.md §Pacotes)", () => {
  it("packages/shared é isomórfico: só zod e imports relativos (roda no navegador)", () => {
    const offenders = filesIn("packages/shared/src").flatMap((file) =>
      importsOf(file)
        .filter((spec) => !spec.startsWith(".") && spec !== "zod")
        .map((spec) => `${rel(file)} → ${spec}`),
    );
    expect(offenders).toEqual([]);
  });

  it("apps/web nunca importa apps/api nem packages/db (front não toca no servidor/banco)", () => {
    const offenders = filesIn("apps/web/src").flatMap((file) =>
      importsOf(file)
        .filter((spec) => spec.includes("apps/api") || spec.includes("@acompanhe/db"))
        .map((spec) => `${rel(file)} → ${spec}`),
    );
    expect(offenders).toEqual([]);
  });

  it("domínio é framework-free: service.ts e jobs/ não importam fastify (routes.ts pode)", () => {
    const domain = [
      ...filesIn("apps/api/src/gamificacao"),
      ...filesIn("apps/api/src/minhas"),
      ...filesIn("apps/api/src/assinaturas"),
      ...filesIn("apps/api/src/admin"),
      ...filesIn("apps/api/src/jobs"),
      ...filesIn("apps/api/src/emprestimos"),
    ].filter((f) => !rel(f).endsWith("routes.ts") && !rel(f).includes("/routes/"));
    const offenders = domain.flatMap((file) =>
      importsOf(file)
        .filter((spec) => spec.includes("fastify"))
        .map((spec) => `${rel(file)} → ${spec}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe("valores compartilhados (docs/arquitetura.md §Constants)", () => {
  const XP_LITERALS = [
    "nota_criada",
    "gasto_criado",
    "login_diario",
    "filtro_salvo",
    "proposta_emprestimo",
    "caso_investiga",
    "consulta_juridica",
    "sync_manual",
    "verificacao_enviada",
    "assinatura_ativa",
  ];

  it("literais de ação de XP existem SÓ em packages/shared/src/constants.ts", () => {
    const scanDirs = ["apps/api/src", "apps/web/src", "packages/shared/src", "apps/api/test", "apps/web/src"];
    const offenders: string[] = [];
    for (const dir of [...new Set(scanDirs)]) {
      for (const file of filesIn(dir)) {
        if (rel(file).endsWith("packages/shared/src/constants.ts")) continue;
        if (rel(file).endsWith("architecture.test.ts")) continue; // este arquivo é a régua
        const src = readFileSync(file, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
        for (const lit of XP_LITERALS) {
          if (src.includes(`"${lit}"`) || src.includes(`'${lit}'`)) offenders.push(`${rel(file)} → "${lit}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("dois processos, um codebase (docs/arquitetura.md §Worker)", () => {
  it("a API nunca importa o worker; o worker nunca chama listen", () => {
    const server = readFileSync(path.join(repoRoot, "apps/api/src/server.ts"), "utf8");
    expect(server).not.toMatch(/from ["']\.\/worker/);
    expect(server).not.toMatch(/jobs\/runner/);
    const worker = readFileSync(path.join(repoRoot, "apps/api/src/worker.ts"), "utf8");
    expect(worker).not.toMatch(/\.listen\(/);
    expect(worker).not.toMatch(/buildApp/);
  });
});

describe("namespaces HTTP (docs/arquitetura.md §HTTP)", () => {
  const REG = /app\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g;
  const ALLOWED = [/^\/api\//, /^\/v1\//, /^\/health$/];

  it("toda rota vive sob /api, /v1 ou /health", () => {
    const offenders: string[] = [];
    for (const file of filesIn("apps/api/src")) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(REG)) {
        const url = m[2] ?? "";
        if (!ALLOWED.some((re) => re.test(url))) offenders.push(`${rel(file)} → ${url}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("rotas do painel do administrador só sob /v1/admin (painel FORA do mini-app)", () => {
    const src = readFileSync(path.join(repoRoot, "apps/api/src/routes/admin.ts"), "utf8");
    const urls = [...src.matchAll(REG)].map((m) => m[2] ?? "");
    const offenders = urls.filter((u) => !u.startsWith("/v1/admin"));
    expect(offenders).toEqual([]);
  });
});
