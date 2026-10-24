/**
 * R1.2 (doc 13) — contrato de tipos API↔shared. Se alguém recriar uma cópia
 * divergente de DTO, ESTE arquivo quebra no `tsc -p tsconfig.test.json`.
 * (O incidente real de 23/10/2026 — band "media" vs "média" — seria pego aqui.)
 */
import { describe, it, expect } from "vitest";

import type {
  FindingConfidence as SharedConfidence,
  MonitorAlert as SharedAlert,
  OsintFinding as SharedFinding,
  OsintCase as SharedCase,
  QuotaWindow as SharedQuotaWindow,
  InvestigaReport as SharedReport,
} from "@acompanhe/shared";

import type {
  FindingConfidence,
  MonitorAlert,
  OsintFinding,
  OsintCase,
  QuotaWindow,
  InvestigaReport,
} from "../src/osint/types.js";

// Atribuição bidirecional: qualquer divergência estrutural quebra a compilação.
type AssertSame<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const _finding: AssertSame<OsintFinding, SharedFinding> = true;
const _confidence: AssertSame<FindingConfidence, SharedConfidence> = true;
const _alert: AssertSame<MonitorAlert, SharedAlert> = true;
const _case: AssertSame<OsintCase, SharedCase> = true;
const _quota: AssertSame<QuotaWindow, SharedQuotaWindow> = true;
const _report: AssertSame<InvestigaReport, SharedReport> = true;

describe("contrato de tipos API↔shared (R1.2)", () => {
  it("todos os DTOs do Investiga são o MESMO tipo nos dois lados", () => {
    expect([_finding, _confidence, _alert, _case, _quota, _report]).toEqual([true, true, true, true, true, true]);
  });
});
