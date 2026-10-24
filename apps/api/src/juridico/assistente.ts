/**
 * Assistente jurídico — motor de respostas FUNDAMENTADAS (grounded).
 * Princípio anti-alucinação (plano §1): cada frase vem de
 *   (a) dados reais do processo (DataJud/CNJ), (b) tabela oficial de movimentos
 *       do CNJ, (c) glossário curado com base legal citada — e NADA MAIS.
 * O que não estiver em (a)–(c) recebe resposta honestamente negativa + saída
 * para advogado (RF-B07). Toda resposta termina com RODAPE_INFORMATIVO (RF-B08).
 * Motor pluggable: se LLM_API_KEY existir, um provider generativo pode ser
 * plugado aqui sem mudar o contrato; o padrão é grounded (único que não alucina).
 */
import type { LegalCaseDto, LegalEventDto } from "./types.js";
import {
  EXPLICACOES_CLASSE,
  EXPLICACOES_MOVIMENTO,
  IMPACTO_ROTULO,
  SUGESTOES_PADRAO,
  type ExplicacaoMovimento,
} from "./glossario.js";
import { nomeMovimentoCnj } from "./tabela-movimentos.js";
import { RODAPE_INFORMATIVO, SIGILO_MSG } from "./service.js";

export interface PerguntaCtx {
  caso: LegalCaseDto;
  movimentos: LegalEventDto[];
}

