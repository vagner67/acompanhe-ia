/**
 * Aba Backup — o usuário digita o próprio e-mail e recebe o ZIP do AnotA.
 *
 * Honestidade acima de conveniência: se o ambiente não tem provedor de e-mail
 * configurado, a tela diz isso com todas as letras (503 do servidor) e oferece o
 * download direto do ZIP — nunca um "enviado" que não aconteceu.
 */
import { useEffect, useState } from "react";

import type { AnotaBackupEstado } from "../api2";

interface Props {
  a: {
    anotaBackupEstado: () => Promise<AnotaBackupEstado>;
    anotaBackupEnviar: (email: string) => Promise<{ status?: string; email?: string; provedor?: string; itens?: number; bytes?: number; erro?: string; instrucao?: string }>;
    anotaBackupArquivo: () => Promise<Blob>;
  };
  toast: (m: string) => void;
}

export function Backup({ a, toast }: Props) {
  const [estado, setEstado] = useState<AnotaBackupEstado | null>(null);
  const [email, setEmail] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState<{ tipo: "ok" | "erro" | "aviso"; texto: string } | null>(null);

  const carregar = () => {
    a.anotaBackupEstado()
      .then((e) => {
        setEstado(e);
        setEmail((atual) => atual || e.emailSugerido || "");
      })
      .catch((e: Error) => toast(`⚠ ${e.message}`));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(carregar, []);

  async function enviar() {
    const alvo = email.trim();
    if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(alvo)) return toast("Digite um e-mail válido");
    setEnviando(true);
    setResultado(null);
    try {
      const r = await a.anotaBackupEnviar(alvo);
      if (r.status === "enviado") {
        setResultado({ tipo: "ok", texto: `Backup de ${r.itens ?? 0} registros enviado para ${r.email} via ${r.provedor}.` });
        toast("Backup enviado ✓");
      } else {
        // 503 (não configurado) ou 502 (falha do provedor) chegam aqui como erro HTTP
        throw new Error(r.erro ?? "falha no envio");
      }
    } catch (e) {
      const msg = (e as Error).message;
      setResultado({ tipo: "aviso", texto: msg });
      toast("Backup gerado, mas o e-mail não saiu");
    } finally {
      setEnviando(false);
      carregar();
    }
  }

  async function baixar() {
    const blob = await a.anotaBackupArquivo();
    const url = URL.createObjectURL(blob);
    const el = document.createElement("a");
    el.href = url;
    el.download = `anota-backup-${new Date().toISOString().slice(0, 10)}.zip`;
    el.click();
    toast("ZIP baixado ✓");
  }

  return (
    <>
      <div className="card">
        <h3>📦 Backup do AnotA</h3>
        <p className="tiny">
          Gera um ZIP com suas contas, lançamentos (CSV + JSON), orçamentos, cartões, metas e notas. O arquivo
          <b> MANIFEST.json</b> dentro dele resume tudo (valores em centavos, datas AAAA-MM-DD).
        </p>
        <label>Seu e-mail</label>
        <input
          className="input"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="voce@exemplo.com"
          inputMode="email"
          autoComplete="email"
        />
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={enviar} disabled={enviando}>
            {enviando ? "enviando…" : "Enviar para meu e-mail"}
          </button>
          <button className="btn ghost sm" onClick={baixar}>
            ⬇ Baixar ZIP agora
          </button>
        </div>
        {resultado && <div className={`banner ${resultado.tipo === "ok" ? "ok" : "warn"}`} style={{ marginTop: 10 }}>{resultado.texto}</div>}
        {estado && !estado.envioConfigurado && (
          <div className="banner warn" style={{ marginTop: 10 }}>
            <b>Envio por e-mail não configurado neste servidor.</b>
            <div className="tiny">{estado.instrucao}</div>
            <div className="tiny">Enquanto isso, use “Baixar ZIP agora”: o arquivo é gerado de verdade, no servidor.</div>
          </div>
        )}
        {estado?.envioConfigurado && (
          <div className="banner ok" style={{ marginTop: 10 }}>
            Envio configurado ({estado.provedor}).
          </div>
        )}
      </div>

      <div className="card">
        <h3>Histórico de envios</h3>
        {!estado || estado.historico.length === 0 ? (
          <div className="empty">Nenhum backup pedido ainda.</div>
        ) : (
          estado.historico.map((h) => (
            <div className="list-item" key={h.id}>
              <div>
                <b>{h.email}</b>
                <div className="tiny">
                  {new Date(h.criadoEm).toLocaleString("pt-BR")} · {h.itens} registros · {(h.bytes / 1024).toFixed(1)} KB · {h.provedor}
                </div>
                {h.erro && <div className="tiny" style={{ color: "var(--warn)" }}>{h.erro}</div>}
              </div>
              <span className={`chip ${h.status === "enviado" ? "on" : ""}`}>
                {h.status === "enviado" ? "enviado" : h.status === "falhou" ? "falhou" : "não configurado"}
              </span>
            </div>
          ))
        )}
      </div>
    </>
  );
}
