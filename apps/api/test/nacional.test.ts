import { describe, expect, it } from "vitest";
import { classificarVinculo, consultarNacional } from "../src/juridico/nacional.js";
import type { ResultadoEsaj } from "../src/juridico/esaj.js";

const esajOk = (itens: Partial<ResultadoEsaj["itens"][number]>[] = []): ResultadoEsaj =>
  ({
    estado: "resultados",
    itens: itens.map((i) => ({
      numeroProcesso: "0006903-69.2014.8.11.0037",
      uf: "sp",
      classe: "Procedimento Comum",
      foro: "1ª Vara Cível",
      nomeParte: "JOÃO CARLOS DA SILVA",
      dataDistribuicao: "2014-09-12",
      url: "https://esaj.tjsp.jus.br/cpopg/show.do?processo.codigo=abc",
      fonte: "esaj-sp",
      ...i,
    })),
  }) as unknown as ResultadoEsaj;

const esajVazio = { estado: "vazio", itens: [] } as unknown as ResultadoEsaj;
const esajBloqueado = { estado: "bloqueado", itens: [], motivo: "captcha" } as unknown as ResultadoEsaj;
const esajErro = { estado: "erro", itens: [] } as unknown as ResultadoEsaj;

const failFetch = (async () => {
  throw new Error("rede indisponível no teste");
}) as unknown as typeof fetch;

describe("classificarVinculo — por que este processo apareceu", () => {
  it("nome completo idêntico normaliza acento e caixa → 0.8", () => {
    const v = classificarVinculo("joão carlos da silva", "nome", [{ nome: "JOAO CARLOS DA SILVA" }]);
    expect(v.score).toBe(0.8);
    expect(v.motivo).toBe("nome completo idêntico");
  });

  it("nome parcial vale menos que exato", () => {
    const exato = classificarVinculo("João Carlos da Silva", "nome", [{ nome: "João Carlos da Silva" }]).score;
    const parcial = classificarVinculo("João Carlos da Silva", "nome", [{ nome: "João Carlos" }]).score;
    expect(exato).toBeGreaterThan(parcial);
  });

  it("nenhum vínculo → score ZERO, nunca inventa correspondência", () => {
    const v = classificarVinculo("Maria Souza", "nome", [{ nome: "Pedro Lima" }]);
    expect(v.score).toBe(0);
    expect(v.motivo).toContain("nenhum vínculo");
  });

  it("número informado pelo usuário → score máximo", () => {
    expect(classificarVinculo("0006903-69.2014.8.11.0037", "cnj", []).score).toBe(1);
  });
});