export interface RespostaAssistente {
  resposta: string;
  /** De onde veio cada fato (ex.: "DataJud — movimento 51 Conclusão, 25/09/2014"). */
  fontes: string[];
  sugestoes: string[];
  rodape: string;
  /** Intenção detectada (para telemetria/testes). */
  intencao: string;
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function fmtData(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
}

export function fmtBrl(v: number): string {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function ordenados(movimentos: LegalEventDto[]): LegalEventDto[] {
  return [...movimentos].sort((a, b) => (a.dataHora < b.dataHora ? 1 : -1));
}

/** Explicação grounded de um movimento (nome ou código) — nunca inventa. */
export function explicarMovimentoGrounded(nome: string, codigo?: number): ExplicacaoMovimento {
  const peloCodigo = codigo != null ? EXPLICACOES_MOVIMENTO[codigo] : undefined;
  if (peloCodigo) return peloCodigo;
  const chave = norm(nome);
  for (const [cod, exp] of Object.entries(EXPLICACOES_MOVIMENTO)) {
    if (chave.includes(norm(exp.titulo))) return { ...exp };
    void cod;
  }
  // Fora do glossário curado: usa o NOME OFICIAL da tabela CNJ (grounded) e
  // declara honestamente que não há explicação detalhada cadastrada.
  const oficial = codigo != null ? nomeMovimentoCnj(codigo) : null;
  return {
    titulo: nome,
    explicacao:
      (oficial
        ? `Segundo a tabela oficial do CNJ, este movimento é "${oficial}". `
        : `Este movimento é registrado como "${nome}". `) +
      "Não tenho uma explicação detalhada cadastrada para ele — o nome oficial acima é literal da tabela do CNJ. Um advogado pode traduzir o efeito exato no seu caso.",
    impacto: "informativo",
    base: "Tabela de Movimentação Processual do CNJ (Res. 46/2007)",
  };
}

function encontrarMovimento(pergunta: string, movimentos: LegalEventDto[]): LegalEventDto | null {
  const p = norm(pergunta);
  // Menção a data ("último movimento de 2015") ou a um nome de movimento conhecido.
  let melhor: LegalEventDto | null = null;
  for (const m of ordenados(movimentos)) {
    const nome = norm(m.nome);
    if (nome && p.includes(nome)) {
      melhor = m;
      break;
    }
    const exp = explicarMovimentoGrounded(m.nome, m.codigo);
    if (p.includes(norm(exp.titulo)) && !melhor) melhor = m;
  }
  return melhor;
}

/** Resumo em linguagem simples do processo (usado pelo card E pelo chat). */
export function resumoProcesso(ctx: PerguntaCtx): string {
  const { caso, movimentos } = ctx;
  if (caso.nivelSigilo > 0) return SIGILO_MSG;
  const movs = ordenados(movimentos);
  const partes: string[] = [];
  partes.push(
    `Trata-se de uma ${caso.classe.toLowerCase()} tramitando no ${caso.orgaoJulgador} (${caso.tribunal.toUpperCase()}), ajuizada em ${fmtData(caso.dataAjuizamento)}.`,
  );
  if (caso.valorDaCausa != null) partes.push(`O valor da causa é de ${fmtBrl(caso.valorDaCausa)}.`);
  const statusTexto =
    caso.status === "arquivado"
      ? "O processo está ARQUIVADO — em princípio encerrou a tramitação."
      : caso.status === "suspenso"
        ? "O processo está SUSPENSO — não tramita neste momento."
        : caso.status === "ativo"
          ? "O processo está ATIVO e tramitando."
          : "A situação atual não foi identificada nos dados.";
  partes.push(statusTexto);
  if (caso.ultimoMovimento) {
    partes.push(
      `A última movimentação registrada foi "${caso.ultimoMovimento.nome}" em ${fmtData(caso.ultimoMovimento.dataHora)}.`,
    );
  }
  if (movs.length > 1) {
    partes.push(`Há ${movs.length} movimentações registradas desde o início.`);
  }
  return partes.join(" ");
}

type Matcher = { re: RegExp; intencao: string; gerar: (ctx: PerguntaCtx, p: string) => Omit<RespostaAssistente, "rodape" | "sugestoes"> };

function resposta(ctx: PerguntaCtx, intencao: string, texto: string, fontes: string[], sugestoes: string[] = []): RespostaAssistente {
  return { resposta: texto, fontes, sugestoes: sugestoes.length ? sugestoes : SUGESTOES_PADRAO.slice(0, 3), rodape: RODAPE_INFORMATIVO, intencao };
}

/** Comparações de intenção — ordem importa (as mais específicas primeiro). */
const MATCHERS: Matcher[] = [
  {
    re: /\b(ola|oi|bom dia|boa tarde|boa noite|e ai|ajuda|ajude|o que voce faz|como funciona)\b/,
    intencao: "saudacao",
    gerar: (ctx) => ({
      intencao: "saudacao",
      resposta:
        "Olá! Sou o assistente do Acompanhe.IA. Respondo perguntas sobre ESTE processo usando os dados públicos do DataJud/CNJ e a tabela oficial de movimentos — sem inventar nada. Posso resumir o caso, explicar movimentos, citar valores e datas, e apontar o que observar.",
      fontes: ["Assistente Acompanhe.IA (respostas fundamentadas em dados do processo)"],
    }),
  },
  {
    re: /\b(resum\w*|sintetiz\w*|explique o processo|explique o caso|me explique|do que se trata|sobre o que|do que trata|entenda o processo|panorama\w*|visao geral|status geral|como esta o processo|situacao geral)/,
    intencao: "resumo",
    gerar: (ctx) => ({
      intencao: "resumo",
      resposta: resumoProcesso(ctx),
      fontes: ["DataJud/CNJ — dados do processo", `Movimentações registradas: ${ctx.movimentos.length}`],
    }),
  },
  {
    re: /\b(status|situacao\w*|em que pe|em que fase|em andamento|parado|arquivad\w*|suspenso|ativo|terminou|acabou|encerrado|fim do processo|processo acabou)/,
    intencao: "status",
    gerar: (ctx) => {
      const { caso, movimentos } = ctx;
      const movs = ordenados(movimentos);
      const arq = movs.find((m) => /arquivamento|baixa definitiva/i.test(m.nome));
      const susp = movs.find((m) => /suspens/i.test(m.nome));
      const linhas = [
        `Situação identificada nos dados: **${caso.status.toUpperCase()}**.`,
      ];
      if (caso.status === "arquivado" && arq) linhas.push(`O arquivamento foi registrado em ${fmtData(arq.dataHora)} (${arq.nome}).`);
      if (caso.status === "suspenso" && susp) linhas.push(`A suspensão foi registrada em ${fmtData(susp.dataHora)} (${susp.nome}).`);
      if (caso.status === "ativo") {
        linhas.push(
          caso.ultimoMovimento
            ? `Seguindo ativo — o último registro é de ${fmtData(caso.ultimoMovimento.dataHora)} ("${caso.ultimoMovimento.nome}").`
            : "Seguindo ativo.",
        );
      }
      linhas.push("Obs.: a situação é derivada dos movimentos públicos; sigilo ou atraso de atualização do tribunal podem mudar o quadro.");
      return { intencao: "status", resposta: linhas.join(" "), fontes: ["DataJud/CNJ — movimentações do processo"] };
    },
  },
  {
    re: /\b(ultim\w*|mais recente|por ultimo|agora|novidade|novidades|teve moviment\w*|aconteceu alguma|o que houve|o que aconteceu|atualiz\w*)/,
    intencao: "ultimo_movimento",
    gerar: (ctx) => {
      const movs = ordenados(ctx.movimentos);
      const u = movs[0] ?? ctx.caso.ultimoMovimento;
      if (!u) {
        return {
          intencao: "ultimo_movimento",
          resposta: "Ainda não há movimentações registradas nos dados públicos deste processo. Use o botão Sincronizar para buscar as atualizações do DataJud.",
          fontes: ["DataJud/CNJ — sem movimentações registradas"],
        };
      }
      const exp = explicarMovimentoGrounded(u.nome, u.codigo);
      return {
        intencao: "ultimo_movimento",
        resposta: `A última movimentação é "${u.nome}", registrada em ${fmtData(u.dataHora)}. ${exp.explicacao}`,
        fontes: [`DataJud — movimento ${u.codigo} "${u.nome}", ${fmtData(u.dataHora)}`, exp.base],
      };
    },
  },
  {
    re: /\b(moviment\w*|historico|andamento|tramita\w*|timeline|ocorreu|acontecido|lista de atos|autos\b)/,
    intencao: "movimentos",
    gerar: (ctx, p) => {
      const alvo = encontrarMovimento(p, ctx.movimentos);
      if (alvo && /(o que (e|significa|quer dizer)|significa|explica|quer dizer|entender|traduz)/.test(norm(p))) {
        const exp = explicarMovimentoGrounded(alvo.nome, alvo.codigo);
        return {
          intencao: "explicar_movimento",
          resposta: `Sobre "${alvo.nome}" (${fmtData(alvo.dataHora)}): ${exp.explicacao}\n\n${IMPACTO_ROTULO[exp.impacto]}.`,
          fontes: [`DataJud — movimento ${alvo.codigo} "${alvo.nome}", ${fmtData(alvo.dataHora)}`, exp.base],
        };
      }
      const movs = ordenados(ctx.movimentos);
      if (!movs.length) {
        return {
          intencao: "movimentos",
          resposta: "Não há movimentações registradas nos dados públicos deste processo até agora.",
          fontes: ["DataJud/CNJ — sem movimentações"],
        };
      }
      const ultimos = movs.slice(0, 5);
      const linhas = ultimos.map((m) => `• ${fmtData(m.dataHora)} — ${m.nome}`);
      return {
        intencao: "movimentos",
        resposta:
          `O processo tem ${movs.length} movimentação(ões) registrada(s). As ${ultimos.length} mais recentes:\n${linhas.join("\n")}\n\nPergunte "o que significa <movimento>" para eu explicar qualquer uma delas.`,
        fontes: [`DataJud/CNJ — ${movs.length} movimentações`],
      };
    },
  },
  {
    re: /\b(o que e|o que é|significa\w*|quer dizer|explica\w*|traduz\w*|entender|conceito|quer saber sobre)/,
    intencao: "explicar_termo",
    gerar: (ctx, p) => {
      const alvo = encontrarMovimento(p, ctx.movimentos);
      if (alvo) {
        const exp = explicarMovimentoGrounded(alvo.nome, alvo.codigo);
        return {
          intencao: "explicar_movimento",
          resposta: `Sobre "${alvo.nome}" (${fmtData(alvo.dataHora)}): ${exp.explicacao}\n\n${IMPACTO_ROTULO[exp.impacto]}.`,
          fontes: [`DataJud — movimento ${alvo.codigo} "${alvo.nome}", ${fmtData(alvo.dataHora)}`, exp.base],
        };
      }
      const classe = ctx.caso.classe.toLowerCase();
      const expClasse = EXPLICACOES_CLASSE[classe] ?? Object.entries(EXPLICACOES_CLASSE).find(([k]) => classe.includes(k))?.[1];
      if (expClasse && /(classe|acao|ação|tipo)/.test(norm(p))) {
        return {
          intencao: "explicar_classe",
          resposta: `${expClasse.titulo}: ${expClasse.explicacao}\n\nComo costuma correr:\n${expClasse.fases.join("\n")}`,
          fontes: [expClasse.base],
        };
      }
      return {
        intencao: "fallback",
        resposta:
          "Não encontrei isso nos dados deste processo nem no meu glossário. Só respondo o que posso fundamentar: status, movimentos, valores, datas, significado dos movimentos (tabela oficial do CNJ), a classe da ação e o que observar. Para análise do seu caso específico, fale com um advogado (botão 'Falar com advogado').",
        fontes: [],
      };
    },
  },
  {
    re: /\b(valor\w*|quanto|causa\b|custa|dinheiro|preco\w*)/,
    intencao: "valor",
    gerar: (ctx) => {
      const v = ctx.caso.valorDaCausa;
      return {
        intencao: "valor",
        resposta:
          v != null
            ? `O valor da causa registrado é de ${fmtBrl(v)}. É o valor atribuído ao pedido na ação — não significa dívida já apurada nem quantia a pagar hoje.`
            : "Não há valor da causa nos dados públicos deste processo (ou o processo é sigiloso neste ponto). O valor consta na petição inicial e pode ser conferido com o advogado.",
        fontes: v != null ? ["DataJud/CNJ — valores.valorDaCausa"] : ["DataJud/CNJ — valor não informado"],
      };
    },
  },
  {
    re: /\b(quando|data\w*|dia\w*|mes\b|ano\b|ajuiz\w*|comec\w*|inicio|iniciou|protocol\w*)/,
    intencao: "datas",
    gerar: (ctx) => ({
      intencao: "datas",
      resposta: `A ação foi ajuizada (protocolada) em ${fmtData(ctx.caso.dataAjuizamento)} e tramita no ${ctx.caso.orgaoJulgador} (${ctx.caso.tribunal.toUpperCase()}). O número CNJ é ${ctx.caso.numeroProcesso} — a numeração acompanha o processo em qualquer instância.`,
      fontes: ["DataJud/CNJ — dataAjuizamento e órgão julgador"],
    }),
  },
  {
    re: /\b(prazo\w*|venc\w*|quanto tempo|ate quando|até quando|urgente|corre prazo|perec\w*|prescri\w*)/,
    intencao: "prazos",
    gerar: (ctx) => {
      const expClasse = EXPLICACOES_CLASSE[ctx.caso.classe.toLowerCase()] ?? Object.entries(EXPLICACOES_CLASSE).find(([k]) => ctx.caso.classe.toLowerCase().includes(k))?.[1];
      const movs = ordenados(ctx.movimentos);
      const criticos = movs.slice(0, 3).map((m) => ({ m, exp: explicarMovimentoGrounded(m.nome, m.codigo) })).filter((x) => x.exp.impacto === "critico");
      const linhas: string[] = [];
      linhas.push("Os dados públicos do DataJud NÃO trazem contagem de prazos — prazo só corre de fato a partir de intimação válida nos autos. O que posso apontar, com base no que foi registrado:");
      if (criticos.length) {
        for (const { m, exp } of criticos) {
          linhas.push(`• ${fmtData(m.dataHora)} — "${m.nome}": ${exp.explicacao}`);
        }
      } else {
        linhas.push(`• Nenhuma das ${movs.length} movimentações é do tipo que costuma abrir prazo imediato (intimação/citação/sentença) entre as recentes.`);
      }
      if (expClasse) {
        const fasesComPrazo = expClasse.fases.filter((f) => /prazo|dias/i.test(f));
        if (fasesComPrazo.length) linhas.push(`Nesta classe de ação, os prazos típicos são:\n${fasesComPrazo.join("\n")}`);
      }
      linhas.push("Recomendação: confira sempre o DJEN (Diário Eletrônico) e o andamento com seu advogado — é a fonte oficial de intimações.");
      return { intencao: "prazos", resposta: linhas.join("\n"), fontes: ["DataJud — movimentações", expClasse?.base ?? "CPC — prazos processuais"].filter(Boolean) };
    },
  },
  {
    re: /\b(proximo|próximo|e agora|o que fazer|posso fazer|devo fazer|o que espero|o que esperar|caminho|futuro|passo|strategia|estrategia)\b/,
    intencao: "proximo_passo",
    gerar: (ctx) => {
      const movs = ordenados(ctx.movimentos);
      const ultimo = movs[0];
      const exp = ultimo ? explicarMovimentoGrounded(ultimo.nome, ultimo.codigo) : null;
      const linhas = [
        "Com base no que está registrado, o caminho usual desta fase é:",
        ultimo ? `• Último registro: "${ultimo.nome}" (${fmtData(ultimo.dataHora)}) — ${exp?.explicacao ?? ""}` : "• Ainda sem movimentações registradas.",
      ];
      if (ctx.caso.status === "arquivado") {
        linhas.push("• Estando ARQUIVADO, só volta a tramitar se houver recurso, pedido de desarquivamento ou nova ação.");
      } else {
        linhas.push("• Acompanhar as próximas movimentações (use o botão Alertar para ser avisado).");
        linhas.push("• Se houver intimação ou sentença, os prazos são curtos — verifique com um advogado rapidamente.");
      }
      linhas.push("Não consigo prever decisões — só oriento o que o histórico costuma indicar.");
      return {
        intencao: "proximo_passo",
        resposta: linhas.join("\n"),
        fontes: ["DataJud — histórico de movimentações", exp?.base ?? "Tabela CNJ"].filter(Boolean),
      };
    },
  },
  {
    re: /\b(onde|vara|juiz|juizado|tribunal|orgao|órgão|foro|instancia|instância|grau|segunda|primeira|tj)\b/,
    intencao: "orgao",
    gerar: (ctx) => ({
      intencao: "orgao",
      resposta: `O processo tramita no ${ctx.caso.orgaoJulgador} (código ${ctx.caso.orgaoCodigo ?? "não informado"}), no tribunal ${ctx.caso.tribunal.toUpperCase()}. Grau registrado: ${ctx.caso.grau || "não informado"} (G1 = primeiro grau/1ª instância; G2 = segundo grau/tribunal).`,
      fontes: ["DataJud/CNJ — órgão julgador e grau"],
    }),
  },
  {
    re: /\b(sigilo\w*|segredo|confidenc\w*|privado|por que nao vejo|nao aparece|não aparece|limitad\w*)/,
    intencao: "sigilo",
    gerar: (ctx) => ({
      intencao: "sigilo",
      resposta:
        ctx.caso.nivelSigilo > 0
          ? SIGILO_MSG + " — a lei restringe a divulgação de detalhes; apenas o advogado habilitado e as partes têm acesso completo."
          : "Este processo NÃO é sigiloso nos dados públicos — por isso você vê classe, órgão e movimentações. O que não aparece é conteúdo de documentos: o DataJud expõe os atos, não os autos em si.",
      fontes: ["DataJud/CNJ — nível de sigilo", "Lei 13.105/2015 (CPC) — segredo de justiça"],
    }),
  },
  {
    re: /\b(alerta\w*|avisar|notificar|aviso|lembrete|monitorar|acompanhar mudan\w*)/,
    intencao: "alertas",
    gerar: (ctx) => ({
      intencao: "alertas",
      resposta:
        "O botão 🔔 Alertar liga os avisos deste processo: quando surgirem movimentações novas na sincronização, você recebe uma notificação (Telegram). Os alertas são consolidados para não poluir — e cada um traz o movimento que mudou.",
      fontes: ["Acompanhe.IA — alertas de movimentação (RF-B04)"],
    }),
  },
  {
    re: /\b(advogad\w*|oab|orientac\w*|juridic\w*|parecer|processar|acao judicial|defesa|contesta\w*|recorrer|recurso\w*)/,
    intencao: "advogado",
    gerar: (ctx) => ({
      intencao: "advogado",
      resposta:
        "Para análise do SEU caso (defesa, prazos a contar, recursos), o caminho é um advogado. Pelo app você pode solicitar uma consulta — ela só é encaminhada a profissionais com OAB VERIFICADA (regra RF-B07). Lembrete: parecer jurídico é ato privativo de advogado (Lei 8.906/1994, art. 1º) — aqui eu só traduzo os dados públicos.",
      fontes: ["Lei 8.906/1994, art. 1º (Estatuto da OAB)", "Acompanhe.IA — RF-B07"],
    }),
  },
];

export function responderPergunta(pergunta: string, ctx: PerguntaCtx): RespostaAssistente {
  if (ctx.caso.nivelSigilo > 0) {
    return resposta(ctx, "sigilo", SIGILO_MSG + " — posso responder apenas informações gerais; detalhes ficam restritos ao advogado habilitado.", ["DataJud/CNJ — processo sigiloso"]);
  }
  const p = norm(pergunta);
  if (!p || p.length < 2) {
    return resposta(ctx, "fallback", "Faça uma pergunta sobre o processo — ex.: 'qual o status?', 'o que significa o último movimento?', 'qual o valor da causa?'", []);
  }
  for (const m of MATCHERS) {
    if (m.re.test(p)) {
      const r = m.gerar(ctx, p);
      return resposta(ctx, r.intencao, r.resposta, r.fontes);
    }
  }
  return resposta(
    ctx,
    "fallback",
    "Não consegui fundamentar uma resposta para isso com os dados deste processo — e não vou inventar. Posso falar sobre: status, movimentos e seus significados (tabela oficial do CNJ), valor da causa, datas, órgão, prazos típicos da classe e próximos passos. Ou fale com um advogado (OAB verificada).",
    [],
  );
}
