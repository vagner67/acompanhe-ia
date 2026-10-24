/**
 * Glossário jurídico-curado — linguagem simples com BASE LEGAL CITADA.
 * Fontes verificadas em 24/10/2026:
 *  - Tabela oficial de movimentos do CNJ (Res. 46/2007) — tabela-movimentos.ts
 *  - CNJ Serviço "sentença × decisão × despacho" (CPC art. 203)
 *  - DL 911/1969 (alienação fiduciária); Tema 1.279 STJ (purga da mora);
 *    Súmula 72 STJ (constituição da mora); Lei 13.043/2014
 *  - Classificação de impacto: informativo / atenção / crítica (literatura de
 *    prática processual — movimentações "de atenção" e "críticas")
 * NADA aqui é inventado: todo texto é tradução de norma/prática consolidada,
 * e o assistente só usa estas explicações CONJUNTAMENTE com dados do processo.
 */

export type Impacto = "informativo" | "atencao" | "critico";

export interface ExplicacaoMovimento {
  /** Nome curto (o oficial vem da tabela-movimentos.ts). */
  titulo: string;
  /** Linguagem simples — o que ACONTECEU no processo. */
  explicacao: string;
  /** O que isso significa para o usuário. */
  impacto: Impacto;
  /** Fundamento/fonte citada (sempre presente). */
  base: string;
}

export const IMPACTO_ROTULO: Record<Impacto, string> = {
  informativo: "ℹ️ informativo — não exige ação",
  atencao: "⚠️ de atenção — pode exigir algo em breve",
  critico: "🔴 crítico — confira um prazo ou efeito",
};

/** Explicações dos movimentos MAIS COMUNS (códigos da tabela oficial CNJ). */
export const EXPLICACOES_MOVIMENTO: Readonly<Record<number, ExplicacaoMovimento>> = Object.freeze({
  26: {
    titulo: "Distribuição",
    explicacao: "O processo foi atribuído a este juízo/vara — é o começo da tramitação.",
    impacto: "informativo",
    base: "Tabela CNJ (mov. 26); Res. 46/2007",
  },
  36: {
    titulo: "Redistribuição",
    explicacao: "O processo passou para outro juízo ou relator (geralmente por dependência ou sorteio).",
    impacto: "informativo",
    base: "Tabela CNJ (mov. 36)",
  },
  51: {
    titulo: "Conclusão",
    explicacao:
      "Os autos foram encaminhados ao juízo para análise (pode sair um despacho, uma decisão ou a sentença). É um momento de espera: em regra não abre prazo por si só.",
    impacto: "informativo",
    base: "Tabela CNJ (mov. 51); prática processual (conclusos)",
  },
  60: {
    titulo: "Expedição de documento",
    explicacao:
      "O tribunal emitiu um documento (mandado, certidão, intimação…). Se for intimação, pode correr prazo a partir dela — confira a publicação no Diário Eletrônico (DJEN).",
    impacto: "atencao",
    base: "Tabela CNJ (mov. 60); Res. 455/2022 (intimação no DJEN)",
  },
  67: {
    titulo: "Juntada",
    explicacao: "Um documento novo foi anexado aos autos (petição, laudo, ofício, comprovante…).",
    impacto: "informativo",
    base: "Tabela CNJ (mov. 67)",
  },
  83: {
    titulo: "Cancelamento da distribuição",
    explicacao: "A distribuição foi cancelada (ex.: erro de competência ou dependência entre processos).",
    impacto: "atencao",
    base: "Tabela CNJ (mov. 83)",
  },
  132: {
    titulo: "Recebimento",
    explicacao: "O tribunal registrou o recebimento dos autos neste juízo.",
    impacto: "informativo",
    base: "Tabela CNJ (mov. 132)",
  },
  137: {
    titulo: "Desapensamento",
    explicacao: "Este processo foi desvinculado de outro com o qual estava apensado.",
    impacto: "informativo",
    base: "Tabela CNJ (mov. 137)",
  },
  193: {
    titulo: "Sentença",
    explicacao:
      "O juiz encerrou a fase de conhecimento em 1º grau, com ou sem julgar o mérito (CPC art. 203 §3º). Em regra abre prazo de recurso (15 dias úteis) ou inicia o cumprimento da decisão.",
    impacto: "critico",
    base: "CPC art. 203 §3º; CNJ Serviço (sentença × decisão × despacho)",
  },
  228: {
    titulo: "Arquivamento",
    explicacao:
      "O processo foi encerrado e enviado ao arquivo (pode ser definitivo — quando acabou — ou provisório, enquanto não há nada a fazer).",
    impacto: "critico",
    base: "Tabela CNJ (mov. 228)",
  },
  381: {
    titulo: "Recurso",
    explicacao:
      "Uma das partes recorreu de uma decisão — o processo será reexaminado por um tribunal superior. O prazo padrão de recurso é de 15 dias úteis, salvo rito específico.",
    impacto: "atencao",
    base: "Tabela CNJ (mov. 381); CPC arts. 1.003 e seguintes",
  },
  893: {
    titulo: "Desarquivamento",
    explicacao: "O processo estava arquivado e voltou a tramitar (houve um novo pedido ou determinação judicial).",
    impacto: "atencao",
    base: "Tabela CNJ (mov. 893)",
  },
  970: {
    titulo: "Audiência",
    explicacao:
      "Houve (ou foi marcada) uma sessão judicial — pode ser de conciliação, instrução de provas ou julgamento. A intimação da audiência costuma vir por DJEN.",
    impacto: "atencao",
    base: "Tabela CNJ (mov. 970); CPC arts. 334 e 358",
  },
  1051: {
    titulo: "Decurso de prazo",
    explicacao: "Um prazo processual se encerrou — a manifestação esperada (se havia) não foi feita dentro dele.",
    impacto: "atencao",
    base: "Tabela CNJ (mov. 1051)",
  },
  11009: {
    titulo: "Despacho",
    explicacao:
      "Ato de mero expediente do juiz, para dar andamento ao processo — não resolve questão controvertida (CPC art. 203 §1º). Em regra não abre prazo.",
    impacto: "informativo",
    base: "CPC art. 203 §1º; CNJ Serviço",
  },
  3: {
    titulo: "Decisão",
    explicacao:
      "O juiz resolveu uma questão durante o processo (decisão interlocutória — CPC art. 203 §2º). Pode abrir prazo de manifestação ou recurso — confira o que foi decidido.",
    impacto: "atencao",
    base: "CPC art. 203 §2º",
  },
  12263: {
    titulo: "Intimação",
    explicacao:
      "Comunicação oficial a uma das partes ou advogado sobre um ato do processo. DA INTIMAÇÃO PODE CORRER PRAZO — é o momento de redobrar a atenção.",
    impacto: "critico",
    base: "Res. 455/2022 (DJEN); CPC art. 270",
  },
  12284: {
    titulo: "Citação",
    explicacao:
      "O réu foi oficialmente chamado para se defender. Da citação correm prazos importantes (ex.: 15 dias para contestar na maioria dos ritos).",
    impacto: "critico",
    base: "CPC arts. 238-245",
  },
  12624: {
    titulo: "Audiência (art. 334 CPC)",
    explicacao:
      "Audiência de conciliação/mediação — o juiz tenta um acordo antes da fase de instrução. Se não houver acordo, o réu será intimado para apresentar defesa.",
    impacto: "atencao",
    base: "CPC art. 334",
  },
});

