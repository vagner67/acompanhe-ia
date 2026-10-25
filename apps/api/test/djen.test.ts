import { describe, expect, it } from "vitest";
import {
  agruparDjenPorProcesso,
  buscarDjen,
  classificarHttp,
  janelaPadrao,
  mapearItem,
  montarUrlDjen,
  DJEN_TETO_RESULTADOS,
} from "../src/juridico/djen.js";

/**
 * Contrato do DJEN conforme o swagger oficial (cnj/pcp 1.0.0), fixtures com os
 * nomes REAIS dos campos (snake_case) — o erro clássico é procurar camelCase.
 */
const ITEM_REAL = {
  id: 123456789,
  data_disponibilizacao: "2026-10-20",
  siglaTribunal: "tjsp",
  tipoComunicacao: "Intimação",
  nomeOrgao: "1ª Vara Cível - Foro Central",
  texto: "<p>Intimem-se as partes para <b>manifestação</b> em 15 dias.</p>",
  numero_processo: "00069036920148110037",
  meio: "D",
  link: "https://comunica.pje.jus.br/consulta/abc",
  nomeClasse: "Procedimento Comum Cível",
  numeroprocessocommascara: "0006903-69.2014.8.11.0037",
  destinatarios: [
    { nome: "João Carlos da Silva", polo: "A", comunicacao_id: 123456789 },
    { nome: "Município de Cuiabá", polo: "P", comunicacao_id: 123456789 },
  ],
  destinatarioadvogados: [
    { advogado: { nome: "Maria Advogada", numero_oab: "12345", uf_oab: "MT" } },
  ],
};

describe("DJEN — parsing do payload real", () => {
  it("mapeia campos snake_case e normaliza o número para CNJ canônico", () => {
    const p = mapearItem(ITEM_REAL);
    expect(p.numeroProcesso).toBe("0006903-69.2014.8.11.0037");
    expect(p.tribunal).toBe("TJSP");
    expect(p.tipoComunicacao).toBe("Intimação");
    expect(p.destinatarios).toEqual([
      { nome: "João Carlos da Silva", polo: "A" },
      { nome: "Município de Cuiabá", polo: "P" },
    ]);
    expect(p.advogados[0]).toEqual({ nome: "Maria Advogada", oab: "12345", uf: "MT" });
  });

  it("limpa HTML do teor e trunca textos gigantes", () => {
    const p = mapearItem(ITEM_REAL);
    expect(p.texto).toBe("Intimem-se as partes para manifestação em 15 dias.");
    const gigante = mapearItem({ ...ITEM_REAL, texto: "x".repeat(2000) });
    expect(gigante.texto!.length).toBeLessThanOrEqual(600);
    expect(gigante.texto!.endsWith("…")).toBe(true);
  });

  it("não explode com payload incompleto (nunca inventa)", () => {
    const p = mapearItem({});
    expect(p.numeroProcesso).toBeNull();
    expect(p.destinatarios).toEqual([]);
    expect(p.tribunal).toBeNull();
  });

  it("agrupa publicações por processo e ordena a mais recente", () => {
    const a = mapearItem({ ...ITEM_REAL, data_disponibilizacao: "2026-10-01" });
    const b = mapearItem({ ...ITEM_REAL, data_disponibilizacao: "2026-10-20", tipoComunicacao: "Sentença" });
    const c = mapearItem({ ...ITEM_REAL, numero_processo: "00000011120268260100", numeroprocessocommascara: "0000001-11.2026.8.26.0100" });
    const procs = agruparDjenPorProcesso([a, b, c]);
    expect(procs).toHaveLength(2);
    const primeiro = procs.find((p) => p.numeroProcesso === "0006903-69.2014.8.11.0037")!;
    expect(primeiro.publicacoes).toBe(2);
    expect(primeiro.ultimaPublicacao).toBe("2026-10-20");
    expect(primeiro.tipoUltima).toBe("Sentença");
  });
});

describe("DJEN — URL e classificação", () => {
  it("monta a URL com nomeParte sem acento quebrado e itensPorPagina limitado", () => {
    const url = montarUrlDjen({ nomeParte: "João Carlos", numeroProcesso: "0006903-69.2014.8.11.0037", limite: 999 });
    expect(url).toContain("https://comunicaapi.pje.jus.br/api/v1/comunicacao?");
    expect(url).toContain("nomeParte=Jo%C3%A3o+Carlos");
    expect(url).toContain("numeroProcesso=00069036920148110037"); // só dígitos, como a API exige
    expect(url).toContain("itensPorPagina=50"); // teto real da API
  });

  it("relay é prefixado (egress brasileiro) sem alterar o alvo", () => {
    const url = montarUrlDjen({ nomeParte: "Ana" }, { relay: "https://relay-br.exemplo/forward/" });
    expect(url.startsWith("https://relay-br.exemplo/forward/https://comunicaapi.pje.jus.br/api/v1/comunicacao?")).toBe(true);
  });

  it("classifica 403 como geo_bloqueado (não como erro genérico)", () => {
    expect(classificarHttp(200)).toBe("ok");
    expect(classificarHttp(403)).toBe("geo_bloqueado");
    expect(classificarHttp(429)).toBe("rate_limit");
    expect(classificarHttp(503)).toBe("indisponivel");
  });

  it("janela padrão termina hoje e começa 30 dias antes", () => {
    const j = janelaPadrao(new Date("2026-10-25T12:00:00Z"));
    expect(j).toEqual({ de: "2026-09-25", ate: "2026-10-25" });
  });

  it("teto de 10.000 resultados está declarado (corte silencioso do CNJ)", () => {
    expect(DJEN_TETO_RESULTADOS).toBe(10_000);
  });
});

describe("DJEN — busca com fetch injetado (sem rede)", () => {
  const ok = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

  it("200 com items → estado ok e itens mapeados", async () => {
    const r = await buscarDjen({ nomeParte: "João Carlos" }, { fetchImpl: ok({ count: 1, items: [ITEM_REAL] }) });
    expect(r.estado).toBe("ok");
    expect(r.itens).toHaveLength(1);
    expect(r.count).toBe(1);
  });

  it("200 com items vazio → sem_resultados (não é erro)", async () => {
    const r = await buscarDjen({ nomeParte: "Zzz" }, { fetchImpl: ok({ count: 0, items: [] }) });
    expect(r.estado).toBe("sem_resultados");
  });

  it("403 → geo_bloqueado com motivo acionável e sem retry infinito", async () => {
    let chamadas = 0;
    const blocked = (async () => {
      chamadas++;
      return new Response("blocked", { status: 403 });
    }) as unknown as typeof fetch;
    const r = await buscarDjen({ nomeParte: "x" }, { fetchImpl: blocked, retries: 3 });
    expect(r.estado).toBe("geo_bloqueado");
    expect(chamadas).toBe(1); // 403 não melhora com retry
    expect(r.motivo).toContain("egress brasileiro");
  });

  it("503 tenta de novo e desiste com estado honesto", async () => {
    let chamadas = 0;
    const flaky = (async () => {
      chamadas++;
      return new Response("down", { status: 503 });
    }) as unknown as typeof fetch;
    const r = await buscarDjen({ nomeParte: "x" }, { fetchImpl: flaky, retries: 2 });
    expect(chamadas).toBe(3);
    expect(r.estado).toBe("indisponivel");
  });
});
