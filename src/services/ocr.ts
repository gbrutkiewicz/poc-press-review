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
  const { data } = await worker.recognize(prepared, {}, { text: true, blocks: true });
  const text = data.blocks?.length ? rebuildText(data.blocks as OcrBlock[]) : data.text;
  return { text: cleanOcrText(text), confidence: (data.confidence ?? 0) / 100 };
}

/* ------------------------------------------- filtrage des mots parasites -- */

// Sous-ensemble de la structure renvoyée par tesseract.js (output.blocks)
export interface OcrWord { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }
export interface OcrLine { words: OcrWord[]; bbox: { x0: number; y0: number; x1: number; y1: number } }
export interface OcrBlock { paragraphs: { lines: OcrLine[] }[] }

/** Écart horizontal (en hauteurs de ligne) au-delà duquel deux mots n'appartiennent pas au même texte. */
const GAP_FACTOR = 2;
/** Confiance moyenne minimale (pondérée par la longueur) d'un groupe de mots conservé. */
const MIN_GROUP_CONFIDENCE = 70;
/** Un mot en bord de groupe sous ce seuil est retiré (débris type « g FN » en fin de ligne). */
const MIN_EDGE_CONFIDENCE = 55;

/** Symbole isolé sans lettre ni chiffre, improbable en bord de ligne (les guillemets « » et tirets restent). */
const STRAY_SYMBOL = /^[^\p{L}\p{N}«»"(\[–—-]+$/u;

const alnumCount = (s: string) => (s.match(/[\p{L}\p{N}]/gu) ?? []).length;

const meanConfidence = (words: OcrWord[]) => {
  const len = words.reduce((n, w) => n + w.text.length, 0) || 1;
  return words.reduce((n, w) => n + w.confidence * w.text.length, 0) / len;
};

/**
 * Nettoie une ligne OCR. Sur une capture composite (photo + texte), tesseract
 * lit les zones photo comme des caractères, collés en début ou fin des vraies
 * lignes. Ces débris ont une confiance basse et sont séparés du texte par un
 * grand écart horizontal :
 *   1. la ligne est découpée en groupes de mots aux grands écarts ;
 *   2. les groupes de faible confiance moyenne sont supprimés ;
 *   3. dans les groupes gardés, les mots douteux aux extrémités sont retirés.
 */
export function cleanLine(line: OcrLine): string {
  const words = line.words.filter((w) => w.text.trim());
  if (!words.length) return '';
  const height = Math.max(1, line.bbox.y1 - line.bbox.y0);

  const groups: OcrWord[][] = [[words[0]]];
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].bbox.x0 - words[i - 1].bbox.x1;
    if (gap > height * GAP_FACTOR) groups.push([words[i]]);
    else groups[groups.length - 1].push(words[i]);
  }

  return groups
    // gardé si confiance moyenne suffisante, ou si au moins deux vrais mots sont sûrs
    // (une ligne courte avec un mot mal lu ne doit pas disparaître)
    .filter((g) => meanConfidence(g) >= MIN_GROUP_CONFIDENCE || g.filter((w) => w.confidence >= 85 && alnumCount(w.text) >= 2).length >= 2)
    // un groupe de caractères isolés (« / A », « c ») n'est pas du texte
    .filter((g) => g.some((w) => alnumCount(w.text) >= 2))
    .map((g) => {
      const drop = (w: OcrWord) => w.confidence < MIN_EDGE_CONFIDENCE || STRAY_SYMBOL.test(w.text);
      let a = 0;
      let b = g.length - 1;
      while (a <= b && drop(g[a])) a++;
      while (b >= a && drop(g[b])) b--;
      return g.slice(a, b + 1).map((w) => w.text).join(' ');
    })
    .filter(Boolean)
    .join(' ');
}

/** Reconstruit le texte (paragraphes séparés par une ligne vide) à partir des mots filtrés. */
export function rebuildText(blocks: OcrBlock[]): string {
  const paragraphs: string[] = [];
  for (const block of blocks) {
    for (const p of block.paragraphs ?? []) {
      const lines = (p.lines ?? []).map(cleanLine).filter(Boolean);
      if (lines.length) paragraphs.push(lines.join('\n'));
    }
  }
  return paragraphs.join('\n\n');
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