/** Classes processuais comuns — explicação grounded em norma específica. */
export interface ExplicacaoClasse {
  titulo: string;
  explicacao: string;
  base: string;
  /** Roteiro de fases, quando a lei define um fluxo claro. */
  fases: string[];
}

export const EXPLICACOES_CLASSE: Readonly<Record<string, ExplicacaoClasse>> = Object.freeze({
  "busca e apreensão em alienação fiduciária": {
    titulo: "Busca e Apreensão em Alienação Fiduciária",
    explicacao:
      "É a ação em que o credor (banco/financeira) pede a apreensão de um bem financiado — quase sempre um veículo — que deixou de ser pago. O juiz pode autorizar a apreensão de imediato (liminar), sem ouvir o devedor antes.",
    base: "Decreto-Lei 911/1969, art. 3º (redação da Lei 13.043/2014); Súmula 72 STJ",
    fases: [
      "1) Mora do devedor (Súmula 72 STJ — a notificação do atraso é obrigatória)",
      "2) Liminar de busca e apreensão (pode sair sem contraditório prévio)",
      "3) Cumprimento da liminar: o bem é apreendido",
      "4) 5 dias para purgar a mora (pagar a dívida integral e reaver o bem) — o prazo conta da EXECUÇÃO DA LIMINAR (STJ, Tema 1.279)",
      "5) Não pagando, consolida-se a propriedade em nome do credor",
      "6) 15 dias para o devedor apresentar resposta/defesa após o cumprimento da liminar",
      "7) Sentença (cabe apelação, só com efeito devolutivo) e venda do bem (pode ser extrajudicial)",
    ],
  },
  "execução fiscal": {
    titulo: "Execução Fiscal",
    explicacao:
      "É a cobrança judicial de uma dívida com o Fazendão (impostos, taxas, multas) lançada em dívida ativa. Inicia com a citação do devedor para pagar ou nomear bens à penhora.",
    base: "Lei 6.830/1980 (Execução Fiscal)",
    fases: [
      "1) Citação (com prazo para pagar ou garantir a execução)",
      "2) Penhora de bens (se não pagar)",
      "3) Impugnação/defesa e julgamento",
      "4) Arrematação dos bens para pagar a dívida",
    ],
  },
  "execução de título extrajudicial": {
    titulo: "Execução de Título Extrajudicial",
    explicacao:
      "Cobrança judicial de um documento que já vale como prova de dívida (nota promissória, contrato com firma reconhecida, cheque…). O devedor é citado para pagar em 3 dias ou nomear bens à penhora.",
    base: "CPC arts. 784 e 786",
    fases: ["1) Citação (3 dias para pagar)", "2) Penhora", "3) Embargos do devedor (15 dias)", "4) Julgamento e satisfação do crédito"],
  },
});

/** Perguntas sugeridas no chat (clicáveis) — cobrem as intenções reais. */
export const SUGESTOES_PADRAO = [
  "Resuma o processo",
  "Qual o status agora?",
  "O que aconteceu por último?",
  "O que significa o último movimento?",
  "Quais prazos devo observar?",
  "E agora, qual o próximo passo?",
];
