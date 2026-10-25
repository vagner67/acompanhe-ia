import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { readServiceToken, esquecerServiceToken } from "../src/service-token.js";

/**
 * Este teste existe por causa de uma falha real em produção: o ingest do índice
 * respondia 401 com `x-service-token` correto porque a rota só olhava
 * `process.env.SERVICE_TOKEN`, enquanto o Render entrega o token por
 * SERVICE_TOKEN_FILE (/etc/secrets/servicetokens.json). A leitura agora é única
 * (service-token.ts), usada por ops e pela ingestão.
 */
describe("service-token — leitura única (env ou arquivo)", () => {
  const dir = mkdtempSync(join(tmpdir(), "svctok-"));
  const arquivo = join(dir, "servicetokens.json");

  beforeEach(() => {
    delete process.env.SERVICE_TOKEN;
    delete process.env.SERVICE_TOKEN_FILE;
    esquecerServiceToken();
  });

  afterAll(() => {
    delete process.env.SERVICE_TOKEN;
    delete process.env.SERVICE_TOKEN_FILE;
    esquecerServiceToken();
  });

  it("lê SERVICE_TOKEN do arquivo apontado por SERVICE_TOKEN_FILE (formato do Render)", () => {
    writeFileSync(arquivo, JSON.stringify({ SERVICE_TOKEN: "tok-do-arquivo" }));
    process.env.SERVICE_TOKEN_FILE = arquivo;
    expect(readServiceToken()).toBe("tok-do-arquivo");
  });

  it("cai para process.env.SERVICE_TOKEN quando não há arquivo", () => {
    process.env.SERVICE_TOKEN_FILE = join(dir, "inexistente.json");
    process.env.SERVICE_TOKEN = "tok-do-env";
    expect(readServiceToken()).toBe("tok-do-env");
  });

  it("sem arquivo e sem env devolve null (nunca lança)", () => {
    process.env.SERVICE_TOKEN_FILE = join(dir, "inexistente.json");
    expect(readServiceToken()).toBeNull();
  });

  it("cache de 5s: arquivo novo só é visto depois de esquecerServiceToken()", () => {
    writeFileSync(arquivo, JSON.stringify({ SERVICE_TOKEN: "velho" }));
    process.env.SERVICE_TOKEN_FILE = arquivo;
    expect(readServiceToken()).toBe("velho");
    writeFileSync(arquivo, JSON.stringify({ SERVICE_TOKEN: "novo" }));
    expect(readServiceToken()).toBe("velho"); // cache
    esquecerServiceToken();
    expect(readServiceToken()).toBe("novo"); // rotação vale na hora
  });
});