describe("Orquestrador nacional", () => {
  it("funde índice + e-SAJ e remove duplicata pelo número de 20 dígitos", async () => {
    const r = await consultarNacional("João Carlos", {
      esaj: async () => esajOk([{}]),
      indice: async () => [
        {
          numeroProcesso: "0006903-69.2014.8.11.0037", // mesmo processo, outra fonte
          tribunal: "TJSP", uf: "SP", partes: [], classe: "Procedimento Comum",
          orgao: null, ultimoMovimento: "Conclusão", dataMovimento: "2026-10-01",
          dataPublicacao: null, link: null, fontes: ["indice"], score: 0.9, motivoVinculo: "indexado",
        },
      ],
      ufs: ["sp"],
      agora: new Date("2026-10-25T12:00:00Z"),
    });
    expect(r.itens).toHaveLength(1);
    expect(r.itens[0]!.fontes.sort()).toEqual(["esaj-sp", "indice"]);
    expect(r.itens[0]!.score).toBe(0.9); // vence o maior score
    expect(r.itens[0]!.motivoVinculo).toBe("indexado"); // motivo acompanha o score vencedor
    expect(r.itens[0]!.ultimoMovimento).toBe("Conclusão"); // campo vazio foi completado
  });

  it("e-SAJ bloqueado aparece no relatório e no aviso — não é escondido", async () => {
    const r = await consultarNacional("João Carlos", {
      esaj: async () => esajBloqueado,
      ufs: ["sp"],
      agora: new Date("2026-10-25T12:00:00Z"),
    });
    const sp = r.fontes.find((f) => f.fonte === "esaj-sp")!;
    expect(sp.estado).toBe("bloqueado");
    expect(r.aviso).toContain("esaj-sp");
  });

  it("fonte que estoura o prazo vira timeout, sem travar a resposta", async () => {
    const r = await consultarNacional("João Carlos", {
      esaj: () => new Promise(() => {}), // nunca resolve
      ufs: ["sp"],
      timeoutMs: 30,
      agora: new Date("2026-10-25T12:00:00Z"),
    });
    expect(r.fontes.find((f) => f.fonte === "esaj-sp")!.estado).toBe("timeout");
    expect(r.msTotal).toBeLessThan(2000);
  });

  it("fonte que lança exceção não derruba a consulta inteira", async () => {
    const r = await consultarNacional("João Carlos", {
      esaj: async () => {
        throw new Error("ENOTFOUND");
      },
      ufs: ["sp", "ac"],
      agora: new Date("2026-10-25T12:00:00Z"),
    });
    const deNome = r.fontes.filter((f) => f.tipo === "esaj");
    expect(deNome).toHaveLength(2);
    expect(deNome.every((f) => f.estado === "timeout" || f.estado === "erro")).toBe(true);
    expect(r.itens).toEqual([]);
  });

  it("DJEN sem relay é declarado 'pulado' com o motivo medido, não finge que buscou", async () => {
    const r = await consultarNacional("João Carlos", {
      esaj: async () => esajVazio,
      ufs: ["sp"],
      agora: new Date("2026-10-25T12:00:00Z"),
    });
    const djen = r.fontes.find((f) => f.fonte === "djen")!;
    expect(djen.estado).toBe("pulado");
    expect(djen.motivo).toContain("403");
  });

  it("DJEN 403 → geo_bloqueado (distinto de erro genérico)", async () => {
    const r = await consultarNacional("João Carlos", {
      esaj: async () => esajVazio,
      ufs: ["sp"],
      djen: (async () => ({ estado: "geo_bloqueado", itens: [], count: 0, motivo: "403 CloudFront" })) as never,
      agora: new Date("2026-10-25T12:00:00Z"),
    });
    expect(r.fontes.find((f) => f.fonte === "djen")!.estado).toBe("geo_bloqueado");
  });

  it("DJEN com itens entra no resultado mesmo sem e-SAJ", async () => {
    const item = {
      id: 1, numeroProcesso: "0006903-69.2014.8.11.0037", tribunal: "TJSP",
      tipoComunicacao: "Intimação", orgao: "1ª Vara", classe: "Procedimento Comum",
      texto: "Intimação", dataDisponibilizacao: "2026-10-20", link: "https://x",
      destinatarios: [{ nome: "João Carlos da Silva", polo: "A" }], advogados: [],
    };
    const r = await consultarNacional("João Carlos", {
      esaj: async () => esajVazio,
      ufs: ["sp"],
      djen: (async () => ({ estado: "ok", itens: [item], count: 1 })) as never,
      agora: new Date("2026-10-25T12:00:00Z"),
    });
    expect(r.itens).toHaveLength(1);
    expect(r.itens[0]!.fontes).toEqual(["djen"]);
    expect(r.itens[0]!.partes[0]!.nome).toBe("João Carlos da Silva");
  });

  it("número de processo vai só para o DJEN (não fan-out por nome)", async () => {
    let chamouEsaj = 0;
    const r = await consultarNacional("0006903-69.2014.8.11.0037", {
      esaj: async () => {
        chamouEsaj++;
        return esajVazio;
      },
      djen: (async () => ({ estado: "sem_resultados", itens: [], count: 0 })) as never,
      agora: new Date("2026-10-25T12:00:00Z"),
    });
    expect(chamouEsaj).toBe(0);
    expect(r.tipo).toBe("cnj");
  });

  it("CPF usa DOCPARTE, não NMPARTE", async () => {
    const campos: string[] = [];
    await consultarNacional("529.982.247-25", {
      esaj: async (_uf, tipo) => {
        campos.push(tipo);
        return esajVazio;
      },
      ufs: ["sp"],
      agora: new Date("2026-10-25T12:00:00Z"),
    });
    expect(campos).toEqual(["DOCPARTE"]);
  });

  it("limite é respeitado e ordenação é por score", async () => {
    const r = await consultarNacional("João Carlos", {
      esaj: async (_uf, _t, _v, _p) => esajOk([{ numeroProcesso: "1" }, { numeroProcesso: "2" }]),
      ufs: ["sp", "ac"],
      limite: 3,
      agora: new Date("2026-10-25T12:00:00Z"),
    });
    expect(r.itens.length).toBeLessThanOrEqual(3);
    const scores = r.itens.map((i) => i.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("rodapé e cobertura acompanham toda resposta", async () => {
    const r = await consultarNacional("João Carlos", { esaj: async () => esajVazio, ufs: ["sp"], agora: new Date() });
    expect(r.rodape.length).toBeGreaterThan(20);
    expect(r.cobertura.nome).toBeGreaterThan(0);
  });

  it("nenhum item e nenhuma fonte bloqueada → aviso neutro (não inventa resultado)", async () => {
    const r = await consultarNacional("Zzzz Ninguém", { esaj: async () => esajVazio, ufs: ["sp"], agora: new Date() });
    expect(r.itens).toEqual([]);
    expect(r.aviso).toBe("Nenhum processo público encontrado nas fontes consultadas.");
  });
});

describe("Frota — matriz 91 × capacidades", () => {
  it("cobre exatamente 91 tribunais e cada um declara as 3 capacidades", async () => {
    const { matrizCobertura, resumoFrota } = await import("../src/juridico/frota.js");
    const m = matrizCobertura();
    expect(m.length).toBe(91);
    for (const t of m) {
      expect(typeof t.numero.ok).toBe("boolean");
      expect(typeof t.nome.ok).toBe("boolean");
      expect(typeof t.cpf.ok).toBe("boolean");
      // toda capacidade marcada ok precisa apontar para a fonte que a cumpre
      if (t.numero.ok) expect(t.numero.fonte).toBeTruthy();
      if (t.nome.ok) expect(t.nome.fonte).toBeTruthy();
      if (t.cpf.ok) expect(t.cpf.fonte).toBeTruthy();
    }
    const r = resumoFrota(m);
    expect(r.tribunais).toBe(91);
    expect(r.nome).toBeGreaterThan(0);
  });

  it("não promete nome onde só há número (STJ não aceita CPF)", async () => {
    const { matrizCobertura } = await import("../src/juridico/frota.js");
    const stj = matrizCobertura().find((t) => t.alias === "stj")!;
    expect(stj.numero.ok).toBe(true); // número existe no DataJud
    expect(stj.cpf.ok).toBe(false); // STJ não aceita CPF/CNPJ
  });

  it("UFs com e-SAJ aberto são as 4 medidas (sp, ac, ...)", async () => {
    const { UFS_ESAJ_ABERTAS } = await import("../src/juridico/frota.js");
    expect(UFS_ESAJ_ABERTAS).toContain("sp");
    expect(UFS_ESAJ_ABERTAS).toContain("ac");
  });
});

describe("Auto-correção — retry de erro transitório do e-SAJ", () => {
  it("primeira tentativa com erro → repete e aproveita a segunda (medido: e-SAJ intermitente)", async () => {
    let chamadas = 0;
    const r = await consultarNacional("João Carlos", {
      esaj: async () => {
        chamadas++;
        return chamadas === 1 ? (esajErro as never) : esajOk([{}]);
      },
      ufs: ["al"],
      agora: new Date("2026-10-25T12:00:00Z"),
    });
    expect(chamadas).toBe(2);
    expect(r.itens).toHaveLength(1);
    expect(r.fontes.find((f) => f.fonte === "esaj-al")!.estado).toBe("ok");
  });

  it("bloqueio e vazio NÃO disparam retry (não martelamos portal que recusou)", async () => {
    let chamadasBloqueio = 0;
    await consultarNacional("João Carlos", {
      esaj: async () => {
        chamadasBloqueio++;
        return esajBloqueado;
      },
      ufs: ["sp"],
      agora: new Date(),
    });
    expect(chamadasBloqueio).toBe(1);

    let chamadasVazio = 0;
    await consultarNacional("João Carlos", {
      esaj: async () => {
        chamadasVazio++;
        return esajVazio;
      },
      ufs: ["sp"],
      agora: new Date(),
    });
    expect(chamadasVazio).toBe(1);
  });

  it("erro persistente em 2 tentativas é declarado como erro (sem loop infinito)", async () => {
    let chamadas = 0;
    const r = await consultarNacional("João Carlos", {
      esaj: async () => {
        chamadas++;
        return esajErro as never;
      },
      ufs: ["ac"],
      agora: new Date(),
    });
    expect(chamadas).toBe(3); // 1 + 2 retries, depois declara erro
    const f = r.fontes.find((x) => x.fonte === "esaj-ac")!;
    expect(f.estado).toBe("erro");
    expect(f.motivo).toContain("3 tentativa");
  });
});
