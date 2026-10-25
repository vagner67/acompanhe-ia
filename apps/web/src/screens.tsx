import { useEffect, useState } from "react";
import { XP } from "@acompanhe/shared";
import { api, adminApi, type AvaliacaoRiscoResp, type BuscaIndiceResp, type CatalogoFontes, type DetalheTercero, type FonteWebDto, type Gamificacao, type GastoDto, type LegalEventDto, type LoanMatchDto, type LoanRequestDto, type NotaDto, type PlanoDto, type ProcessoTercero, type ResultadoEsaj, type StatusAssinatura } from "./api2";

type Api = ReturnType<typeof api>;
interface P {
  a: Api;
  token: string;
  toast: (m: string) => void;
}

const fmt = (c: number) => `R$ ${(c / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`;
const mesAtual = () => new Date().toISOString().slice(0, 7);

// ═══════════════════════ INÍCIO (gamificada) ═══════════════════════
export function InicioScreen({ a, toast }: P) {
  const [g, setG] = useState<Gamificacao | null>(null);
  useEffect(() => {
    a.gamificacao().then(setG).catch(() => void 0);
    a.acao(XP.loginDiario).then((r) => r.xpGanho > 0 && toast(`+${r.xpGanho} XP de login diário 🔥 streak ${r.streak}`)).catch(() => void 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!g) return <div className="empty">Carregando seu progresso…</div>;
  const pct = Math.round(g.levelInfo.progress * 100);
  return (
    <>
      <div className="hero">
        <h2>Olá! 👋 Bora economizar hoje?</h2>
        <p className="mut">Cada ação real no app vale XP. Use os produtos, suba de nível e desbloqueie conquistas.</p>
        <div className="row" style={{ marginTop: 10 }}>
          <span className="chip on">⭐ Nível {g.levelInfo.level}</span>
          <span className="chip">✨ {g.perfil.xp} XP</span>
          <span className="chip">🔥 {g.perfil.streak} dia{g.perfil.streak === 1 ? "" : "s"}</span>
        </div>
        <div className="bar" style={{ marginTop: 10 }}>
          <i style={{ width: `${pct}%` }} />
        </div>
        <p className="tiny" style={{ marginTop: 6 }}>
          {g.levelInfo.nextAt ? `${g.levelInfo.nextAt - g.perfil.xp} XP para o nível ${g.levelInfo.level + 1}` : "Nível máximo! 👑"}
        </p>
      </div>

      <div className="card">
        <h3>🎯 Missões da semana</h3>
        {g.missoes.map((m) => {
          const meta = g.catalogoMissoes.find((c) => c.code === m.code);
          return (
            <div className="mission" key={m.code}>
              <div>
                <b style={{ fontSize: "0.86rem" }}>{meta?.title ?? m.code}</b>
                <div className="tiny">
                  {m.progress}/{meta?.meta} · +{meta?.xp} XP
                </div>
                <div className="m-bar">
                  <i style={{ width: `${Math.min(100, Math.round((m.progress / (meta?.meta || 1)) * 100))}%` }} />
                </div>
              </div>
              <span className={`tag ${m.done ? "green" : ""}`}>{m.done ? "✅ concluída" : "em curso"}</span>
            </div>
          );
        })}
      </div>

      <div className="card">
        <h3>🏅 Conquistas</h3>
        <div className="badge-grid">
          {g.catalogoConquistas.map((b) => {
            const got = g.conquistas.some((c) => c.badge === b.code);
            return (
              <div className={`badge-card ${got ? "got" : ""}`} key={b.code} style={{ opacity: got ? 1 : 0.45 }}>
                <b>{b.title}</b>
                <div className="tiny">{b.desc}</div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

// ═══════════════════════ INVESTIGA ═══════════════════════
export function InvestigaScreen({ a, toast }: P) {
  const [casos, setCasos] = useState<Array<{ id: string; title: string; status: string }>>([]);
  const [caso, setCaso] = useState("");
  const [doc, setDoc] = useState("");
  const [alvo, setAlvo] = useState("");
  const [saida, setSaida] = useState("");
  const [quota, setQuota] = useState("");
  useEffect(() => {
    a.invCasos().then((r) => setCasos(r.cases)).catch(() => void 0);
    a.invQuota().then((r) => setQuota(`${r.window.used}/${r.window.limit}`)).catch(() => void 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const novoCaso = async () => {
    if (!caso.trim()) return toast("Dê um título ao caso");
    try {
      const r = await a.invCriarCaso(caso.trim());
      toast(`Caso criado: ${r.case.id.slice(0, 8)}…`);
      setCaso("");
      setCasos(await a.invCasos().then((x) => x.cases));
    } catch (e) {
      toast(`⚠ ${(e as Error).message}`);
    }
  };
  const run = (fn: () => Promise<unknown>, label: string) =>
    fn()
      .then((r) => setSaida(`${label}\n${JSON.stringify(r, null, 2)}`))
      .catch((e: Error) => toast(`⚠ ${e.message}`));

  return (
    <>
      <div className="card">
        <h3>🔎 Investiga — OSINT com dado + data</h3>
        <p className="mut">Casos com documento (CPF/CNPJ/nome) → consulta real, estimativa de renda e alerta de monitoramento.</p>
        <div className="row">
          <span className="tag">quota consultas: {quota || "…"}</span>
        </div>
        <label>Título do novo caso</label>
        <div className="row">
          <input className="input grow" value={caso} onChange={(e) => setCaso(e.target.value)} placeholder="Ex.: Due diligence fornecedor X" />
          <button className="btn" onClick={novoCaso}>Criar</button>
        </div>
      </div>

      <div className="card">
        <h3>Meus casos</h3>
        {casos.length === 0 && <div className="empty">Nenhum caso ainda — crie o primeiro acima.</div>}
        {casos.map((c) => (
          <div className="list-item" key={c.id}>
            <div>
              <b>{c.title}</b>
              <div className="tiny mono">{c.id}</div>
            </div>
            <button className="btn sm ghost" onClick={() => setDoc((d) => d || c.id)}>usar</button>
          </div>
        ))}
      </div>

      <div className="card">
        <h3>Fluxo de investigação</h3>
        <label>Caso (id)</label>
        <input className="input" value={caso} onChange={(e) => setCaso(e.target.value)} placeholder="id do caso" />
        <label>Documento alvo (CPF/CNPJ/nome) — vira documento do caso</label>
        <input className="input" value={doc} onChange={(e) => setDoc(e.target.value)} placeholder="000.000.000-00 ou Nome Completo" />
        <label>Nome para estimativa/alerta</label>
        <input className="input" value={alvo} onChange={(e) => setAlvo(e.target.value)} placeholder="Nome Completo" />
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn sm" onClick={() => run(() => a.invDocumento(caso, doc).then((r) => r), "documento")}>📄 Documento</button>
          <button className="btn sm" onClick={() => run(() => a.invConsulta(caso, doc), "consulta")}>🔎 Consulta</button>
          <button className="btn sm" onClick={() => run(() => a.invEstimativa(caso, alvo || doc), "estimativa")}>💰 Estimativa</button>
          <button className="btn sm" onClick={() => run(() => a.invAlerta(caso, alvo || doc), "alerta")}>🚨 Alerta</button>
          <button className="btn sm ghost" onClick={() => run(() => a.invDeepDive(caso, alvo || doc), "deep-dive")}>🧠 Deep-dive</button>
        </div>
        {saida && <pre className="mono" style={{ marginTop: 10 }}>{saida}</pre>}
      </div>
    </>
  );
}

// ═══════════════════════ LICITAÇÕES ═══════════════════════
export function LicitacoesScreen({ a, toast }: P) {
  const [q, setQ] = useState("material escolar");
  const [ufs, setUfs] = useState("");
  const [items, setItems] = useState<Array<Record<string, unknown>>>([]);
  const [interesses, setInteresses] = useState<Array<{ topic: string }>>([]);
  const [filtros, setFiltros] = useState<Array<{ name: string }>>([]);
  const [nomeFiltro, setNomeFiltro] = useState("");
  const carregar = () => {
    a.licitacoesInteresses().then((r) => setInteresses(r.interests)).catch(() => void 0);
    a.filtros("licitacoes").then((r) => setFiltros(r.filters)).catch(() => void 0);
  };
  useEffect(carregar, []);
  const buscar = async () => {
    try {
      const r = await a.licitacoesBusca(q, ufs || undefined);
      setItems(r.items);
      toast(`${r.count} itens encontrados (fonte: PNCP)`);
    } catch (e) {
      toast(`⚠ ${(e as Error).message}`);
    }
  };
  return (
    <>
      <div className="card">
        <h3>📜 Licitações (PNCP)</h3>
        <label>Busca</label>
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="grid2" style={{ marginTop: 8 }}>
          <div>
            <label>UFs (separadas por vírgula)</label>
            <input className="input" value={ufs} onChange={(e) => setUfs(e.target.value)} placeholder="MT,SP" />
          </div>
          <div>
            <label>Nome do filtro</label>
            <input className="input" value={nomeFiltro} onChange={(e) => setNomeFiltro(e.target.value)} placeholder="meu-radar" />
          </div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={buscar}>Buscar</button>
          <button
            className="btn good"
            onClick={async () => {
              if (!nomeFiltro.trim()) return toast("Dê um nome ao filtro");
              try {
                await a.filtroSalvar("licitacoes", nomeFiltro.trim(), { q, ufs });
                await a.acao(XP.filtroSalvo).then((r) => r.xpGanho > 0 && toast(`+${r.xpGanho} XP!`));
                toast("Filtro salvo ✓");
                carregar();
              } catch (e) {
                toast(`⚠ ${(e as Error).message}`);
              }
            }}
          >
            💾 Salvar filtro
          </button>
        </div>
      </div>

      {items.length > 0 && (
        <div className="card">
          <h3>Resultados</h3>
          {items.slice(0, 8).map((it, i) => (
            <div className="list-item" key={i}>
              <div style={{ minWidth: 0 }}>
                <b style={{ fontSize: "0.82rem" }}>{String(it.title ?? it.name ?? it.description ?? "item")}</b>
                <div className="tiny">
                  {String(it.orgao ?? it.agency ?? "")} · {String(it.uf ?? it.state ?? "")} · {String(it.valor ?? it.amount ?? "")}
                </div>
              </div>
            </div>
          ))}
          <button
            className="btn sm ghost"
            onClick={async () => {
              const topic = `lic_${q.slice(0, 12).replace(/\s+/g, "_")}`;
              try {
                await a.licitacaoInteresse(topic, { q, ufs });
                toast("Monitoramento ativo (alertas via Telegram) ✓");
                carregar();
              } catch (e) {
                toast(`⚠ ${(e as Error).message}`);
              }
            }}
          >
            🔔 Monitorar esta busca
          </button>
        </div>
      )}

      <div className="card">
        <h3>🎯 Meus interesses</h3>
        {interesses.length === 0 && <div className="empty">Nenhum monitoramento ativo.</div>}
        {interesses.map((it) => (
          <div className="list-item" key={it.topic}>
            <span className="mono">{it.topic}</span>
            <button
              className="btn sm bad"
              onClick={async () => {
                await a.licitacaoRemoverInteresse(it.topic);
                toast("Removido");
                carregar();
              }}
            >
              remover
            </button>
          </div>
        ))}
      </div>

      <div className="card">
        <h3>💾 Filtros salvos</h3>
        {filtros.length === 0 && <div className="empty">Nenhum filtro ainda.</div>}
        {filtros.map((f) => (
          <div className="list-item" key={f.name}>
            <b>{f.name}</b>
            <button
              className="btn sm ghost"
              onClick={async () => {
                await a.filtroExcluir("licitacoes", f.name);
                toast("Filtro excluído");
                carregar();
              }}
            >
              excluir
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

// ═══════════════════════ CONCURSOS ═══════════════════════
export function ConcursosScreen({ a, toast }: P) {
  const [q, setQ] = useState("concurso público");
  const [items, setItems] = useState<Array<Record<string, unknown>>>([]);
  const [timeline, setTimeline] = useState<Array<Record<string, unknown>>>([]);
  const buscar = async () => {
    try {
      const r = await a.concursos(q);
      setItems(r.items);
      toast(`${r.count} itens do DOU (fonte: leiturajornal, data de hoje)`);
    } catch (e) {
      toast(`⚠ ${(e as Error).message}`);
    }
  };
  return (
    <>
      <div className="card">
        <h3>🎓 Concursos (DOU)</h3>
        <label>Busca</label>
        <div className="row">
          <input className="input grow" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn" onClick={buscar}>Buscar</button>
        </div>
        <p className="tiny" style={{ marginTop: 8 }}>
          Edital aberto, período de inscrição, taxa, vagas/cargo/área, escolaridade, local/UF, banca, resultado — com timeline de eventos (abertura/encerramento/prorrogação/retificação).
        </p>
      </div>
      {items.length > 0 && (
        <div className="card">
          <h3>Resultados</h3>
          {items.slice(0, 8).map((it, i) => (
            <div className="list-item" key={i}>
              <div style={{ minWidth: 0 }}>
                <b style={{ fontSize: "0.8rem" }}>{String(it.title ?? it.concurso ?? "edital")}</b>
                <div className="tiny">{String(it.veiculo ?? "")} · {String(it.dataPublicacao ?? "")}</div>
              </div>
              <button
                className="btn sm ghost"
                onClick={async () => {
                  const id = String(it.externalId ?? it.id ?? i);
                  try {
                    const t = await a.concursoTimeline(id);
                    setTimeline(t.timeline);
                  } catch (e) {
                    toast(`⚠ ${(e as Error).message}`);
                  }
                }}
              >
                timeline
              </button>
            </div>
          ))}
        </div>
      )}
      {timeline.length > 0 && (
        <div className="card">
          <h3>⏱ Timeline</h3>
          {timeline.map((ev, i) => (
            <div className="list-item" key={i}>
              <div>
                <b style={{ fontSize: "0.82rem" }}>{String(ev.tipo ?? ev.kind ?? "evento")}</b>
                <div className="tiny">{String(ev.data ?? ev.at ?? "")}</div>
              </div>
              <span className={`tag ${String(ev.tipo ?? "").includes("retif") ? "amber" : ""}`}>{String(ev.versao ?? "")}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ═══════════════════════ JURÍDICO ═══════════════════════
type ChatMsg = { quem: "user" | "ia"; texto: string; fontes?: string[]; rodape?: string; fontesWeb?: FonteWebDto[]; provedor?: string; diagnostico?: string[] };

const fmtDataBR = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
};
const fmtBRL = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const STATUS_CORES: Record<string, string> = {
  ativo: "green",
  suspenso: "amber",
  arquivado: "red",
  desconhecido: "",
};

export function JuridicoScreen({ a, toast }: P) {
  const [cnj, setCnj] = useState("");
  const [uf, setUf] = useState("MT");
  const [caso, setCaso] = useState<Record<string, unknown> | null>(null);
  const [movimentos, setMovimentos] = useState<LegalEventDto[]>([]);
  const [resumo, setResumo] = useState("");
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [pergunta, setPergunta] = useState("");
  const [digitando, setDigitando] = useState(false);
  const [alertasOn, setAlertasOn] = useState(false);
  const [mostrarTecnico, setMostrarTecnico] = useState(false);
  // —— busca unificada: processos de terceiros + progresso real (plano-busca-unificada §3.5) ——
  const [terceiros, setTerceiros] = useState<ProcessoTercero[]>([]);
  const [fontesInfo, setFontesInfo] = useState<ResultadoEsaj[]>([]);
  const [rodapeTerc, setRodapeTerc] = useState("");
  const [advertenciaBusca, setAdvertenciaBusca] = useState("");
  // —— índice próprio + risco (plano-refatoracao §6.2/§6.6) ——
  const [indiceResp, setIndiceResp] = useState<BuscaIndiceResp | null>(null);
  const [risco, setRisco] = useState<AvaliacaoRiscoResp | null>(null);
  const [catalogo, setCatalogo] = useState<CatalogoFontes | null>(null);
  const [detalhesMap, setDetalhesMap] = useState<Record<string, DetalheTercero>>({});
  const [progresso, setProgresso] = useState<{ ativo: boolean; feitos: number; total: number; rotulo: string }>({
    ativo: false,
    feitos: 0,
    total: 0,
    rotulo: "",
  });
  const run = async (fn: () => Promise<unknown>) => {
    try {
      const r = await fn();
      toast("ok ✓");
      return r;
    } catch (e) {
      toast(`⚠ ${(e as Error).message}`);
      return null;
    }
  };

  useEffect(() => {
    a.processoFontes().then(setCatalogo).catch(() => void 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const carregarCaso = (cnjAlvo: string) =>
    a
      .processo(cnjAlvo)
      .then((p) => {
        setCaso(p.processo);
        setMovimentos(p.movimentos ?? []);
        setResumo(p.resumo ?? "");
        setAlertasOn(Boolean(p.processo?.alertasAtivos));
      })
      .catch(() => void 0);

  const enviarPergunta = async (q: string) => {
    const texto = q.trim();
    if (!texto || !cnj.trim()) return;
    setChat((c) => [...c, { quem: "user", texto }]);
    setPergunta("");
    setDigitando(true);
    try {
      const r = await a.processoPerguntar(cnj.trim(), texto);
      setChat((c) => [...c, { quem: "ia", texto: r.resposta, fontes: r.fontes, rodape: r.rodape }]);
    } catch (e) {
      setChat((c) => [...c, { quem: "ia", texto: `Não consegui responder agora: ${(e as Error).message}` }]);
    } finally {
      setDigitando(false);
    }
  };

  // Detecção local do formato (leitura de UI); o servidor é a autoridade e valida os DVs.
  const digitosConsulta = cnj.trim().replace(/\D+/g, "");
  const tipoConsulta: "" | "cnj" | "cpf" | "cnpj" | "nome" = !cnj.trim()
    ? ""
    : digitosConsulta.length === 20
      ? "cnj"
      : digitosConsulta.length === 11
        ? "cpf"
        : digitosConsulta.length === 14
          ? "cnpj"
          : "nome";
  const rotuloTipo = { cnj: "número de processo", cpf: "CPF", cnpj: "CNPJ", nome: "nome", "": "" }[tipoConsulta];

  const avancar = (feitos: number, total: number, rotulo: string) =>
    setProgresso({ ativo: true, feitos, total, rotulo });

  const buscarRapida = async () => {
    const texto = cnj.trim();
    if (!texto) return;
    avancar(1, 2, "consulta identificada — consultando a fonte…");
    try {
      if (tipoConsulta === "cnj") {
        const r = (await a.processoBuscar(texto, uf)) as Awaited<ReturnType<typeof a.processoBuscar>>;
        setProgresso({ ativo: false, feitos: 0, total: 0, rotulo: "" });
        if (r?.processo) {
          setCaso(r.processo);
          setMovimentos(r.movimentos ?? []);
          setResumo(r.resumo ?? "");
          setAlertasOn(false);
          setChat([]);
          setTerceiros([]);
          setFontesInfo([]);
          setAdvertenciaBusca("");
        }
        return;
      }
      const r = await a.processoPesquisar(texto, uf.toUpperCase() === "TODAS" ? "todas" : uf, 1);
      setTerceiros(r.itens);
      setFontesInfo(r.fontes);
      setRodapeTerc(r.rodape);
      setAdvertenciaBusca(r.advertencia ?? "");
      setDetalhesMap({});
      setProgresso({ ativo: false, feitos: 0, total: 0, rotulo: "" });
      if (!r.itens.length) toast("nenhum processo público encontrado nesta consulta (ver rodapé)");
    } catch (e) {
      setProgresso({ ativo: false, feitos: 0, total: 0, rotulo: "" });
      toast(`⚠ ${(e as Error).message}`);
    }
  };

  const pesquisaProfunda = async () => {
    const texto = cnj.trim();
    if (!texto) return;
    if (tipoConsulta === "cnj") {
      toast("🔬 a pesquisa profunda é por NOME, CPF ou CNPJ — para um processo use 🔎 Buscar");
      return;
    }
    avancar(1, 3, "consultando páginas das fontes verificadas (AC, AL, CE, SP)…");
    try {
      const r1 = await a.processoPesquisar(texto, "todas", 1);
      let itens = [...r1.itens];
      let fontes = [...r1.fontes];
      setAdvertenciaBusca(r1.advertencia ?? "");
      const extras: Array<{ uf: string; pagina: number }> = [];
      for (const f of r1.fontes) {
        for (let p = 2; p <= Math.min(f.ultimaPagina, 10); p++) extras.push({ uf: f.uf, pagina: p });
      }
      // etapas REAIS: 1 detecção + 1 página-1 + páginas extras + 1 cruzamento DataJud
      const total = 2 + extras.length + 1;
      avancar(2, total, `página 1 · ${itens.length} processo(s) até aqui`);
      for (let i = 0; i < extras.length; i++) {
        const e = extras[i]!;
        avancar(2 + i, total, `${e.uf.toUpperCase()} — página ${e.pagina} de ${Math.min(r1.fontes.find((f) => f.uf === e.uf)?.ultimaPagina ?? 1, 10)}`);
        const rp = await a.processoPesquisar(texto, e.uf, e.pagina);
        itens = itens.concat(rp.itens);
        fontes = fontes.concat(rp.fontes);
        avancar(3 + i, total, `${e.uf.toUpperCase()} — página ${e.pagina} · ${itens.length} processo(s) até aqui`);
      }
      avancar(total - 1, total, "cruzando com DataJud (status, valor, último movimento)…");
      const cnjs = [...new Set(itens.map((it) => it.numeroProcesso))].slice(0, 30);
      const mapa: Record<string, DetalheTercero> = {};
      if (cnjs.length) {
        const det = await a.processoDetalhesLote(cnjs);
        for (const it of det.itens) mapa[it.numeroProcesso] = it;
      }
      setDetalhesMap(mapa);
      setTerceiros(itens);
      setFontesInfo(fontes);
      setRodapeTerc(r1.rodape);
      toast(`🔬 pesquisa profunda concluída — ${itens.length} processo(s) de terceiros`);
    } catch (e) {
      toast(`⚠ ${(e as Error).message}`);
    } finally {
      setProgresso({ ativo: false, feitos: 0, total: 0, rotulo: "" });
    }
  };

  // —— modo IA de buscador no chat (plano-91-tribunais-ia §1.3) — pesquisa web REAL ——
  const buscarWebChat = async () => {
    const texto = pergunta.trim();
    if (!texto) {
      toast("digite a pergunta no campo do chat (ex.: qual o prazo de apelação no CPC?) e toque em 🔎 Buscar na web");
      return;
    }
    setChat((c) => [...c, { quem: "user", texto: `🌐 (busca web) ${texto}` }]);
    setPergunta("");
    setDigitando(true);
    avancar(1, 2, "pesquisando na web (resultados reais, sem chave)…");
    try {
      const r = await a.processoBuscarWeb(texto);
      avancar(2, 2, "fontes recebidas");
      setChat((c) => [
        ...c,
        {
          quem: "ia",
          texto: `${r.geradaPorIA ? "🤖 resposta gerada com citações" : "🌐 resultados reais da web"} · provedor: ${r.provedor}\n\n${r.resposta}`,
          fontesWeb: r.fontes,
          diagnostico: (r.diagnostico ?? []).map((d) => `${d.backend} ${d.status}${d.motivo ? ` (${d.motivo})` : ""}`),
          rodape: r.rodape,
        },
      ]);
    } catch (e) {
      setChat((c) => [...c, { quem: "ia", texto: `A busca web não respondeu agora: ${(e as Error).message}` }]);
    } finally {
      setDigitando(false);
      setProgresso({ ativo: false, feitos: 0, total: 0, rotulo: "" });
    }
  };

  const buscarIndice = async () => {
    const texto = cnj.trim();
    if (!texto) return;
    avancar(1, 2, "consultando o índice próprio (Postgres)…");
    try {
      const r = await a.processoBuscarIndice(texto, uf.toUpperCase() === "TODAS" ? {} : { uf: uf.toLowerCase() });
      setIndiceResp(r);
      setRisco(null);
      avancar(2, 2, `índice: ${r.itens.length} resultado(s) de ${r.totalNoIndice} processo(s) indexados`);
      if (!r.itens.length) toast("índice sem resultado — use 🔎 Buscar (fontes ao vivo) ou 🔬 Pesquisa profunda");
    } catch (e) {
      toast(`⚠ ${(e as Error).message}`);
    } finally {
      setProgresso({ ativo: false, feitos: 0, total: 0, rotulo: "" });
    }
  };

  const avaliarCriticidade = async () => {
    const texto = cnj.trim();
    if (!texto) return toast("informe nome, CPF ou número para avaliar a criticidade");
    try {
      const r = await a.processoRisco(texto);
      setRisco(r);
      toast(`🎯 criticidade ${r.criticidade}/10 (${r.faixa}) sobre ${r.considerados} processo(s)`);
    } catch (e) {
      toast(`⚠ ${(e as Error).message}`);
    }
  };

  const acoes = [
    {
      rotulo: "🔎 Buscar",
      cls: "btn",
      titulo: "Processo por CNJ · processos de terceiros por nome, CPF ou CNPJ",
      fn: buscarRapida,
    },
    {
      rotulo: "🔬 Pesquisa profunda",
      cls: "btn ghost",
      titulo: "Nome/CPF/CNPJ → todas as fontes verificadas, todas as páginas + cruzamento DataJud",
      fn: pesquisaProfunda,
    },
    {
      rotulo: "🗂️ Buscar no índice",
      cls: "btn ghost",
      titulo: "Buscar no índice próprio (nomes/processos já coletados) — rápido, com grau de certeza do vínculo",
      fn: buscarIndice,
    },
    {
      rotulo: "🎯 Criticidade",
      cls: "btn ghost",
      titulo: "Motor determinístico: score 0–10 com justificativas auditáveis por processo",
      fn: avaliarCriticidade,
    },
    {
      rotulo: "⚖️ Acompanhar",
      cls: "btn good",
      titulo: "Registrar na sua lista e sincronizar movimentos",
      fn: async () => {
        if (tipoConsulta !== "cnj") return toast("⚖️ acompanhar é para um processo — informe o número CNJ ou abra um dos resultados");
        await run(() => a.processoAcompanhar(cnj.trim(), uf));
        await run(() => a.processoSync(cnj.trim()));
        await carregarCaso(cnj.trim());
      },
    },
    {
      rotulo: "🔔 Alertar",
      cls: "btn ghost",
      titulo: "Avisar no Telegram quando houver movimentação nova",
      fn: async () => {
        if (tipoConsulta !== "cnj") return toast("🔔 alertar é para um processo — informe o número CNJ ou abra um dos resultados");
        const r = (await run(() => a.processoAlertar(cnj.trim()))) as { alertasAtivos?: boolean } | null;
        if (r?.alertasAtivos) {
          setAlertasOn(true);
          toast("🔔 Alertas ativados — você será avisado das movimentações novas");
        }
      },
    },
    {
      rotulo: "💬 Explicar",
      cls: "btn ghost",
      titulo: "Conversar com o assistente sobre o processo",
      fn: async () => {
        if (tipoConsulta !== "cnj") return toast("💬 explicar é para um processo — informe o número CNJ ou abra um dos resultados");
        if (!caso) await carregarCaso(cnj.trim());
        setChat((c) =>
          c.length
            ? c
            : [
                {
                  quem: "ia",
                  texto:
                    "Olá! Sou o assistente do Acompanhe.IA. Respondo com base nos dados públicos deste processo (DataJud/CNJ) e na tabela oficial de movimentos do CNJ — sem inventar. Pergunte o que quiser saber.",
                  fontes: ["DataJud/CNJ + tabela oficial de movimentos (Res. 46/2007)"],
                  rodape: "conteúdo informativo, não é parecer jurídico",
                },
              ],
        );
        document.getElementById("chat-juridico")?.scrollIntoView({ behavior: "smooth", block: "center" });
      },
    },
  ];

  return (
    <>
      <div className="card">
        <h3>⚖️ Jurídico — busca por nome, CPF ou número do processo</h3>
        <p className="mut">
          Um campo único identifica o que você digitou. Número CNJ → dados oficiais do DataJud/CNJ nos
          <strong> 91 tribunais do Brasil</strong> (STF não publica no DataJud). Nome, CPF ou CNPJ → processos públicos
          em que a pessoa/empresa figura como parte, nas fontes de consulta pública verificadas (AC, AL, CE, SP);
          demais tribunais: use o nº do processo ou o portal oficial indicado.
        </p>
        <label>Nome, CPF ou número do processo</label>
        <input
          className="input"
          value={cnj}
          onChange={(e) => setCnj(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void buscarRapida();
          }}
          placeholder="ex.: João Carlos da Silva · 529.982.247-25 · 1058234-41.2026.8.11.0041"
        />
        {tipoConsulta && (
          <span className="tag green" style={{ marginTop: 6, alignSelf: "flex-start" }}>
            detectado: {rotuloTipo}
          </span>
        )}
        <label>UF (tribunal) — use "todas" na pesquisa por nome</label>
        <input className="input" value={uf} onChange={(e) => setUf(e.target.value.toUpperCase())} maxLength={5} />
        <div className="row" style={{ marginTop: 10, flexWrap: "wrap", gap: 8 }}>
          {acoes.map((ac) => (
            <button key={ac.rotulo} className={ac.cls} title={ac.titulo} onClick={() => void ac.fn()}>
              {ac.rotulo}
            </button>
          ))}
          <button
            className="btn ghost"
            title="Buscar movimentações novas no DataJud"
            onClick={async () => {
              if (tipoConsulta !== "cnj") return toast("🔄 sincronizar é para um processo — informe o número CNJ");
              const r = (await run(() => a.processoSync(cnj.trim()))) as { novos?: number } | null;
              if (r) {
                toast(`Sincronizado: ${r.novos ?? 0} movimento(s) novo(s)`);
                await carregarCaso(cnj.trim());
              }
            }}
          >
            🔄 Sincronizar
          </button>
        </div>
        {progresso.ativo && (
          <div style={{ marginTop: 12 }}>
            <div
              style={{
                height: 10,
                background: "var(--surface-2)",
                border: "1px solid var(--line-hair)",
                borderRadius: 999,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${progresso.total ? Math.round((progresso.feitos / progresso.total) * 100) : 0}%`,
                  height: "100%",
                  background: "var(--acc, #2563eb)",
                  borderRadius: 999,
                  transition: "width .35s ease",
                }}
              />
            </div>
            <div className="mut" style={{ fontSize: "0.75rem", marginTop: 4 }}>
              {progresso.rotulo}
              {progresso.total ? ` · etapa ${Math.min(progresso.feitos + 1, progresso.total)}/${progresso.total}` : ""}
            </div>
          </div>
        )}
        {alertasOn && (
          <p className="mut" style={{ marginTop: 8, color: "var(--good)" }}>
            🔔 alertas de movimentação ATIVADOS para este processo
          </p>
        )}
      </div>

      {catalogo && (
        <div className="card">
          <h3>🗺️ Cobertura real das fontes</h3>
          <p className="mut" style={{ fontSize: "0.8rem", marginTop: 0 }}>
            Nº de processo: <strong>{catalogo.cobertura.numero.tribunais} tribunais</strong> (DataJud/CNJ) · Nome/CPF/CNPJ:{" "}
            <strong>{catalogo.cobertura.nome.ufs.map((u) => u.toUpperCase()).join(", ")}</strong> (e-SAJ) · Índice próprio:{" "}
            {catalogo.fontes.find((f) => f.id === "indice")?.estado === "ativo" ? "ativo" : "inativo"}
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {catalogo.fontes.map((f) => (
              <div key={f.id} className="row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap", background: "var(--surface-2)", border: "1px solid var(--line-hair)", borderRadius: 10, padding: "6px 10px" }}>
                <div>
                  <div style={{ fontSize: "0.82rem" }}>{f.nome}</div>
                  {f.limitacao && <div className="mut" style={{ fontSize: "0.72rem" }}>{f.limitacao}</div>}
                </div>
                <span className="tag" style={{ borderColor: f.estado === "ativo" ? "var(--good)" : "var(--amber, #b45309)", fontSize: "0.7rem" }}>
                  {f.estado === "ativo" ? "verificado" : f.estado} · {f.verificadoEm}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {risco && (
        <div className="card">
          <h3>🎯 Criticidade (motor determinístico)</h3>
          <p style={{ margin: "4px 0 8px" }}>
            <strong style={{ fontSize: "1.4rem" }}>{risco.criticidade}/10</strong>{" "}
            <span className={`tag ${risco.faixa === "baixo" ? "" : risco.faixa === "medio" ? "" : "green"}`}>{risco.faixa}</span>{" "}
            <span className="mut" style={{ fontSize: "0.75rem" }}>
              · {risco.considerados} processo(s) considerados · regras {risco.versaoRegras}
            </span>
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {risco.justificativas.length === 0 && <p className="mut" style={{ fontSize: "0.8rem" }}>Nenhuma regra de risco foi acionada.</p>}
            {risco.justificativas.map((j, i) => (
              <div key={`${j.regra}-${i}`} style={{ background: "var(--surface-2)", border: "1px solid var(--line-hair)", borderRadius: 10, padding: "6px 10px", fontSize: "0.8rem" }}>
                <span className="mono" style={{ fontSize: "0.7rem", opacity: 0.8 }}>+{j.criticidade} · {j.regra}</span>
                <div>{j.motivo}</div>
                {j.processo && <div className="mut mono" style={{ fontSize: "0.7rem" }}>{j.processo}</div>}
              </div>
            ))}
          </div>
          <p className="mut" style={{ fontSize: "0.72rem", marginTop: 8 }}>{risco.rodape}</p>
        </div>
      )}

      {indiceResp && (
        <div className="card">
          <h3>🗂️ Índice próprio — {indiceResp.itens.length} resultado(s)</h3>
          <p className="mut" style={{ fontSize: "0.78rem", marginTop: 0 }}>
            {indiceResp.totalNoIndice} processo(s) indexados · cada item mostra o <strong>grau de certeza do vínculo</strong>
          </p>
          {indiceResp.facetas.tribunais.length > 0 && (
            <div className="row" style={{ flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
              {indiceResp.facetas.tribunais.map((t) => (
                <span key={t.valor} className="tag" style={{ fontSize: "0.72rem" }}>{t.valor} ({t.total})</span>
              ))}
              {indiceResp.facetas.anos.slice(0, 4).map((an) => (
                <span key={an.valor} className="tag" style={{ fontSize: "0.72rem" }}>{an.valor} ({an.total})</span>
              ))}
            </div>
          )}
          {indiceResp.advertencia && (
            <p className="mut" style={{ fontSize: "0.78rem", color: "var(--amber, #b45309)" }}>⚠ {indiceResp.advertencia}</p>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {indiceResp.itens.map((it) => (
              <div key={it.processo.numeroCnj} style={{ background: "var(--surface-2)", border: "1px solid var(--line-hair)", borderRadius: 12, padding: "10px 12px" }}>
                <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
                  <div>
                    <div className="mono" style={{ fontSize: "0.82rem" }}>{it.processo.numeroCnj}</div>
                    {it.parteEncontrada && <div style={{ fontSize: "0.84rem" }}>{it.parteEncontrada}</div>}
                    <div className="mut" style={{ fontSize: "0.75rem" }}>
                      {[it.processo.classe, it.processo.assunto].filter(Boolean).join(" · ") || "classe não informada"}
                      {it.processo.orgaoJulgador ? ` · ${it.processo.orgaoJulgador}` : ""}
                    </div>
                    <div className="mut" style={{ fontSize: "0.72rem" }}>
                      vínculo: {it.motivoLegivel} · atualizado em {fmtDataBR(it.processo.atualizadoEm)} · fonte {it.processo.fonte}
                    </div>
                  </div>
                  <div className="row" style={{ gap: 6, alignItems: "center" }}>
                    <span className="tag green" title="grau de certeza do vínculo (0–1)">{Math.round(it.score * 100)}%</span>
                    <button
                      className="btn"
                      style={{ padding: "6px 10px", fontSize: "0.78rem" }}
                      onClick={async () => {
                        setCnj(it.processo.numeroCnj);
                        await carregarCaso(it.processo.numeroCnj);
                      }}
                    >
                      abrir
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <p className="mut" style={{ fontSize: "0.72rem", marginTop: 10 }}>{indiceResp.rodape}</p>
        </div>
      )}

      {(terceiros.length > 0 || fontesInfo.length > 0) && (
        <div className="card">
          <h3>🔎 Processos de terceiros encontrados</h3>
          {fontesInfo.map((f) => (
            <p key={f.fonte} className="mut" style={{ fontSize: "0.78rem", margin: "2px 0" }}>
              {f.fonte.toUpperCase()}:{" "}
              {f.estado === "resultados"
                ? `${f.itens.length} nesta página · ${f.total ?? "?"} processo(s) no total`
                : f.estado === "multiplos"
                  ? "muitos processos para esse termo — informe nome e sobrenome mais completos"
                  : f.estado === "vazio"
                    ? "sem registros públicos para esta consulta"
                    : f.estado === "bloqueado"
                      ? "fonte bloqueou o acesso no momento — tente mais tarde ou use o portal do tribunal"
                      : "fonte indisponível neste momento"}
            </p>
          ))}
          {advertenciaBusca && (
            <p className="mut" style={{ fontSize: "0.78rem", margin: "2px 0", color: "var(--amber, #b45309)" }}>⚠ {advertenciaBusca}</p>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
            {terceiros.map((it) => {
              const det = detalhesMap[it.numeroProcesso];
              return (
                <div
                  key={`${it.fonte}-${it.numeroProcesso}-${it.codigoInterno ?? ""}`}
                  style={{ background: "var(--surface-2)", border: "1px solid var(--line-hair)", borderRadius: 12, padding: "10px 12px" }}
                >
                  <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                    <div>
                      <div className="mono" style={{ fontSize: "0.82rem" }}>{it.numeroProcesso}</div>
                      <div style={{ fontSize: "0.84rem", marginTop: 2 }}>
                        {it.participacao ? `${it.participacao}: ` : ""}
                        {it.nomeParte ?? "parte não exibida pela fonte"}
                      </div>
                      <div className="mut" style={{ fontSize: "0.75rem", marginTop: 2 }}>
                        {[it.classe, it.assunto].filter(Boolean).join(" · ") || "classe/assunto não informados"}
                        {it.foro ? ` · ${it.foro}` : ""}
                        {it.dataDistribuicao ? ` · distribuído em ${it.dataDistribuicao}` : ""}
                      </div>
                      <div className="mut" style={{ fontSize: "0.75rem", marginTop: 2 }}>
                        {det
                          ? `status (DataJud): ${det.status ?? "não informado"}${det.ultimoMovimento ? ` · último movimento: ${det.ultimoMovimento.nome}` : ""}`
                          : "status: não cruzado com DataJud (use 🔬 Pesquisa profunda)"}
                      </div>
                    </div>
                    <div className="row" style={{ gap: 6 }}>
                      <button
                        className="btn"
                        style={{ padding: "6px 10px", fontSize: "0.78rem" }}
                        onClick={async () => {
                          setCnj(it.numeroProcesso);
                          await carregarCaso(it.numeroProcesso);
                          document.getElementById("processo-juridico")?.scrollIntoView({ behavior: "smooth", block: "start" });
                        }}
                      >
                        abrir
                      </button>
                      <a className="btn ghost" style={{ padding: "6px 10px", fontSize: "0.78rem" }} href={it.url} target="_blank" rel="noreferrer noopener">
                        fonte
                      </a>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mut" style={{ fontSize: "0.72rem", marginTop: 10, lineHeight: 1.5 }}>{rodapeTerc}</p>
        </div>
      )}

      {caso && (
        <div className="card" id="processo-juridico">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ margin: 0 }}>Processo</h3>
            <span className={`tag ${STATUS_CORES[String(caso.status ?? "")] ?? ""}`}>
              {String(caso.status ?? "desconhecido")}
            </span>
          </div>
          <p className="mono mut" style={{ margin: "6px 0 12px", fontSize: "0.85rem" }}>
            {String(caso.numeroProcesso ?? cnj)}
          </p>
          {resumo && (
            <p style={{ fontSize: "0.92rem", lineHeight: 1.55, background: "var(--acc-soft)", border: "1px solid var(--line-hair)", borderRadius: 12, padding: "10px 12px" }}>
              {resumo}
            </p>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 10, marginTop: 12 }}>
            {[
              { rot: "Tipo de ação", val: `${String(caso.classe ?? "—")}${caso.assunto ? ` · ${String(caso.assunto)}` : ""}` },
              { rot: "Onde tramita", val: `${String(caso.orgaoJulgador ?? "—")} · ${String(caso.tribunal ?? "").toUpperCase()}` },
              { rot: "Instância", val: String(caso.grau) === "G2" ? "2ª instância (tribunal)" : String(caso.grau) === "G1" ? "1ª instância (juízo)" : String(caso.grau || "—") },
              { rot: "Quando começou", val: fmtDataBR(String(caso.dataAjuizamento ?? "")) },
              {
                rot: "Valor da causa",
                val: caso.valorDaCausa != null ? fmtBRL(Number(caso.valorDaCausa)) : "não informado nos dados públicos",
              },
              {
                rot: "Última movimentação",
                val: caso.ultimoMovimento
                  ? `${String((caso.ultimoMovimento as { nome: string }).nome)} · ${fmtDataBR(String((caso.ultimoMovimento as { dataHora: string }).dataHora))}`
                  : "sem movimentações registradas",
              },
            ].map((f) => (
              <div key={f.rot} style={{ background: "var(--surface-2)", border: "1px solid var(--line-hair)", borderRadius: 12, padding: "10px 12px" }}>
                <div className="mut" style={{ fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: 0.6 }}>{f.rot}</div>
                <div style={{ fontSize: "0.9rem", marginTop: 4, lineHeight: 1.4 }}>{f.val}</div>
              </div>
            ))}
          </div>

          <h4 style={{ margin: "16px 0 8px" }}>🗓️ Movimentações ({movimentos.length})</h4>
          {movimentos.length === 0 && <p className="mut">Nenhuma movimentação registrada ainda — toque em Sincronizar.</p>}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[...movimentos]
              .sort((x, y) => (x.dataHora < y.dataHora ? 1 : -1))
              .slice(0, mostrarTecnico ? movimentos.length : 8)
              .map((m, i) => (
                <div key={`${m.codigo}-${m.dataHora}-${i}`} className="row" style={{ background: "var(--surface-2)", border: "1px solid var(--line-hair)", borderRadius: 12, padding: "10px 12px", alignItems: "center", justifyContent: "space-between" }}>
                  <div>
                    <div style={{ fontSize: "0.86rem" }}>{m.nome}</div>
                    <div className="mut" style={{ fontSize: "0.75rem" }}>
                      {fmtDataBR(m.dataHora)} · mov. {m.codigo}
                    </div>
                  </div>
                  <button className="btn ghost" style={{ padding: "6px 10px", fontSize: "0.78rem" }} onClick={() => void enviarPergunta(`o que significa o movimento ${m.nome}?`)}>
                    o que é?
                  </button>
                </div>
              ))}
          </div>
          {movimentos.length > 8 && (
            <button className="btn ghost" style={{ marginTop: 10 }} onClick={() => setMostrarTecnico((v) => !v)}>
              {mostrarTecnico ? "ver menos" : `ver todas (${movimentos.length})`}
            </button>
          )}

          <details style={{ marginTop: 14 }}>
            <summary className="mut" style={{ cursor: "pointer", fontSize: "0.8rem" }}>ver dados técnicos (JSON)</summary>
            <pre className="mono" style={{ fontSize: "0.68rem", overflow: "auto", maxHeight: 260, background: "var(--surface-2)", borderRadius: 10, padding: 10 }}>
              {JSON.stringify(caso, null, 2)}
            </pre>
          </details>
        </div>
      )}

      <div className="card" id="chat-juridico">
        <h3>💬 Assistente do processo</h3>
        <p className="mut">
          Respostas fundamentadas: dados reais do processo + tabela oficial de movimentos do CNJ + base legal citada. Nada inventado.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, margin: "12px 0" }}>
          {chat.map((m, i) => (
            <div
              key={i}
              style={{
                alignSelf: m.quem === "user" ? "flex-end" : "flex-start",
                maxWidth: "88%",
                background: m.quem === "user" ? "var(--acc-soft)" : "var(--surface-2)",
                border: "1px solid var(--line-hair)",
                borderRadius: 14,
                padding: "10px 12px",
              }}
            >
              <div style={{ fontSize: "0.88rem", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{m.texto}</div>
              {m.fontes && m.fontes.length > 0 && (
                <div className="mut" style={{ fontSize: "0.72rem", marginTop: 8 }}>
                  fontes: {m.fontes.join(" · ")}
                </div>
              )}
              {m.fontesWeb && m.fontesWeb.length > 0 && (
                <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                  {m.fontesWeb.map((f, k) => (
                    <a
                      key={`${f.url}-${k}`}
                      href={f.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      style={{ fontSize: "0.78rem", lineHeight: 1.4, textDecoration: "none", border: "1px solid var(--line-hair)", borderRadius: 10, padding: "6px 10px", display: "block" }}
                    >
                      <div style={{ fontWeight: 600 }}>{k + 1}. {f.titulo}</div>
                      {f.trecho && <div className="mut" style={{ fontSize: "0.72rem", marginTop: 2 }}>{f.trecho.slice(0, 200)}{f.trecho.length > 200 ? "…" : ""}</div>}
                      <div className="mut mono" style={{ fontSize: "0.68rem", marginTop: 2 }}>{f.url}</div>
                    </a>
                  ))}
                </div>
              )}
              {m.diagnostico && m.diagnostico.length > 0 && (
                <div className="mut mono" style={{ fontSize: "0.66rem", marginTop: 6 }}>
                  tentativas: {m.diagnostico.join(" · ")}
                </div>
              )}
              {m.rodape && (
                <div className="mut" style={{ fontSize: "0.7rem", marginTop: 4, fontStyle: "italic" }}>{m.rodape}</div>
              )}
            </div>
          ))}
          {digitando && <div className="mut" style={{ fontSize: "0.8rem" }}>analisando os dados do processo…</div>}
        </div>
        <div className="row" style={{ flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
          {["Resuma o processo", "Qual o status agora?", "O que aconteceu por último?", "O que significa o último movimento?", "Quais prazos devo observar?", "E agora, qual o próximo passo?"].map((s) => (
            <button key={s} className="tag" style={{ cursor: "pointer", border: "1px solid var(--line-hair)" }} onClick={() => void enviarPergunta(s)}>
              {s}
            </button>
          ))}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <input
            className="input"
            value={pergunta}
            onChange={(e) => setPergunta(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void enviarPergunta(pergunta);
            }}
            placeholder="Pergunte sobre o processo…"
            style={{ flex: 1 }}
          />
          <button className="btn good" onClick={() => void enviarPergunta(pergunta)}>
            Perguntar
          </button>
          <button className="btn ghost" title="Pesquisar na web (resultados reais com fontes; com AI_API_KEY configurada, resposta gerada com citações)" onClick={() => void buscarWebChat()}>
            🔎 Buscar na web
          </button>
        </div>
        <button
          className="btn ghost"
          style={{ marginTop: 10 }}
          onClick={async () => {
            const r = (await run(() => a.juridicoConsulta(cnj.trim(), uf))) as { consolidado?: boolean } | null;
            if (r?.consolidado) toast("Você já tem consulta nesta janela de 6h — acompanhamento consolidado");
            else if (r) toast("Consulta registrada — será encaminhada a advogado com OAB verificada");
          }}
        >
          👨‍⚖️ Falar com advogado (OAB verificada)
        </button>
      </div>
    </>
  );
}

// ═══════════════════════ EMPRÉSTIMOS ═══════════════════════
export function EmprestimosScreen({ a, toast }: P) {
  const [feed, setFeed] = useState<LoanRequestDto[]>([]);
  const [matches, setMatches] = useState<LoanMatchDto[]>([]);
  const [valor, setValor] = useState("300");
  const [taxa, setTaxa] = useState("4");
  const [parcelas, setParcelas] = useState("1");
  const [finalidade, setFinalidade] = useState("emergência");
  const [uf, setUf] = useState("SP");
  const [verif, setVerif] = useState<{ status: string; level: string | null }>({ status: "unverified", level: null });
  const [detalhe, setDetalhe] = useState("");
  const carregar = () => {
    a.feed().then((r) => setFeed(r.items)).catch(() => void 0);
    a.matches().then((r) => setMatches(r.matches)).catch(() => void 0);
    a.verificacao().then((r) => setVerif({ status: r.status, level: r.level ?? null })).catch(() => void 0);
  };
  useEffect(carregar, []);
  return (
    <>
      <div className="card">
        <h3>🤝 Empréstimos entre primos</h3>
        <p className="mut">Match bilateral com rodadas de taxa (até 3), expiração de 72h e pagamento com declaração+confirmação (quem declara não confirma).</p>
        <div className="row">
          <span className={`tag ${verif.status === "approved" ? "green" : "amber"}`}>
            verificação: {verif.status}
            {verif.level ? ` (${verif.level})` : ""}
          </span>
          <span className="tag">valor mín. R$ 50</span>
        </div>
      </div>

      <div className="card">
        <h3>💸 Pedir emprestado</h3>
        <div className="grid2">
          <div>
            <label>Valor (R$)</label>
            <input className="input" value={valor} onChange={(e) => setValor(e.target.value)} inputMode="decimal" />
          </div>
          <div>
            <label>Taxa (% a.a.)</label>
            <input className="input" value={taxa} onChange={(e) => setTaxa(e.target.value)} inputMode="decimal" />
          </div>
          <div>
            <label>Parcelas</label>
            <input className="input" value={parcelas} onChange={(e) => setParcelas(e.target.value)} inputMode="numeric" />
          </div>
          <div>
            <label>UF</label>
            <input className="input" value={uf} onChange={(e) => setUf(e.target.value.toUpperCase())} maxLength={2} />
          </div>
        </div>
        <label>Finalidade</label>
        <input className="input" value={finalidade} onChange={(e) => setFinalidade(e.target.value)} />
        <button
          className="btn"
          style={{ marginTop: 10 }}
          onClick={async () => {
            try {
              await a.proposta({
                valorCents: Math.round(parseFloat(valor) * 100),
                taxaPct: parseFloat(taxa),
                parcelas: parseInt(parcelas, 10),
                finalidade,
                uf,
              });
              await a.acao(XP.propostaEmprestimo).then((r) => r.xpGanho > 0 && toast(`+${r.xpGanho} XP!`));
              toast("Proposta publicada no feed ✓");
              carregar();
            } catch (e) {
              toast(`⚠ ${(e as Error).message}`);
            }
          }}
        >
          Publicar proposta
        </button>
      </div>

      <div className="card">
        <h3>📡 Feed de pedidos</h3>
        {feed.length === 0 && <div className="empty">Nenhum pedido aberto agora.</div>}
        {feed.map((f) => (
          <div className="list-item" key={f.id}>
            <div>
              <b>{fmt(f.valorCents)} · {f.taxaPct}% a.a. · {f.parcelas}x</b>
              <div className="tiny">
                {f.finalidade} · {f.uf} · <span className="mono">{f.id}</span>
              </div>
            </div>
            <button
              className="btn sm good"
              onClick={async () => {
                try {
                  const r = await a.interesse(f.id);
                  toast(`Match criado! Expira em 72h (${r.expiraEm?.slice(0, 10) ?? "—"})`);
                  carregar();
                } catch (e) {
                  toast(`⚠ ${(e as Error).message}`);
                }
              }}
            >
              Tenho interesse
            </button>
          </div>
        ))}
      </div>

      <div className="card">
        <h3>🧾 Meus matches</h3>
        {matches.length === 0 && <div className="empty">Nenhum match ainda.</div>}
        {matches.map((m) => (
          <div className="list-item" key={m.id}>
            <div style={{ minWidth: 0 }}>
              <b className="mono" style={{ fontSize: "0.75rem" }}>{m.id}</b>
              <div className="tiny">
                {m.status}
                {m.expiraEm ? ` · expira ${m.expiraEm.slice(0, 10)}` : ""}
              </div>
              <div className="row" style={{ marginTop: 6 }}>
                <button
                  className="btn sm ghost"
                  onClick={async () => {
                    const r = await a.match(m.id).catch((e: Error) => ({ rodadas: [], match: m, erro: e.message }));
                    setDetalhe(JSON.stringify(r, null, 2));
                  }}
                >
                  detalhes
                </button>
                <button className="btn sm" onClick={() => a.aceitar(m.id).then(() => { toast("Aceito! Agora as rodadas de taxa."); carregar(); }).catch((e: Error) => toast(`⚠ ${e.message}`))}>
                  aceitar
                </button>
                <button
                  className="btn sm good"
                  onClick={() =>
                    a
                      .rodada(m.id, { roundNumber: 1, annualRatePct: 10, amountCents: 30000, installmentCount: 1 })
                      .then(() => toast("Rodada proposta"))
                      .catch((e: Error) => toast(`⚠ ${e.message}`))
                  }
                >
                  rodada
                </button>
                <button className="btn sm warn" onClick={() => a.pagamento("declared", m.id).then(() => toast("Pagamento declarado — o outro lado confirma.")).catch((e: Error) => toast(`⚠ ${e.message}`))}>
                  declarar
                </button>
                <button className="btn sm ghost" onClick={() => a.pagamento("confirmed", m.id).then(() => toast("Confirmado ✓")).catch((e: Error) => toast(`⚠ ${e.message}`))}>
                  confirmar
                </button>
              </div>
            </div>
          </div>
        ))}
        {detalhe && <pre className="mono">{detalhe}</pre>}
      </div>
    </>
  );
}

// ═══════════════════════ ANOTA ═══════════════════════
export function AnotaScreen({ a, toast }: P) {
  const [aba, setAba] = useState<"notas" | "gastos">("notas");
  const [notas, setNotas] = useState<NotaDto[]>([]);
  const [gastos, setGastos] = useState<GastoDto[]>([]);
  const [titulo, setTitulo] = useState("");
  const [conteudo, setConteudo] = useState("");
  const [busca, setBusca] = useState("");
  const [desc, setDesc] = useState("");
  const [valor, setValor] = useState("");
  const [cat, setCat] = useState("mercado");
  const [resumo, setResumo] = useState<{ totalCents: number; topCategorias: Array<[string, number]> } | null>(null);
  const carregar = () => {
    a.notas().then((r) => setNotas(r.notas)).catch(() => void 0);
    a.gastos(mesAtual()).then((r) => setGastos(r.gastos)).catch(() => void 0);
    a.resumo(mesAtual()).then(setResumo).catch(() => void 0);
  };
  useEffect(carregar, []);
  return (
    <>
      <div className="card">
        <h3>📒 AnotA — finanças sem esforço</h3>
        <div className="row">
          <button className={`chip ${aba === "notas" ? "on" : ""}`} onClick={() => setAba("notas")}>📝 Notas</button>
          <button className={`chip ${aba === "gastos" ? "on" : ""}`} onClick={() => setAba("gastos")}>💸 Gastos</button>
          <button
            className="chip"
            onClick={async () => {
              const csv = await a.exportCsv(mesAtual());
              const blob = new Blob([csv], { type: "text/csv" });
              const url = URL.createObjectURL(blob);
              const el = document.createElement("a");
              el.href = url;
              el.download = `gastos-${mesAtual()}.csv`;
              el.click();
              toast("CSV exportado ✓");
            }}
          >
            ⬇ CSV
          </button>
        </div>
      </div>

      {aba === "notas" && (
        <>
          <div className="card">
            <label>Nova nota</label>
            <input className="input" value={titulo} onChange={(e) => setTitulo(e.target.value)} placeholder="Título" />
            <label>Conteúdo</label>
            <textarea value={conteudo} onChange={(e) => setConteudo(e.target.value)} placeholder="Anotação… (busca por termo incluso)" />
            <button
              className="btn"
              style={{ marginTop: 8 }}
              onClick={async () => {
                if (!titulo.trim()) return toast("Título obrigatório");
                await a.notaCriar({ title: titulo.trim(), body: conteudo, tags: [] });
                await a.acao(XP.notaCriada).then((r) => r.xpGanho > 0 && toast(`+${r.xpGanho} XP!`));
                setTitulo("");
                setConteudo("");
                toast("Nota salva ✓");
                carregar();
              }}
            >
              Salvar nota
            </button>
          </div>
          <div className="card">
            <div className="row">
              <input className="input grow" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar nas notas…" />
              <button
                className="btn sm ghost"
                onClick={async () => {
                  const r = busca.trim() ? await a.notaBuscar(busca) : await a.notas();
                  setNotas(r.notas);
                }}
              >
                buscar
              </button>
            </div>
            {notas.length === 0 && <div className="empty">Sem notas ainda.</div>}
            {notas.map((n) => (
              <div className="list-item" key={n.id}>
                <div>
                  <b>{n.title}</b>
                  <div className="tiny">{(n.body ?? "").slice(0, 80)}</div>
                </div>
                <span className="tiny">{n.createdAt.slice(0, 10)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {aba === "gastos" && (
        <>
          <div className="card">
            <h3>💸 Lançar gasto</h3>
            <div className="grid2">
              <div>
                <label>Descrição</label>
                <input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} />
              </div>
              <div>
                <label>Valor (R$)</label>
                <input className="input" value={valor} onChange={(e) => setValor(e.target.value)} inputMode="decimal" />
              </div>
            </div>
            <label>Categoria</label>
            <select className="input" value={cat} onChange={(e) => setCat(e.target.value)}>
              {["mercado", "aluguel", "transporte", "saúde", "educação", "lazer", "outros"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <div className="row" style={{ marginTop: 10 }}>
              <button
                className="btn"
                onClick={async () => {
                  if (!desc.trim() || !valor) return toast("Preencha descrição e valor");
                  await a.gastoCriar({ description: desc.trim(), amountCents: Math.round(parseFloat(valor) * 100), category: cat, spentAt: new Date().toISOString().slice(0, 10) });
                  await a.acao(XP.gastoCriado).then((r) => r.xpGanho > 0 && toast(`+${r.xpGanho} XP!`));
                  setDesc("");
                  setValor("");
                  toast("Gasto lançado ✓");
                  carregar();
                }}
              >
                Lançar
              </button>
              <label className="btn ghost" style={{ margin: 0, cursor: "pointer" }}>
                📷 Foto do cupom (OCR)
                <input
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = async () => {
                      try {
                        const b64 = String(reader.result);
                        const r = await a.ocr(b64);
                        setDesc(r.texto.slice(0, 120) || "cupom");
                        toast(`OCR real (tesseract): ${r.chars} caracteres lidos`);
                      } catch (err) {
                        toast(`⚠ ${(err as Error).message}`);
                      }
                    };
                    reader.readAsDataURL(file);
                  }}
                />
              </label>
            </div>
          </div>
          {resumo && (
            <div className="card">
              <h3>📊 Resumo de {mesAtual()}</h3>
              <div className="kv">
                <span>Total no mês</span>
                <b>{fmt(resumo.totalCents)}</b>
              </div>
              {resumo.topCategorias.slice(0, 5).map(([c, cents]) => (
                <div className="kv" key={c}>
                  <span>{c}</span>
                  <b>{fmt(cents)}</b>
                </div>
              ))}
            </div>
          )}
          <div className="card">
            <h3>Gastos do mês</h3>
            {gastos.length === 0 && <div className="empty">Nenhum gasto lançado.</div>}
            {gastos.map((g) => (
              <div className="list-item" key={g.id}>
                <div>
                  <b>{g.description}</b>
                  <div className="tiny">
                    {g.category} · {g.spentAt}
                  </div>
                </div>
                <div className="row">
                  <b>{fmt(g.amountCents)}</b>
                  <button
                    className="btn sm bad"
                    onClick={async () => {
                      await a.gastoExcluir(g.id);
                      toast("Excluído");
                      carregar();
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

// ═══════════════════════ PLANOS (o travamento) ═══════════════════════
export function PlanosScreen({ a, toast }: P) {
  const [planos, setPlanos] = useState<PlanoDto[]>([]);
  const [status, setStatus] = useState<StatusAssinatura | null>(null);
  const [pix, setPix] = useState<{ copiaECola: string; aviso?: string } | null>(null);
  const [trialDays, setTrialDays] = useState(7);
  const carregar = () => {
    a.planos().then((r) => {
      setPlanos(r.planos);
      setTrialDays(r.trialDias);
    }).catch((e: Error) => toast(`⚠ ${e.message}`));
    a.assinatura().then(setStatus).catch(() => void 0);
  };
  useEffect(carregar, []);
  return (
    <>
      <div className="card">
        <h3>⭐ Assinatura Acompanhe.IA</h3>
        {status && (
          <div className={`banner ${status.entitlement.skus.length > 0 ? "ok" : "info"}`}>
            {status.entitlement.skus.length > 0
              ? `Ativo: ${status.entitlement.skus.join(", ")}${status.entitlement.expiresAt ? ` · expira ${status.entitlement.expiresAt.slice(0, 10)}` : ""}`
              : "Você ainda não tem assinatura ativa. Escolha um plano abaixo — ou comece com o teste grátis."}
            {status.trialDisponivel ? ` · teste grátis de ${status.trialDias} dias disponível` : " · teste já utilizado"}
            {"pushinpayConfigurado" in status && !(status as unknown as { pushinpayConfigurado: boolean }).pushinpayConfigurado
              ? " · PIX: credencial não configurada (modo visível — configure PUSHINPAY_TOKEN)"
              : ""}
          </div>
        )}
        {pix && (
          <div className="banner warn">
            <b>PIX gerado</b>
            {pix.aviso ? <div>⚠ {pix.aviso}</div> : null}
            <p className="mono" style={{ margin: "6px 0" }}>{pix.copiaECola}</p>
            <button className="btn sm ghost" onClick={() => navigator.clipboard?.writeText(pix.copiaECola).then(() => toast("Copiado ✓"))}>
              copiar código
            </button>
          </div>
        )}
      </div>

      {planos.map((p) => (
        <div className="card" key={p.code}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <h3 style={{ marginBottom: 2 }}>{p.name} {p.priceOverridden ? <span className="tag amber">preço definido no painel</span> : null}</h3>
              <div className="tiny">
                {p.features ?? ""} · mensal {fmt(p.monthlyCents)} · anual {fmt(p.yearlyCents)}
              </div>
            </div>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button
              className="btn"
              onClick={async () => {
                try {
                  const r = await a.checkout(p.code, "monthly");
                  setPix({ copiaECola: r.pix?.copiaECola ?? "(PIX indisponível — configure PUSHINPAY_TOKEN no servidor)", ...(r.aviso ? { aviso: r.aviso } : {}) });
                  toast("Checkout criado ✓");
                  carregar();
                } catch (e) {
                  toast(`⚠ ${(e as Error).message}`);
                }
              }}
            >
              Assinar mensal
            </button>
            <button
              className="btn ghost"
              onClick={async () => {
                try {
                  const r = await a.checkout(p.code, "yearly");
                  setPix({ copiaECola: r.pix?.copiaECola ?? "(PIX indisponível — configure PUSHINPAY_TOKEN no servidor)", ...(r.aviso ? { aviso: r.aviso } : {}) });
                  toast("Checkout criado ✓");
                } catch (e) {
                  toast(`⚠ ${(e as Error).message}`);
                }
              }}
            >
              Assinar anual
            </button>
            <button
              className="btn good"
              onClick={async () => {
                try {
                  await a.trial(p.code);
                  toast(`Teste grátis de ${trialDays} dias ativado! 🎉`);
                  carregar();
                } catch (e) {
                  toast(`⚠ ${(e as Error).message}`);
                }
              }}
            >
              Testar {trialDays} dias grátis
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

// ═══════════════════════ PAINEL DO ADMINISTRADOR ═══════════════════════
// ═══════════════════════ PAINEL DE OPERAÇÕES (plano-painel-ops §3.6) ═══════════════════════
// FORA do mini app (entry admin.html). Abas na ordem de investigação:
// visão → serviços → alterações → saúde → filas → testes → regras → operadores → verificações → db.
type Aba = "visao" | "servicos" | "alteracoes" | "saude" | "filas" | "testes" | "regras" | "operadores" | "verificacoes" | "db";
const ABAS: Aba[] = ["visao", "servicos", "alteracoes", "saude", "filas", "testes", "regras", "operadores", "verificacoes", "db"];
const ABAS_AUTO: Aba[] = ["visao", "servicos", "saude", "filas"];

function scoreColor(n: number): string {
  return n >= 90 ? "#3ddc84" : n >= 70 ? "#ffc857" : "#ff6b6b";
}

function Spark({ pontos, cor = "#6ea8fe" }: { pontos: number[]; cor?: string }) {
  if (pontos.length < 2) return <span className="tiny mut">sem dados</span>;
  const w = 120, h = 28, max = Math.max(...pontos, 1), min = Math.min(...pontos, 0);
  const span = max - min || 1;
  const pts = pontos.map((v, i) => `${(i / (pontos.length - 1)) * w},${h - ((v - min) / span) * (h - 4) - 2}`).join(" ");
  return (
    <svg width={w} height={h} aria-hidden>
      <polyline points={pts} fill="none" stroke={cor} strokeWidth="2" />
    </svg>
  );
}

export function AdminScreen({ toast }: { toast: (m: string) => void }) {
  const [token, setToken] = useState("");
  const [admin, setAdmin] = useState<{ email: string; role: string; permissions: string[] } | null>(null);
  const [aba, setAba] = useState<Aba>((() => {
    const q = new URLSearchParams(window.location.search).get("aba");
    return (ABAS as string[]).includes(q ?? "") ? (q as Aba) : "visao";
  })());
  const [dados, setDados] = useState<Record<string, unknown>>({});
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [role, setRole] = useState("operador_suporte");
  const [ruleKey, setRuleKey] = useState("exames");
  const [ruleVal, setRuleVal] = useState("3990");
  const [dbTabela, setDbTabela] = useState("user");
  const [logSvc, setLogSvc] = useState("api");
  const [flagKey, setFlagKey] = useState("ops_panel");
  const a = token ? adminApi(token) : null;

  const trocarAba = async (k: Aba, aa = a) => {
    if (!aa) return;
    setAba(k);
    window.history.replaceState(null, "", `?aba=${k}`);
    try {
      if (k === "visao") setDados({ overview: await aa.opsOverview(), kpis: await aa.kpis() });
      if (k === "servicos") setDados({ services: await aa.opsServices() });
      if (k === "alteracoes") setDados({ timeline: await aa.opsTimeline(100) });
      if (k === "saude") setDados({ probes: await aa.opsProbes("api", 24), probesWeb: await aa.opsProbes("web", 24) });
      if (k === "filas") setDados({ queues: await aa.opsQueues(), logs: await aa.opsLogs(logSvc, 80) });
      if (k === "testes") setDados({ tests: await aa.opsTests(), flags: await aa.opsFlags() });
      if (k === "regras") setDados({ rules: await aa.rules() });
      if (k === "operadores") setDados({ operadores: await aa.operadores() });
      if (k === "verificacoes") setDados({ verificacoes: await aa.verificacoes() });
      if (k === "db") setDados({ db: await aa.db(dbTabela, 20) });
    } catch (e) {
      toast(`⚠ ${(e as Error).message}`);
    }
  };

  const carregar = async (t: string) => {
    const aa = adminApi(t);
    try {
      const me = await aa.me();
      setAdmin(me.admin);
      await trocarAba(aba, aa);
    } catch (e) {
      toast(`⚠ ${(e as Error).message}`);
    }
  };

  // auto-refresh 15s nas abas vivas (§3.6)
  useEffect(() => {
    if (!admin || !ABAS_AUTO.includes(aba)) return;
    const id = window.setInterval(() => { void trocarAba(aba); }, 15000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [admin, aba, token]);

  const J = (x: unknown) => <pre className="mono">{JSON.stringify(x ?? {}, null, 2)}</pre>;

  if (!admin) {
    return (
      <div className="card">
        <h3>🔐 Painel do administrador</h3>
        <p className="mut">Acesso por operador (RBAC). O diretor é criado automaticamente e cria os demais operadores.</p>
        <label>E-mail</label>
        <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="diretor@acompanhe.app" />
        <label>Senha</label>
        <input className="input" type="password" value={senha} onChange={(e) => setSenha(e.target.value)} placeholder="ADMIN_TOKEN do servidor" />
        <button
          className="btn"
          style={{ marginTop: 12 }}
          onClick={async () => {
            try {
              const r = await adminApi("").login(email, senha);
              setToken(r.token);
              toast(`Bem-vindo, ${r.admin.email} (${r.admin.role})`);
              await carregar(r.token);
            } catch (e) {
              toast(`⚠ ${(e as Error).message}`);
            }
          }}
        >
          Entrar
        </button>
      </div>
    );
  }

  const ov = (dados.overview ?? {}) as Record<string, unknown>;
  const sinais = (ov.sinais ?? {}) as Record<string, number>;
  const score = Number(ov.healthScore ?? 0);

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h3 style={{ marginBottom: 2 }}>🛡 {admin.email}</h3>
            <div className="tiny">papel: <b>{admin.role}</b> · permissões: {admin.permissions.join(", ") || "—"}</div>
          </div>
          <div className="row">
            <div className="chip" style={{ borderColor: scoreColor(score), color: scoreColor(score) }} title="health score (§3.6)">
              saúde {score}
            </div>
            <button className="btn sm ghost" onClick={() => { setAdmin(null); setToken(""); }}>sair</button>
          </div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          {ABAS.map((k) => (
            <button key={k} className={`chip ${aba === k ? "on" : ""}`} onClick={() => void trocarAba(k)}>
              {k}
            </button>
          ))}
        </div>
      </div>

      {aba === "visao" && (
        <div className="card">
          <h3>📊 Visão geral — vida, saúde e sinais</h3>
          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            {[
              ["latência p95", `${sinais.latenciaP95Ms ?? 0} ms`],
              ["req/min", String(sinais.reqPorMin ?? 0)],
              ["erros 5xx", `${sinais.taxaErro5xx ?? 0}%`],
              ["backlog alertas", String(sinais.backlog ?? 0)],
            ].map(([r, v]) => (
              <div key={r} className="chip" style={{ minWidth: 120, padding: 10 }}>
                <div className="tiny mut">{r}</div>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{v}</div>
              </div>
            ))}
          </div>
          <div className="row" style={{ marginTop: 10, flexWrap: "wrap", gap: 8 }}>
            {((ov.servicos ?? []) as Array<Record<string, unknown>>).map((s) => (
              <div key={String(s.service)} className="chip" style={{ padding: 8, borderColor: s.ok ? "#3ddc84" : "#ff6b6b" }}>
                {String(s.service)} {s.ok ? "● ok" : "● down"} · restarts 24h: {String(s.restarts24h ?? 0)}
              </div>
            ))}
          </div>
          <h4 style={{ marginTop: 14 }}>KPIs do produto</h4>
          {J(dados.kpis)}
          <h4 style={{ marginTop: 14 }}>Últimas alterações/eventos</h4>
          {J(ov.ultimasAlteracoes)}
        </div>
      )}

      {aba === "servicos" && (
        <div className="card">
          <h3>⚙️ Processos e vida</h3>
          {J(dados.services)}
          <h4 style={{ marginTop: 12 }}>Log ao vivo (tail · redigido S3)</h4>
          <div className="row">
            {["api", "web", "bot", "tunnel", "worker", "keep-alive"].map((s) => (
              <button key={s} className={`chip ${logSvc === s ? "on" : ""}`} onClick={() => { setLogSvc(s); if (a) a.opsLogs(s, 80).then((r) => setDados((d) => ({ ...d, logs: r }))).catch((e: Error) => toast(`⚠ ${e.message}`)); }}>
                {s}
              </button>
            ))}
          </div>
          <pre className="mono" style={{ maxHeight: 260, overflow: "auto" }}>{String((dados.logs as { tail?: string } | undefined)?.tail ?? "(escolha um serviço)")}</pre>
        </div>
      )}

      {aba === "alteracoes" && (
        <div className="card">
          <h3>🧾 Alterações — timeline unificada (audit · rules · flags · ops)</h3>
          {(() => {
            const t = (dados.timeline ?? {}) as { cadeiaOk?: boolean; entries?: Array<Record<string, unknown>> };
            return (
              <>
                <div className="banner info">
                  cadeia de auditoria: {t.cadeiaOk ? "✅ íntegra (prevHash→hash)" : "❌ ADULTERADA"} · fontes fundidas na ordem do tempo
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", fontSize: 12 }}>
                    <thead>
                      <tr><th>ts</th><th>fonte</th><th>ação</th><th>ator</th><th>depois</th></tr>
                    </thead>
                    <tbody>
                      {(t.entries ?? []).map((e, i) => (
                        <tr key={i}>
                          <td className="tiny">{String(e.ts).slice(0, 19).replace("T", " ")}</td>
                          <td><span className="chip" style={{ padding: "2px 8px" }}>{String(e.fonte)}</span></td>
                          <td>{String(e.acao)}</td>
                          <td className="tiny mut">{String(e.ator ?? "—")}</td>
                          <td className="tiny mono">{JSON.stringify(e.depois ?? e.hash ?? "").slice(0, 80)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            );
          })()}
        </div>
      )}

      {aba === "saude" && (
        <div className="card">
          <h3>💓 Saúde — séries de probe (24h)</h3>
          {(() => {
            const mk = (d: unknown, nome: string) => {
              const p = ((d ?? {}) as { pontos?: Array<Record<string, unknown>> }).pontos ?? [];
              const nums = p.map((x) => (x.ok === false ? 0 : 1));
              const lats = p.map((x) => Number(x.latencyMs ?? x.avgLatencyMs ?? 0));
              return (
                <div key={nome} className="row" style={{ alignItems: "center", gap: 12, marginBottom: 8 }}>
                  <b style={{ width: 60 }}>{nome}</b>
                  <Spark pontos={nums.length ? nums : lats} cor={nums.every((n) => n === 1) ? "#3ddc84" : "#ffc857"} />
                  <span className="tiny mut">{p.length} pontos</span>
                </div>
              );
            };
            return (
              <>
                {mk(dados.probes, "api")}
                {mk(dados.probesWeb, "web")}
                <details style={{ marginTop: 8 }}>
                  <summary className="mut">dados crus</summary>
                  {J(dados.probes)}
                </details>
              </>
            );
          })()}
        </div>
      )}

      {aba === "filas" && (
        <div className="card">
          <h3>📮 Filas e processos de dados</h3>
          {J(dados.queues)}
        </div>
      )}

      {aba === "testes" && (
        <div className="card">
          <h3>🧪 Gates de qualidade + feature flags</h3>
          {J(dados.tests)}
          <h4 style={{ marginTop: 12 }}>Flags (G1 — toda mutação registra ator)</h4>
          {J(dados.flags)}
          <div className="row" style={{ marginTop: 8 }}>
            <input className="input grow" value={flagKey} onChange={(e) => setFlagKey(e.target.value)} placeholder="chave da flag" />
            <button className="btn good sm" onClick={() => { a?.opsFlagSet(flagKey, true, { via: "painel" }).then(() => { toast("flag ON ✓"); void trocarAba("testes"); }).catch((e: Error) => toast(`⚠ ${e.message}`)); }}>ligar</button>
            <button className="btn bad sm" onClick={() => { a?.opsFlagSet(flagKey, false, { via: "painel" }).then(() => { toast("flag OFF ✓"); void trocarAba("testes"); }).catch((e: Error) => toast(`⚠ ${e.message}`)); }}>desligar</button>
          </div>
          <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => { a?.opsRotate().then(() => toast("SERVICE_TOKEN rotacionado ✓ (G3)")).catch((e: Error) => toast(`⚠ ${e.message}`)); }}>
            rotacionar SERVICE_TOKEN (só diretor)
          </button>
        </div>
      )}

      {aba === "regras" && (
        <div className="card">
          <h3>⚙️ Preços e teste grátis (painel soberano)</h3>
          <p className="mut">Regras versionadas com rollback. Altere preços mensal/anual por plano ou a duração do trial.</p>
          <div className="grid2">
            <div>
              <label>Chave (código do plano ou "trial")</label>
              <input className="input" value={ruleKey} onChange={(e) => setRuleKey(e.target.value)} />
            </div>
            <div>
              <label>Valor (JSON — ex.: 3990 ou {"{\"monthlyCents\":3990,\"yearlyCents\":35900}"})</label>
              <input className="input" value={ruleVal} onChange={(e) => setRuleVal(e.target.value)} />
            </div>
          </div>
          <button
            className="btn"
            style={{ marginTop: 10 }}
            onClick={() => {
              let value: unknown;
              try {
                value = JSON.parse(ruleVal);
              } catch {
                value = ruleVal;
              }
              const scope = ruleKey === "trial" ? "trial" : "plans";
              const payload = scope === "trial" ? { days: Number(value) } : { monthlyCents: Number(value) };
              a!.ruleCriar({ scope, key: scope === "trial" ? "days" : ruleKey, valueJson: payload })
                .then((r) => {
                  toast(`Regra versionada v${r.rule.version} ✓`);
                  void trocarAba("regras");
                })
                .catch((e: Error) => toast(`⚠ ${e.message}`));
            }}
          >
            Aplicar regra
          </button>
          {J(dados.rules)}
        </div>
      )}

      {aba === "operadores" && (
        <div className="card">
          <h3>👥 Operadores</h3>
          {admin.role !== "diretor" && <div className="banner info">Apenas o diretor cria/desativa operadores (controle de acesso).</div>}
          <div className="grid2">
            <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email do operador" />
            <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
              {["diretor", "admin_ops", "operador_suporte", "operador_mod", "analista_financeiro", "auditor", "suporte_oab"].map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </div>
          <input className="input" type="password" value={senha} onChange={(e) => setSenha(e.target.value)} placeholder="senha inicial" style={{ marginTop: 8 }} />
          <button
            className="btn"
            style={{ marginTop: 10 }}
            onClick={() =>
              a!
                .operadorCriar({ email, role, password: senha })
                .then(() => {
                  toast("Operador criado ✓");
                  void trocarAba("operadores");
                })
                .catch((e: Error) => toast(`⚠ ${e.message}`))
            }
          >
            Criar operador
          </button>
          {J(dados.operadores)}
        </div>
      )}

      {aba === "verificacoes" && (
        <div className="card">
          <h3>🪪 Verificação de identidade (V1)</h3>
          <p className="mut">Aprovar concede nível V1 (abre empréstimos acima de R$ 500). Reprovar exige motivo.</p>
          {J(dados.verificacoes)}
          <div className="row">
            <input className="input grow" id="verif-user" placeholder="userId" />
            <button
              className="btn good sm"
              onClick={() => {
                const id = (document.getElementById("verif-user") as HTMLInputElement).value;
                a!.verifAprovar(id, "V1").then(() => { toast("Aprovado (V1) ✓"); void trocarAba("verificacoes"); }).catch((e: Error) => toast(`⚠ ${e.message}`));
              }}
            >
              aprovar V1
            </button>
            <button
              className="btn bad sm"
              onClick={() => {
                const id = (document.getElementById("verif-user") as HTMLInputElement).value;
                a!.verifReprovar(id, "documento ilegível").then(() => { toast("Reprovado"); void trocarAba("verificacoes"); }).catch((e: Error) => toast(`⚠ ${e.message}`));
              }}
            >
              reprovar
            </button>
          </div>
        </div>
      )}

      {aba === "db" && (
        <div className="card">
          <h3>🗄 Visor do banco (whitelist)</h3>
          <div className="row">
            {["user", "payment", "subscription", "nota", "gasto", "loanrequest", "legalcase", "contest", "tender", "alertevent"].map((t) => (
              <button key={t} className={`chip ${dbTabela === t ? "on" : ""}`} onClick={() => { setDbTabela(t); if (a) a.db(t, 20).then((r) => setDados((d) => ({ ...d, db: r }))).catch((e: Error) => toast(`⚠ ${e.message}`)); }}>
                {t}
              </button>
            ))}
          </div>
          {J(dados.db)}
        </div>
      )}
    </>
  );
}
