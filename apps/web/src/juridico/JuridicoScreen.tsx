/**
 * Tela jurídica — refatorada para "simples, prático, funcional, agradável e
 * interativo" (docs/plano-refatoracao-ui.md).
 *
 * Três estados, sem sanfona e sem seta de expandir:
 *   A) buscar      — 1 campo, 1 botão, exemplos clicáveis, 1 linha de cobertura
 *   B) resultados  — lista única (índice + e-SAJ deduplicada), toque abre
 *   C) processo    — resumo, fatos, criticidade inline, movimentações, assistente
 * Diagnóstico (cobertura/fontes/limitações) vive em sheets sob demanda.
 */
import { useEffect, useMemo, useState } from "react";
import {
  api,
  type AvaliacaoRiscoResp,
  type BuscaIndiceResp,
  type CatalogoFontes,
  type DetalheTercero,
  type LegalEventDto,
  type MeuProcesso,
  type ProcessoTercero,
  type ResultadoEsaj,
} from "../api2";
import { Chip, ScoreBadge, Sheet, SkeletonLista, Vazio } from "./ui";
import {
  acoesDoEstado,
  contarPorFonte,
  detectarTipo,
  encurtar,
  EXEMPLOS,
  faixaCriticidade,
  resumoCobertura,
  ROTULO_TIPO,
  TEXTO_ESTADO_FONTE,
  unificarResultados,
  type ItemUnificado,
} from "./logica";

interface Props {
  a: ReturnType<typeof api>;
  toast: (m: string) => void;
}
interface ChatMsg {
  quem: "user" | "ia";
  texto: string;
  fontes?: string[];
  rodape?: string;
  fontesWeb?: Array<{ titulo: string; url: string; trecho?: string }>;
}

type Fase = "buscar" | "buscando" | "resultados" | "processo";
type SheetId = "como" | "filtros" | "fontes" | null;

const STATUS_CORES: Record<string, string> = { ativo: "green", suspenso: "amber", arquivado: "" };

const fmtData = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString("pt-BR");
};
const fmtBRL = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 2 });

