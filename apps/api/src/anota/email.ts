/**
 * AnotA — envio do backup por e-mail.
 *
 * Regra: **nada de "enviado" falso**. Se não houver provedor configurado, a
 * função devolve `nao_configurado` com a instrução do que falta, e a rota
 * responde 503. O arquivo do backup é gerado de qualquer forma.
 *
 * Provedores suportados (o primeiro configurado vence):
 *   1. SMTP  — `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` (nodemailer)
 *   2. Resend — `RESEND_API_KEY`, `RESEND_FROM` (HTTP, sem SDK)
 */
import nodemailer from "nodemailer";

export interface AnexoEmail {
  nomeArquivo: string;
  conteudo: Buffer;
  contentType: string;
}

export interface PedidoEmail {
  para: string;
  assunto: string;
  texto: string;
  anexo: AnexoEmail;
}

export type ResultadoEnvio =
  | { status: "enviado"; provedor: string }
  | { status: "falhou"; provedor: string; erro: string }
  | { status: "nao_configurado"; provedor: string; erro: string };

export interface EmailProvider {
  readonly nome: string;
  enviar(p: PedidoEmail): Promise<ResultadoEnvio>;
}

/** Validação de e-mail honesta: não tenta adivinhar "@gmail" com typo. */
export function emailValido(email: string): boolean {
  if (email.length > 160) return false;
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email);
}

type Env = Record<string, string | undefined>;

function smtpDe(env: Env): EmailProvider | null {
  const host = env["SMTP_HOST"];
  const user = env["SMTP_USER"];
  const pass = env["SMTP_PASS"];
  const from = env["SMTP_FROM"] ?? user;
  if (!host || !user || !pass || !from) return null;
  const port = Number(env["SMTP_PORT"] ?? 587);
  const secure = env["SMTP_SECURE"] === "1" || port === 465;
  return {
    nome: `smtp:${host}`,
    async enviar(p) {
      // transporte novo por envio: sem estado global que vaze entre requisições
      const transporte = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: { user, pass },
        // servidor local de teste não tem TLS válido — só isenta quando pedido
        ...(env["SMTP_TLS_INSECURE"] === "1" ? { tls: { rejectUnauthorized: false } } : {}),
      });
      try {
        await transporte.sendMail({
          from,
          to: p.para,
          subject: p.assunto,
          text: p.texto,
          attachments: [{ filename: p.anexo.nomeArquivo, content: p.anexo.conteudo, contentType: p.anexo.contentType }],
        });
        return { status: "enviado", provedor: `smtp:${host}` };
      } catch (e) {
        return { status: "falhou", provedor: `smtp:${host}`, erro: (e as Error).message.slice(0, 300) };
      } finally {
        transporte.close();
      }
    },
  };
}

function resendDe(env: Env, fetchImpl: typeof fetch): EmailProvider | null {
  const key = env["RESEND_API_KEY"];
  const from = env["RESEND_FROM"];
  if (!key || !from) return null;
  return {
    nome: "resend",
    async enviar(p) {
      try {
        const res = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({
            from,
            to: [p.para],
            subject: p.assunto,
            text: p.texto,
            attachments: [{ filename: p.anexo.nomeArquivo, content: p.anexo.conteudo.toString("base64") }],
          }),
        });
        if (!res.ok) {
          const corpo = await res.text().catch(() => "");
          return { status: "falhou", provedor: "resend", erro: `HTTP ${res.status}: ${corpo.slice(0, 200)}` };
        }
        return { status: "enviado", provedor: "resend" };
      } catch (e) {
        return { status: "falhou", provedor: "resend", erro: (e as Error).message.slice(0, 300) };
      }
    },
  };
}

/** Provedor configurado, ou `null` quando não há nenhum (sem simulação). */
export function provedorDeEmail(env: Env, fetchImpl: typeof fetch = fetch): EmailProvider | null {
  return smtpDe(env) ?? resendDe(env, fetchImpl);
}

export function instrucaoDeConfiguracao(): string {
  return "Configure SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM (ou RESEND_API_KEY/RESEND_FROM) no ambiente para o envio sair de verdade.";
}
