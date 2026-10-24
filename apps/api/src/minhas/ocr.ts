/**
 * OCR REAL via Tesseract (binário local; langs por+eng). Se o binário não
 * existir, `detectTesseract()` devolve null e o server cai no provider manual
 * (NUNCA inventa texto — achado do plano §6.4).
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OcrProvider } from "./service.js";

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
