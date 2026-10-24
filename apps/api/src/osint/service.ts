/**
 * Serviço do Investiga (doc 13, R2) — regra de caso/relatório/export FORA da
 * camada HTTP. As rotas viram adaptadores finos (auth → serviço → reply).
 * Toda a lógica foi movida de `routes/investiga.ts` preservando o contrato
 * HTTP byte a byte (doc 13 §4): os corpos de 401/403/404/429 são os mesmos.
 *
 * Robustez (doc 13, R3 — MUDANÇA declarada só no caminho de erro):
 * falha no meio da coleta → alvo que falhou e os restantes ficam `unknown`
 * honesto ("coleta interrompida"), caso vira `error`, quota é ESTORNADA e a
 * resposta é 500 com mensagem genérica. Nunca inventar resultado.
 */
import { randomUUID } from "node:crypto";

import { INVESTIGA_LIMITS } from "@acompanhe/shared";

import type { Config } from "../config.js";
import type { Entitlements } from "../entitlements.js";
import { checkDomainTarget } from "./domain.js";
import { checkEmailTarget } from "./email.js";
import { parsePhone } from "./libphone.js";
import { checkPhoneTarget } from "./phone.js";
import { buildReport, type InvestigaReport } from "./report.js";
import { checkSherlockTarget, type SherlockExec } from "./sherlock.js";
import { runCorrelation } from "./correlation.js";
import { annotateConfidence } from "./confidence.js";
import { diffFindings, staleFindings } from "./monitor.js";
import { findingsToCsv, reportToPdf } from "./export.js";
import { todayUtc, type QuotaGate } from "./quota.js";
import { SOURCES } from "./sources.js";
import type { InvestigaStore } from "./store.js";
import type {
  MonitorAlert,
  OsintCase,
  OsintCheck,
  OsintFinding,
  OsintTarget,
  OsintTargetKind,
  QuotaWindow,
} from "./types.js";

/** Erro HTTP declarado — as rotas convertem em reply.code(status).send(body). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`http ${status}`);
    this.name = "HttpError";
  }
}

export const PLANS_WITH_INVESTIGA = ["investiga", "investigaPack", "investiga:trial"];

export interface InvestigaServiceDeps {
  config: Config;
  store: InvestigaStore;
  quota: QuotaGate;
  entitlements: Entitlements;
  /** Injeção para testes (fixture = saída real capturada do sherlock). */
  sherlockExec?: SherlockExec;
  /** Override do despacho por kind (testes de runTarget — doc 13, R2.3). */
  checkers?: TargetCheckerMap;
}

export interface CreateCaseInput {
  title: string;
  targets: OsintTarget[];
  legalBasis: string;
  purpose: string;
}

export interface RunCaseOptions {
  sites?: string[] | undefined;
  targetIndexes?: number[] | undefined;
}

/**
 * Executor de um alvo (doc 13, R5) — o mapa kind → checker é a superfície de
 * despacho; testes injetam exec fake por kind (aceite R2.3).
 */
export type TargetChecker = (
  target: OsintTarget,
  opts: RunCaseOptions,
  executedAt: string,
) => Promise<{ findings: OsintFinding[] }>;

export type TargetCheckerMap = Partial<Record<OsintTargetKind, TargetChecker>>;

export interface RunCaseResult {
  case: OsintCase | undefined;
  checks: OsintCheck[];
  findings: OsintFinding[];
  inferences: OsintFinding[];
  alerts: MonitorAlert[];
  window: QuotaWindow;
}

export interface CaseDetail {
  case: OsintCase;
  checks: OsintCheck[];
  findings: OsintFinding[];
}

