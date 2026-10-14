import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { createWorker, type Worker } from 'tesseract.js';
import { config } from '../config/env.js';
import { log } from '../utils/logger.js';

const require = createRequire(import.meta.url);

let workerPromise: Promise<Worker> | null = null;

/**
 * Copie les modèles de langue embarqués (@tesseract.js-data/*) dans
 * data/tessdata : tesseract.js les lit alors depuis le disque, sans aucun
 * téléchargement (par défaut il irait les chercher sur un CDN).
 */
function prepareLangData(langs: string[]): void {
  fs.mkdirSync(config.tessdataDir, { recursive: true });
  for (const lang of langs) {
    const target = path.join(config.tessdataDir, `${lang}.traineddata.gz`);
    if (fs.existsSync(target)) continue;
    let pkgDir: string;
    try {
      pkgDir = path.dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`));
    } catch {
      throw new Error(
        `Modèle OCR "${lang}" introuvable : ajoutez la dépendance @tesseract.js-data/${lang} (aucun téléchargement automatique).`,
      );
    }
    fs.copyFileSync(path.join(pkgDir, '4.0.0_best_int', `${lang}.traineddata.gz`), target);
  }
}

async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    const langs = config.ocrLangs.split('+').filter(Boolean);
    workerPromise = (async () => {
      prepareLangData(langs);
      log.info(`🔤 Initialisation OCR (${langs.join('+')}, modèles locaux)…`);
      const worker = await createWorker(langs, 1, {
        langPath: config.tessdataDir,
        cachePath: config.tessdataDir,
        gzip: true,
      });
      return worker;
    })().catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

export interface OcrResult {
  text: string;
  confidence: number; // 0..1
}

/**
 * OCR d'une image. Pré-traitement léger : niveaux de gris, normalisation,
 * agrandissement des petites images (améliore nettement tesseract sur des
 * captures d'écran en basse résolution).
 */
export async function ocrImage(input: Buffer): Promise<OcrResult> {
  const meta = await sharp(input).metadata();
  const width = meta.width ?? 0;
  let pipeline = sharp(input).flatten({ background: '#ffffff' }).grayscale().normalize();
  if (width > 0 && width < 1600) pipeline = pipeline.resize({ width: Math.min(width * 2, 2400) });
  const prepared = await pipeline.png().toBuffer();

  const worker = await getWorker();
  const { data } = await worker.recognize(prepared);
  return { text: cleanOcrText(data.text), confidence: (data.confidence ?? 0) / 100 };
}

/**
 * Supprime les lignes "bruit" produites par l'OCR sur les zones photo
 * (ex. ">» è = 4 >") : on garde une ligne si elle contient au moins un mot
 * de 4 lettres et une majorité de lettres/chiffres.
 */
export function cleanOcrText(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const l = line.trim();
      if (!l) return true; // conserve les séparations de paragraphes
      const alnum = (l.match(/[\p{L}\p{N}]/gu) ?? []).length;
      const visible = l.replace(/\s/g, '').length;
      return /\p{L}{4,}/u.test(l) && alnum / visible >= 0.6;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function shutdownOcr(): Promise<void> {
  if (!workerPromise) return;
  try {
    const w = await workerPromise;
    await w.terminate();
  } catch {
    /* ignore */
  }
  workerPromise = null;
}