export function JuridicoScreen({ a, toast }: Props) {
  const [consulta, setConsulta] = useState("");
  const [uf, setUf] = useState<string>("todas");
  const [fase, setFase] = useState<Fase>("buscar");
  const [sheet, setSheet] = useState<SheetId>(null);

  // resultados
  const [indice, setIndice] = useState<BuscaIndiceResp | null>(null);
  const [terceiros, setTerceiros] = useState<ProcessoTercero[]>([]);
  const [fontes, setFontes] = useState<ResultadoEsaj[]>([]);
  const [detalhes, setDetalhes] = useState<Record<string, DetalheTercero>>({});
  const [rodapeBusca, setRodapeBusca] = useState("");
  const [aviso, setAviso] = useState("");
  const [profunda, setProfunda] = useState(false);

  // processo aberto
  const [caso, setCaso] = useState<Record<string, unknown> | null>(null);
  const [movimentos, setMovimentos] = useState<LegalEventDto[]>([]);
  const [resumo, setResumo] = useState("");
  const [alertasOn, setAlertasOn] = useState(false);
  const [risco, setRisco] = useState<AvaliacaoRiscoResp | null>(null);
  const [calculandoRisco, setCalculandoRisco] = useState(false);
  const [todasMov, setTodasMov] = useState(false);

  // assistente
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [pergunta, setPergunta] = useState("");
  const [digitando, setDigitando] = useState(false);

  // progresso (só operação longa: pesquisa profunda)
  const [progresso, setProgresso] = useState<{ feitos: number; total: number; rotulo: string } | null>(null);
  const [catalogo, setCatalogo] = useState<CatalogoFontes | null>(null);
  const [meus, setMeus] = useState<MeuProcesso[]>([]);

  const tipo = detectarTipo(consulta);
  const lista = useMemo(() => unificarResultados(indice?.itens, terceiros, detalhes), [indice, terceiros, detalhes]);
  const contagens = useMemo(() => contarPorFonte(fontes), [fontes]);

  useEffect(() => {
    a.processoFontes().then(setCatalogo).catch(() => void 0);
    a.processoMeus()
      .then((r) => setMeus(r.processos ?? []))
      .catch(() => void 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const erro = (e: unknown) => toast(`⚠ ${(e as Error).message}`);

  // ─────────────────────────── busca ───────────────────────────

  const abrirProcesso = async (numero: string) => {
    setCaso(null);
    setRisco(null);
    setMovimentos([]);
    setResumo("");
    setTodasMov(false);
    setChat([]);
    setFase("processo");
    try {
      const r = await a.processo(numero);
      setCaso(r.processo);
      setMovimentos(r.movimentos ?? []);
      setResumo(r.resumo ?? "");
      setAlertasOn(Boolean(r.processo?.alertasAtivos));
    } catch (e) {
      // ainda não acompanhado: busca direto na fonte oficial
      try {
        const r = await a.processoBuscar(numero);
        setCaso(r.processo);
        setMovimentos(r.movimentos ?? []);
        setResumo(r.resumo ?? "");
        setAlertasOn(false);
      } catch {
        erro(e);
        setFase("buscar");
        return;
      }
    }
    // criticidade em paralelo (não bloqueia a leitura)
    setCalculandoRisco(true);
    a.processoRisco(numero)
      .then(setRisco)
      .catch(() => void 0)
      .finally(() => setCalculandoRisco(false));
  };

  const buscar = async (textoBruto?: string) => {
    const texto = (textoBruto ?? consulta).trim();
    if (!texto) return toast("digite um nome, CPF/CNPJ ou número do processo");
    if (textoBruto) setConsulta(texto);
    const t = detectarTipo(texto);

    if (t === "cnj") return abrirProcesso(texto);

    setFase("buscando");
    setIndice(null);
    setTerceiros([]);
    setFontes([]);
    setDetalhes({});
    setAviso("");
    setProfunda(false);
    try {
      // índice próprio + fontes ao vivo em paralelo; o índice pode não estar
      // liberado no plano — nesse caso seguimos só com as fontes públicas.
      const [pesq, idx] = await Promise.allSettled([
        a.processoPesquisar(texto, uf, 1),
        a.processoBuscarIndice(texto, uf === "todas" ? {} : { uf }),
      ]);
      if (pesq.status === "fulfilled") {
        setTerceiros(pesq.value.itens);
        setFontes(pesq.value.fontes);
        setRodapeBusca(pesq.value.rodape);
        setAviso(pesq.value.advertencia ?? "");
      } else {
        erro(pesq.reason);
      }
      if (idx.status === "fulfilled") setIndice(idx.value);
      setFase("resultados");
    } catch (e) {
      erro(e);
      setFase("buscar");
    }
  };

  const pesquisaProfunda = async () => {
    const texto = consulta.trim();
    if (!texto) return toast("digite um nome, CPF ou CNPJ para a pesquisa profunda");
    if (detectarTipo(texto) === "cnj") return toast("para um número de processo use Buscar — a profunda é por nome/CPF");
    setProgresso({ feitos: 1, total: 3, rotulo: "consultando as fontes verificadas…" });
    try {
      const r1 = await a.processoPesquisar(texto, "todas", 1);
      let itens = [...r1.itens];
      let fs = [...r1.fontes];
      setAviso(r1.advertencia ?? "");
      const extras: Array<{ uf: string; pagina: number }> = [];
      for (const f of r1.fontes) for (let p = 2; p <= Math.min(f.ultimaPagina, 10); p++) extras.push({ uf: f.uf, pagina: p });
      const total = 2 + extras.length + 1;
      setProgresso({ feitos: 2, total, rotulo: `página 1 · ${itens.length} processo(s)` });
      for (let i = 0; i < extras.length; i++) {
        const e = extras[i]!;
        setProgresso({ feitos: 2 + i, total, rotulo: `${e.uf.toUpperCase()} — página ${e.pagina}` });
        const rp = await a.processoPesquisar(texto, e.uf, e.pagina);
        itens = itens.concat(rp.itens);
        fs = fs.concat(rp.fontes);
      }
      setProgresso({ feitos: total - 1, total, rotulo: "cruzando com o DataJud (status, valor, último movimento)…" });
      const cnjs = [...new Set(itens.map((it) => it.numeroProcesso))].slice(0, 30);
      const mapa: Record<string, DetalheTercero> = {};
      if (cnjs.length) for (const d of (await a.processoDetalhesLote(cnjs)).itens) mapa[d.numeroProcesso] = d;
      setDetalhes(mapa);
      setTerceiros(itens);
      setFontes(fs);
      setRodapeBusca(r1.rodape);
      setProfunda(true);
      const idx = await a.processoBuscarIndice(texto, {}).catch(() => null);
      if (idx) setIndice(idx);
      setFase("resultados");
      toast(`🔬 ${itens.length} processo(s) encontrados nas fontes públicas`);
    } catch (e) {
      erro(e);
    } finally {
      setProgresso(null);
    }
  };

  // ─────────────────────── ações do processo ───────────────────────

  const acompanhar = async () => {
    if (!caso) return;
    const numero = String(caso.numeroProcesso ?? consulta);
    try {
      await a.processoAcompanhar(numero);
      await a.processoSync(numero);
      const r = await a.processo(numero);
      setCaso(r.processo);
      setMovimentos(r.movimentos ?? []);
      toast("⚖️ processo na sua lista — movimentações sincronizadas");
      a.processoMeus().then((r) => setMeus(r.processos ?? [])).catch(() => void 0);
    } catch (e) {
      const msg = (e as Error).message;
      if (/já acompanhado/i.test(msg)) {
        toast("⚖️ esse processo já está na sua lista");
        a.processoMeus().then((r) => setMeus(r.processos ?? [])).catch(() => void 0);
      } else erro(e);
    }
  };

  const alertar = async () => {
    if (!caso) return;
    try {
      const r = await a.processoAlertar(String(caso.numeroProcesso ?? consulta));
      setAlertasOn(Boolean(r.alertasAtivos));
      toast(r.alertasAtivos ? "🔔 alertas ativados — aviso no Telegram a cada movimento novo" : "alertas desativados");
    } catch (e) {
      erro(e);
    }
  };

  const sincronizar = async () => {
    if (!caso) return;
    const numero = String(caso.numeroProcesso ?? consulta);
    try {
      const r = await a.processoSync(numero);
      toast(`🔄 sincronizado · ${r.novos} movimento(s) novo(s)`);
      const atual = await a.processo(numero);
      setCaso(atual.processo);
      setMovimentos(atual.movimentos ?? []);
    } catch (e) {
      erro(e);
    }
  };

  const perguntar = async (q: string) => {
    const texto = q.trim();
    if (!texto || !caso) return;
    const numero = String(caso.numeroProcesso ?? consulta);
    setChat((c) => [...c, { quem: "user", texto }]);
    setPergunta("");
    setDigitando(true);
    try {
      const r = await a.processoPerguntar(numero, texto);
      setChat((c) => [...c, { quem: "ia", texto: r.resposta, fontes: r.fontes, rodape: r.rodape }]);
    } catch (e) {
      setChat((c) => [...c, { quem: "ia", texto: `Não consegui responder agora: ${(e as Error).message}` }]);
    } finally {
      setDigitando(false);
    }
  };

  const buscarNaWeb = async () => {
    const texto = pergunta.trim();
    if (!texto) return toast("escreva a pergunta no campo do assistente");
    setChat((c) => [...c, { quem: "user", texto: `🌐 ${texto}` }]);
    setPergunta("");
    setDigitando(true);
    try {
      const r = await a.processoBuscarWeb(texto);
      setChat((c) => [...c, { quem: "ia", texto: r.resposta, fontesWeb: r.fontes, rodape: r.rodape }]);
    } catch (e) {
      erro(e);
    } finally {
      setDigitando(false);
    }
  };

  const falarAdvogado = async () => {
    if (!caso) return;
    try {
      const r = await a.juridicoConsulta(String(caso.numeroProcesso ?? consulta), uf);
      toast(r.consolidado ? "você já tem consulta nesta janela de 6h — acompanhamento consolidado" : "consulta registrada — encaminhada a advogado com OAB verificada");
    } catch (e) {
      erro(e);
    }
  };

  const voltar = () => {
    setFase(lista.length && caso ? "resultados" : "buscar");
    if (fase === "processo" && !lista.length) setFase("buscar");
  };

  // ───────────────────────────── UI ─────────────────────────────

  return (
    <div className="jur">
      {fase !== "processo" && (
        <>
          <div className="jur-top">
            <div>
              <h2 className="jur-title">Jurídico</h2>
              <p className="tiny" style={{ marginTop: 2 }}>
                {lista.length ? `${lista.length} resultado(s)` : "processos públicos em todo o Brasil"}
              </p>
            </div>
            <button className="btn ghost sm" onClick={() => setSheet("como")} title="como funciona e o que é coberto">
              ⓘ como funciona
            </button>
          </div>

          <div className="field">
            <span className="field-ico" aria-hidden="true">🔍</span>
            <input
              className="field-input"
              value={consulta}
              onChange={(e) => {
                setConsulta(e.target.value);
                // digitar volta para o estado de busca (resultados são transitórios)
                if (fase === "resultados") setFase("buscar");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void buscar();
              }}
              placeholder="Buscar processo, nome ou CPF"
              aria-label="Nome, CPF/CNPJ ou número do processo"
              inputMode={tipo === "nome" ? "text" : "numeric"}
              enterKeyHint="search"
            />
            {consulta.trim() !== "" && (
              <button
                className="field-clear"
                onClick={() => {
                  setConsulta("");
                  setFase("buscar");
                  setCaso(null);
                  setIndice(null);
                  setTerceiros([]);
                }}
                aria-label="limpar busca"
                title="limpar"
              >
                ✕
              </button>
            )}
            <button className="field-btn" onClick={() => void buscar()} disabled={fase === "buscando"}>
              {fase === "buscando" ? "…" : "Buscar"}
            </button>
          </div>

          <div className="jur-meta">
            {tipo ? (
              <span className="tag green">detectado: {ROTULO_TIPO[tipo]}</span>
            ) : (
              EXEMPLOS.map((ex) => (
                <Chip key={ex.rotulo} onClick={() => void buscar(ex.valor)} titulo={`buscar por ${ex.rotulo}`}>
                  {ex.rotulo}
                </Chip>
              ))
            )}
            {(uf !== "todas" || tipo !== "cnj") && (
              <Chip onClick={() => setSheet("filtros")} ativo={uf !== "todas"} titulo="estado / tribunal">
                {uf === "todas" ? "UF" : uf.toUpperCase()}
              </Chip>
            )}
          </div>

          {acoesDoEstado(tipo, false).includes("profunda") && (
            <button className="btn ghost jur-profunda" onClick={() => void pesquisaProfunda()} disabled={Boolean(progresso)}>
              🔬 Pesquisa profunda {tipo === "nome" || tipo === "cpf" || tipo === "cnpj" ? "(todas as páginas)" : ""}
            </button>
          )}

          {progresso && (
            <div className="jur-prog" role="status">
              <div className="bar">
                <i style={{ width: `${progresso.total ? Math.round((progresso.feitos / progresso.total) * 100) : 5}%` }} />
              </div>
              <div className="tiny" style={{ marginTop: 6 }}>
                {progresso.rotulo} · etapa {Math.min(progresso.feitos + 1, progresso.total)}/{progresso.total}
              </div>
            </div>
          )}

          {fase === "buscando" && <SkeletonLista linhas={3} />}

          {fase === "buscar" && !consulta.trim() && meus.length > 0 && (
            <section style={{ marginTop: 18 }}>
              <h4 className="jur-h4" style={{ marginTop: 0 }}>Acompanhados ({meus.length})</h4>
              <ul className="res-list">
                {meus.slice(0, 3).map((m) => (
                  <li key={m.numeroProcesso}>
                    <button className="res-item" onClick={() => void abrirProcesso(m.numeroProcesso)}>
                      <div className="res-main">
                        <div className="res-num mono">{m.numeroProcesso}</div>
                        <div className="res-parte">
                          {m.ultimoMovimento?.nome
                            ? encurtar(m.ultimoMovimento.nome, 40)
                            : m.classe && !/não consultado/i.test(m.classe)
                              ? encurtar(m.classe, 40)
                              : "ainda sem dados do tribunal — toque para sincronizar"}
                        </div>
                        {m.ultimoMovimento && m.classe && !/não consultado/i.test(m.classe) && (
                          <div className="res-sub">{encurtar(m.classe, 46)}</div>
                        )}
                      </div>
                      <div className="res-side">
                        <div className="res-side-top">
                          {m.alertasAtivos && <span className="tag green">🔔</span>}
                          <span className="res-trib">{encurtar(m.tribunal ?? "", 8)}</span>
                        </div>
                        <span className="res-chev" aria-hidden="true">›</span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
              {meus.length > 3 && <p className="tiny" style={{ marginTop: 6 }}>+{meus.length - 3} outro(s) na sua lista</p>}
            </section>
          )}
        </>
      )}

      {/* ─────────── B) resultados ─────────── */}
      {fase === "resultados" && (
        <section className="jur-res">
          {aviso && <div className="banner warn" style={{ marginBottom: 10 }}>{aviso}</div>}

          {lista.length === 0 ? (
            <Vazio
              titulo="Nenhum processo público encontrado"
              dica="Tente o nome completo, o número do processo ou a pesquisa profunda. O índice próprio cresce a cada consulta."
            />
          ) : (
            <ul className="res-list">
              {lista.map((it) => (
                <li key={it.chave}>
                  <button className="res-item" onClick={() => void abrirProcesso(it.numero)}>
                    <div className="res-main">
                      <div className="res-num mono">{it.numero}</div>
                      <div className="res-parte">{encurtar(it.partes, 46)}</div>
                      <div className="res-sub">
                        {[it.classe, it.assunto].filter(Boolean).join(" · ") || "classe não informada"}
                      </div>
                      {it.ultimoMovimento && <div className="res-mov">↳ {encurtar(it.ultimoMovimento, 52)}</div>}
                    </div>
                    <div className="res-side">
                      <div className="res-side-top">
                        {it.score != null && <ScoreBadge score={it.score} />}
                        <span className="res-trib">{encurtar(it.tribunal ?? "—", 12)}</span>
                      </div>
                      <span className="res-chev" aria-hidden="true">›</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="jur-foot">
            <span className="tiny">
              {lista.length} processo(s){profunda ? " · pesquisa profunda" : ""} ·{" "}
              {contagens.filter((c) => c.estado === "resultados").map((c) => `${c.fonte.toUpperCase()}`).join(", ") || "fontes verificadas"}
            </span>
            {(contagens.length > 0 || aviso) && (
              <button className="link" onClick={() => setSheet("fontes")}>
                onde buscamos
              </button>
            )}
          </div>
          {rodapeBusca && <p className="tiny jur-rodape">{rodapeBusca}</p>}
        </section>
      )}

      {/* ─────────── C) processo aberto ─────────── */}
      {fase === "processo" && (
        <section className="jur-proc">
          <div className="jur-res-head">
            <button className="btn ghost sm" onClick={voltar}>‹ voltar</button>
            <span className="mono" style={{ fontSize: "0.78rem" }}>{String(caso?.numeroProcesso ?? consulta)}</span>
            {caso && <span className={`tag ${STATUS_CORES[String(caso.status ?? "")] ?? ""}`}>{String(caso.status ?? "—")}</span>}
          </div>

          {!caso && <SkeletonLista linhas={4} />}

          {caso && (
            <>
              {resumo && <p className="jur-resumo">{resumo}</p>}

              <div className="stat-grid">
                {[
                  { rot: "classe", val: `${String(caso.classe ?? "—")}${caso.assunto ? ` · ${String(caso.assunto)}` : ""}` },
                  { rot: "onde tramita", val: `${String(caso.orgaoJulgador ?? "—")} · ${String(caso.tribunal ?? "").toUpperCase()}` },
                  { rot: "instância", val: String(caso.grau) === "G2" ? "2ª (tribunal)" : String(caso.grau) === "G1" ? "1ª (juízo)" : String(caso.grau ?? "—") },
                  { rot: "início", val: fmtData(String(caso.dataAjuizamento ?? "")) },
                  { rot: "valor da causa", val: caso.valorDaCausa != null ? fmtBRL(Number(caso.valorDaCausa)) : "não informado" },
                  {
                    rot: "última movimentação",
                    val: caso.ultimoMovimento
                      ? `${(caso.ultimoMovimento as { nome: string }).nome}`
                      : "sem registro",
                  },
                ].map((f) => (
                  <div key={f.rot} className="stat">
                    <div className="stat-rot">{f.rot}</div>
                    <div className="stat-val">{f.val}</div>
                  </div>
                ))}
              </div>

              {/* criticidade inline — era um card separado ocupando a tela */}
              <div className="risco">
                <div className="risco-head">
                  <span className="mut" style={{ fontSize: "0.78rem" }}>criticidade</span>
                  {risco ? (
                    <>
                      <b style={{ fontSize: "1.15rem", color: faixaCriticidade(risco.criticidade).cor }}>
                        {risco.criticidade}/10
                      </b>
                      <span className="tag" style={{ color: faixaCriticidade(risco.criticidade).cor }}>
                        {faixaCriticidade(risco.criticidade).rotulo}
                      </span>
                      <span className="tiny">{risco.considerados} processo(s) · {risco.versaoRegras}</span>
                    </>
                  ) : (
                    <span className="tiny">{calculandoRisco ? "calculando…" : "sem dados"}</span>
                  )}
                </div>
                {risco && risco.justificativas.length > 0 && (
                  <ul className="risco-list">
                    {risco.justificativas.slice(0, 3).map((j, i) => (
                      <li key={`${j.regra}-${i}`}>
                        <b>+{j.criticidade}</b> {j.motivo}
                      </li>
                    ))}
                  </ul>
                )}
                {risco && risco.justificativas.length > 3 && (
                  <p className="tiny">+{risco.justificativas.length - 3} outra(s) regra(s) em {risco.versaoRegras}</p>
                )}
              </div>

              <div className="jur-acoes">
                {acoesDoEstado("cnj", true).map((id) => {
                  const mapa: Record<string, { rot: string; fn: () => void; cls: string }> = {
                    abrir: { rot: "abrir", fn: () => void abrirProcesso(String(caso.numeroProcesso ?? consulta)), cls: "btn ghost sm" },
                    acompanhar: { rot: "⚖️ Acompanhar", fn: () => void acompanhar(), cls: "btn good sm" },
                    alertar: { rot: alertasOn ? "🔔 alertando" : "🔔 Alertar", fn: () => void alertar(), cls: "btn ghost sm" },
                    sincronizar: { rot: "🔄 Sincronizar", fn: () => void sincronizar(), cls: "btn ghost sm" },
                    perguntar: {
                      rot: "💬 Perguntar",
                      cls: "btn ghost sm",
                      fn: () => {
                        if (!chat.length)
                          setChat([
                            {
                              quem: "ia",
                              texto:
                                "Olá! Respondo com base nos dados públicos deste processo (DataJud/CNJ) e na tabela oficial de movimentos — sem inventar. Pergunte o que quiser.",
                              fontes: ["DataJud/CNJ + tabela oficial de movimentos (Res. 46/2007)"],
                              rodape: "conteúdo informativo, não é parecer jurídico",
                            },
                          ]);
                        document.getElementById("assistente")?.scrollIntoView({ behavior: "smooth", block: "center" });
                      },
                    },
                  };
                  const item = mapa[id];
                  if (!item || id === "abrir") return null;
                  return (
                    <button key={id} className={item.cls} onClick={item.fn}>
                      {item.rot}
                    </button>
                  );
                })}
              </div>

              <h4 className="jur-h4">Movimentações ({movimentos.length})</h4>
              {movimentos.length === 0 ? (
                <p className="mut" style={{ fontSize: "0.85rem" }}>Nenhuma movimentação registrada — toque em Sincronizar.</p>
              ) : (
                <ul className="mov-list">
                  {[...movimentos]
                    .sort((x, y) => (x.dataHora < y.dataHora ? 1 : -1))
                    .slice(0, todasMov ? movimentos.length : 5)
                    .map((m, i) => (
                      <li key={`${m.codigo}-${m.dataHora}-${i}`}>
                        <div>
                          <div className="mov-nome">{m.nome}</div>
                          <div className="tiny">{fmtData(m.dataHora)} · mov. {m.codigo}</div>
                        </div>
                        <button className="link" onClick={() => void perguntar(`o que significa o movimento ${m.nome}?`)}>
                          o que é?
                        </button>
                      </li>
                    ))}
                </ul>
              )}
              {movimentos.length > 5 && (
                <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => setTodasMov((v) => !v)}>
                  {todasMov ? "ver menos" : `ver todas (${movimentos.length})`}
                </button>
              )}

              <div id="assistente" className="assistente">
                <h4 className="jur-h4">Assistente do processo</h4>
                <div className="chat">
                  {chat.map((m, i) => (
                    <div key={i} className={`msg ${m.quem === "user" ? "eu" : "ia"}`}>
                      <div className="msg-txt">{m.texto}</div>
                      {m.fontes && m.fontes.length > 0 && <div className="tiny">fontes: {m.fontes.join(" · ")}</div>}
                      {m.fontesWeb?.map((f, k) => (
                        <a key={`${f.url}-${k}`} className="msg-web" href={f.url} target="_blank" rel="noreferrer noopener">
                          <b>{k + 1}. {f.titulo}</b>
                          {f.trecho && <span className="tiny">{f.trecho.slice(0, 160)}…</span>}
                        </a>
                      ))}
                      {m.rodape && <div className="tiny" style={{ fontStyle: "italic" }}>{m.rodape}</div>}
                    </div>
                  ))}
                  {digitando && <div className="tiny">analisando os dados do processo…</div>}
                </div>
                <div className="jur-meta" style={{ marginBottom: 8 }}>
                  {["Resuma o processo", "O que aconteceu por último?", "Quais prazos observar?"].map((s) => (
                    <Chip key={s} onClick={() => void perguntar(s)}>{s}</Chip>
                  ))}
                </div>
                <div className="field">
                  <span className="field-ico" aria-hidden="true">💬</span>
                  <input
                    className="field-input"
                    value={pergunta}
                    onChange={(e) => setPergunta(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void perguntar(pergunta);
                    }}
                    placeholder="Pergunte sobre este processo…"
                    aria-label="Pergunta sobre o processo"
                  />
                  <button className="field-btn" onClick={() => void perguntar(pergunta)}>Perguntar</button>
                </div>
                <div className="jur-acoes" style={{ marginTop: 8 }}>
                  <button className="btn ghost sm" onClick={() => void buscarNaWeb()}>🌐 Buscar na web</button>
                  <button className="btn ghost sm" onClick={() => void falarAdvogado()}>👨‍⚖️ Falar com advogado</button>
                </div>
              </div>
            </>
          )}
        </section>
      )}

      {/* ─────────── shet: uma linha de rodapé, sempre acessível ─────────── */}
      {fase === "buscar" && (
        <button className="jur-cobertura" onClick={() => setSheet("como")}>
          {resumoCobertura(catalogo)} <span aria-hidden="true">›</span>
        </button>
      )}

      <Sheet aberto={sheet === "como"} titulo="Como funciona" onFechar={() => setSheet(null)}>
        <p className="mut" style={{ marginTop: 0 }}>
          Fontes públicas oficiais. Cada item mostra o que foi verificado e o que <b>não</b> é possível.
        </p>
        <div className="sheet-lista">
          {(catalogo?.fontes ?? []).map((f) => (
            <div key={f.id} className="fonte-item">
              <div className="fonte-top">
                <b>{f.nome}</b>
                <span className={`tag ${f.estado === "ativo" ? "green" : "amber"}`}>
                  {f.estado === "ativo" ? "verificado" : f.estado}
                </span>
              </div>
              {f.limitacao && <div className="tiny fonte-lim">{f.limitacao}</div>}
              <div className="tiny fonte-data">verificado em {f.verificadoEm}</div>
            </div>
          ))}
        </div>
        <div className="sheet-nota">
          <b>Resumo:</b> {resumoCobertura(catalogo)}. O DataJud (CNJ) não publica partes, então busca por nome/CPF
          usa as fontes estaduais de consulta pública e o índice próprio. DJEN/Comunicação (publicações) exige
          egress brasileiro — indisponível por ora.
        </div>
        <div className="sheet-nota">
          <b>Criticidade</b> é determinística e auditável ({risco?.versaoRegras ?? "risco-v1"}): cada ponto tem uma
          justificativa com o processo que a gerou. Não é parecer jurídico.
        </div>
      </Sheet>

      <Sheet aberto={sheet === "filtros"} titulo="Estado / tribunal" onFechar={() => setSheet(null)}>
        <p className="mut" style={{ marginTop: 0 }}>Restringe a busca por nome/CPF às fontes de um estado.</p>
        <div className="jur-meta">
          <Chip ativo={uf === "todas"} onClick={() => { setUf("todas"); setSheet(null); }}>todos</Chip>
          {(catalogo?.cobertura?.nome?.ufs ?? ["ac", "al", "ce", "sp"]).map((u) => (
            <Chip key={u} ativo={uf === u} onClick={() => { setUf(u); setSheet(null); }}>{u.toUpperCase()}</Chip>
          ))}
        </div>
        <p className="tiny" style={{ marginTop: 12 }}>
          Para busca por <b>número</b>, o estado é detectado do próprio CNJ — não precisa escolher.
        </p>
      </Sheet>

      <Sheet aberto={sheet === "fontes"} titulo="Onde buscamos" onFechar={() => setSheet(null)}>
        <div className="sheet-lista">
          {indice && (
            <div className="sheet-item">
              <div>
                <div style={{ fontSize: "0.88rem" }}>Índice próprio</div>
                <div className="tiny">{indice.totalNoIndice} processo(s) indexados</div>
              </div>
              <span className="tag green">{indice.itens.length} nesta busca</span>
            </div>
          )}
          {contagens.map((c) => (
            <div key={c.fonte} className="sheet-item">
              <div>
                <div style={{ fontSize: "0.88rem" }}>{c.fonte.toUpperCase()} — {c.uf.toUpperCase()}</div>
                <div className="tiny">{TEXTO_ESTADO_FONTE[c.estado]}</div>
              </div>
              <span className="tag">{c.itens} nesta página</span>
            </div>
          ))}
          {contagens.length === 0 && !indice && <p className="mut">Nenhuma fonte foi consultada ainda.</p>}
        </div>
        {(aviso || rodapeBusca) && (
          <div className="sheet-nota">
            {aviso && <div>⚠ {aviso}</div>}
            {rodapeBusca && <div className="tiny">{rodapeBusca}</div>}
          </div>
        )}
      </Sheet>
    </div>
  );
}

