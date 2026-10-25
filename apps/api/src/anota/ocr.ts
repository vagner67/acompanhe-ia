/**
 * OCR do AnotA — porta + providers honestos.
 *
 * Vive dentro do módulo do AnotA (25/10): antes morava em `src/minhas/`, que é o
 * módulo de empréstimos/verificação/perfil. Manter o OCR lá fazia o AnotA
 * depender de código de outro produto.
 *
 * Regra que não muda: sem binário/provedor, `manualOcr` devolve `text: null`.
 * Nada de texto inventado a partir de uma foto qualquer.
 */

/** Porta de OCR (foto do comprovante → texto). Provider real via config. */
export interface OcrProvider {
  readonly engine: string;
  extract(imageBase64: string): Promise<{ text: string | null; engine: string }>;
}

/** Provider honesto: sem OCR configurado NÃO inventa texto. */
export const manualOcr: OcrProvider = {
  engine: "manual",
  async extract() {
    return { text: null, engine: "manual" };
  },
};

/**
 * OCR REAL via Tesseract (binário local; langs por+eng). Se o binário não
 * existir, `detectTesseract()` devolve null e o server cai no provider manual
 * (NUNCA inventa texto — achado do plano §6.4).
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class TesseractOcr implements OcrProvider {
  readonly engine = "tesseract";

  constructor(private langs = "por+eng", private timeoutMs = 30_000) {}

  async extract(imageBase64: string): Promise<{ text: string | null; engine: string }> {
    const buf = Buffer.from(imageBase64, "base64");
    if (buf.length === 0) return { text: null, engine: this.engine };
    const dir = mkdtempSync(join(tmpdir(), "ocr-"));
    const file = join(dir, "img.png");
    try {
      writeFileSync(file, buf);
      const out = await new Promise<string>((resolve, reject) => {
        const child = spawn("tesseract", [file, "stdout", "-l", this.langs], { stdio: ["ignore", "pipe", "pipe"] });
        let acc = "";
        let err = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("tesseract timeout"));
        }, this.timeoutMs);
        child.stdout.on("data", (d) => (acc += String(d)));
        child.stderr.on("data", (d) => (err += String(d)));
        child.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(acc);
          else reject(new Error(`tesseract exit ${code}: ${err.slice(0, 120)}`));
        });
      });
      const text = out.trim();
      return { text: text.length ? text.slice(0, 4000) : null, engine: this.engine };
    } catch {
      return { text: null, engine: `${this.engine}:falhou` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** Retorna o provider Tesseract se o binário existir; senão null (honesto). */
export function detectTesseract(): TesseractOcr | null {
  try {
    const r = spawnSync("tesseract", ["--version"], { encoding: "utf8", timeout: 5000 });
    return r.status === 0 ? new TesseractOcr() : null;
  } catch {
    return null;
  }
}
