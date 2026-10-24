import { useEffect, useState } from "react";
import { XP } from "@acompanhe/shared";
import { api, adminApi, type Gamificacao, type GastoDto, type LoanMatchDto, type LoanRequestDto, type NotaDto, type PlanoDto, type StatusAssinatura } from "./api2";

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
export function JuridicoScreen({ a, toast }: P) {
  const [cnj, setCnj] = useState("");
  const [uf, setUf] = useState("MT");
  const [processo, setProcesso] = useState<Record<string, unknown> | null>(null);
  const [explicacao, setExplicacao] = useState("");
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
  return (
    <>
      <div className="card">
        <h3>⚖️ Jurídico — processo por CNJ</h3>
        <p className="mut">Consulta DataJud (CNJ) com movimentos, projeção (classe, fase, valor, arquivamento) e explicação em linguagem simples.</p>
        <label>Número CNJ</label>
        <input className="input" value={cnj} onChange={(e) => setCnj(e.target.value)} placeholder="0006903-69.2014.8.11.0037" />
        <label>UF (tribunal)</label>
        <input className="input" value={uf} onChange={(e) => setUf(e.target.value.toUpperCase())} maxLength={2} />
        <div className="row" style={{ marginTop: 10 }}>
          <button
            className="btn"
            onClick={async () => {
              const r = (await run(() => a.processoAcompanhar(cnj, uf))) as unknown;
              void r;
              const p = (await run(() => a.processo(cnj))) as { processo: Record<string, unknown> } | null;
              if (p) setProcesso(p.processo);
            }}
          >
            🔎 Acompanhar
          </button>
          <button
            className="btn ghost"
            onClick={async () => {
              const r = (await run(() => a.processoExplicar(cnj))) as { explicacao?: string } | null;
              if (r?.explicacao) setExplicacao(r.explicacao);
            }}
          >
            💬 Explicar
          </button>
          <button
            className="btn good"
            onClick={async () => {
              const r = (await run(() => a.processoSync(cnj))) as { movimentos?: number } | null;
              if (r) toast(`Sincronizado: ${r.movimentos} movimentos`);
            }}
          >
            🔄 Sincronizar
          </button>
        </div>
      </div>
      {processo && (
        <div className="card">
          <h3>Processo</h3>
          <pre className="mono">{JSON.stringify(processo, null, 2)}</pre>
        </div>
      )}
      {explicacao && (
        <div className="card">
          <h3>💬 Em palavras simples</h3>
          <p style={{ fontSize: "0.88rem", lineHeight: 1.5 }}>{explicacao}</p>
        </div>
      )}
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