export function makeInvestigaService(deps: InvestigaServiceDeps) {
  const { config, store, quota, entitlements } = deps;

  /** ÚNICA checagem de posse de caso (doc 13, R2.2 — antes copiada 6×). */
  async function requireOwnCase(subjectId: string, id: string): Promise<OsintCase> {
    const rec = await store.getCase(id);
    if (!rec || rec.subjectId !== subjectId) {
      throw new HttpError(404, { error: "caso não encontrado" });
    }
    return rec;
  }

  async function requireEntitled(subjectId: string): Promise<void> {
    if (!(await entitlements.isEntitled(subjectId, PLANS_WITH_INVESTIGA))) {
      throw new HttpError(403, {
        error: "plano Investiga ativo é necessário (ou Pack avulso)",
        rule: "v2/08 §9.5",
      });
    }
  }

  /**
   * Um alvo → achados brutos (sem checkId — a orquestração carimba).
   * Mapa kind → checker (doc 13, R5): os adaptadores `checkXTarget` são o
   * despacho oficial; name/url continuam sem fonte real → unknown honesto.
   * `deps.checkers` sobrepõe qualquer kind (teste de despacho sem HTTP).
   */
  const defaultCheckers: Record<"username" | "email" | "phone" | "domain", TargetChecker> = {
    username: (target, opts) =>
      checkSherlockTarget(target, {
        bin: config.SHERLOCK_BIN,
        timeoutMs: config.SHERLOCK_TIMEOUT_MS,
        ...(opts.sites ? { sites: opts.sites } : {}),
        ...(deps.sherlockExec ? { exec: deps.sherlockExec } : {}),
      }),
    email: (target) =>
      checkEmailTarget(target, {
        hibpApiKey: config.HIBP_API_KEY,
        userAgent: config.HIBP_USER_AGENT,
      }),
    phone: (target) => checkPhoneTarget(target, { parse: parsePhone }),
    domain: (target) => checkDomainTarget(target, {}),
  };

  async function runTarget(target: OsintTarget, opts: RunCaseOptions, executedAt: string): Promise<OsintFinding[]> {
    const checker =
      target.kind === "username" || target.kind === "email" || target.kind === "phone" || target.kind === "domain"
        ? (deps.checkers?.[target.kind] ?? defaultCheckers[target.kind])
        : undefined;
    if (!checker) {
      // name/url: sem fonte real dedicada — nunca inventar resultado.
      return [
        {
          id: randomUUID(),
          sourceId: SOURCES.none.id,
          status: "unknown",
          retrievedAt: executedAt,
          raw: {
            target,
            note: "sem fonte real dedicada em S1 — não executado (não inventar)",
          },
        },
      ];
    }
    const result = await checker(target, opts, executedAt);
    return result.findings;
  }

  async function createCase(subjectId: string, input: CreateCaseInput): Promise<OsintCase> {
    await requireEntitled(subjectId);
    const active = (await store.listCasesBySubject(subjectId)).filter((c) => c.status !== "archived");
    if (active.length >= INVESTIGA_LIMITS.maxActiveCases) {
      throw new HttpError(429, {
        error: "limite de casos ativos atingido",
        limit: INVESTIGA_LIMITS.maxActiveCases,
        rule: "v2/08 §9.3",
      });
    }
    const rec = await store.createCase({
      subjectId,
      title: input.title,
      targets: input.targets,
      legalBasis: input.legalBasis,
      purpose: input.purpose,
      createdBy: subjectId,
    });
    return await store.updateCaseStatus(rec.id, "queued") ?? rec;
  }

  async function listCases(subjectId: string): Promise<OsintCase[]> {
    return await store.listCasesBySubject(subjectId);
  }

  async function getDetail(subjectId: string, id: string): Promise<CaseDetail> {
    const rec = await requireOwnCase(subjectId, id);
    return {
      case: rec,
      checks: await store.listChecksByCase(id),
      findings: await store.listFindingsForCase(id),
    };
  }

  async function runCase(subjectId: string, id: string, body: RunCaseOptions): Promise<RunCaseResult> {
    const rec = await requireOwnCase(subjectId, id);
    await requireEntitled(subjectId);

    const day = todayUtc();
    let targets = rec.targets;
    if (body.targetIndexes && body.targetIndexes.length > 0) {
      targets = body.targetIndexes.map((i) => rec.targets[i]).filter((t): t is OsintTarget => Boolean(t));
    }
    targets = targets.slice(0, INVESTIGA_LIMITS.maxChecksPerCase);

    const need = targets.length;
    if (!quota.canUse(subjectId, day, need)) {
      throw new HttpError(429, {
        error: "queue-paused",
        reason: "teto diário de checks atingido (contrato absoluto 150/dia)",
        window: quota.window(subjectId, day),
        nextWindowUtc: quota.nextWindow(day),
        rule: "v2/08 §9.3",
      });
    }

    await store.updateCaseStatus(id, "running");
    quota.consume(subjectId, day, need);

    const checks: OsintCheck[] = [];
    const findings: OsintFinding[] = [];
    const executedAt = new Date().toISOString();
    const previousFindings = await store.listFindingsForCase(id);

    try {
      for (const target of targets) {
        const check = await store.addCheck({
          id: randomUUID(),
          caseId: id,
          target,
          legalBasis: rec.legalBasis,
          purpose: rec.purpose,
          quotaConsumed: 1,
          status: "completed",
          executedAt,
        });
        checks.push(check);
        const got = await runTarget(target, body, executedAt);
        findings.push(...(await store.addFindings(got.map((f) => ({ ...f, checkId: check.id })))));
      }
    } catch {
      // R3 (doc 13): falha de coleta → NADA de resultado inventado.
      // Alvo que falhou e os restantes viram `unknown` honesto; caso = error;
      // quota estornada; erro 500 genérico (não vaza detalhe interno).
      const failedIndex = checks.length - 1;
      const failed = failedIndex >= 0 ? checks[failedIndex] : undefined;
      if (failed) {
        await store.updateCheckStatus(failed.id, "error", "falha na coleta");
      }
      for (const target of targets.slice(checks.length)) {
        const check = await store.addCheck({
          id: randomUUID(),
          caseId: id,
          target,
          legalBasis: rec.legalBasis,
          purpose: rec.purpose,
          quotaConsumed: 0,
          status: "queued",
          executedAt,
        });
        checks.push(check);
        findings.push(
          ...(await store.addFindings([
            {
              id: randomUUID(),
              checkId: check.id,
              sourceId: SOURCES.none.id,
              status: "unknown",
              summary: "coleta interrompida — não executado",
              retrievedAt: executedAt,
              raw: { target, note: "coleta interrompida por falha anterior — não executado (não inventar)" },
            },
          ])),
        );
      }
      await store.updateCaseStatus(id, "error");
      quota.refund(subjectId, day, need);
      throw new HttpError(500, {
        error: "falha na coleta — caso marcado como erro e quota estornada; tente novamente",
      });
    }

    // Correlação → inferências (separadas do dado bruto; inference:true).
    const inferences = await store.replaceInferencesForCase(
      id,
      runCorrelation(id, [...previousFindings, ...findings], new Date(executedAt)),
    );

    // Alertas de mudança — só em re-verificação (1ª execução não é "mudança").
    const alerts: MonitorAlert[] =
      previousFindings.length > 0
        ? await store.addAlerts(diffFindings(id, previousFindings, findings, new Date(executedAt)))
        : [];

    await store.updateCaseStatus(id, "completed");
    return {
      case: await store.getCase(id),
      checks,
      findings: annotateConfidence(findings, new Date(executedAt)),
      inferences: annotateConfidence(inferences, new Date(executedAt)),
      alerts,
      window: quota.window(subjectId, day),
    };
  }

  async function getReport(subjectId: string, id: string): Promise<InvestigaReport> {
    const rec = await requireOwnCase(subjectId, id);
    return buildReport({
      caseId: id,
      targets: rec.targets,
      checks: await store.listChecksByCase(id),
      findings: await store.listFindingsForCase(id),
    });
  }

  async function getAlerts(subjectId: string, id: string): Promise<{ alerts: MonitorAlert[]; rule: string }> {
    await requireOwnCase(subjectId, id);
    const stale = staleFindings(id, await store.listFindingsForCase(id));
    return {
      alerts: [...(await store.listAlertsByCase(id)), ...stale],
      rule: "diff entre execuções + idade > 30 d (doc 11 §6c)",
    };
  }

  async function exportCsv(subjectId: string, id: string): Promise<string> {
    const rec = await requireOwnCase(subjectId, id);
    const checks = await store.listChecksByCase(id);
    const targets = new Map(checks.map((c) => [c.id, { kind: c.target.kind, value: c.target.value }]));
    return findingsToCsv(rec, await store.listFindingsForCase(id), targets);
  }

  async function exportPdf(subjectId: string, id: string): Promise<Buffer> {
    const rec = await requireOwnCase(subjectId, id);
    const report = await getReport(subjectId, id);
    return reportToPdf(rec, report, await store.listAlertsByCase(id));
  }

  return {
    createCase,
    listCases,
    getDetail,
    requireOwnCase,
    runCase,
    getReport,
    getAlerts,
    exportCsv,
    exportPdf,
  };
}

export type InvestigaService = ReturnType<typeof makeInvestigaService>;
