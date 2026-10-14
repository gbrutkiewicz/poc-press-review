import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import sharp, { type Metadata } from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import type { ExtractedImage, ExtractionResult, FileKind } from '../types/document.js';
import { ocrImage } from './ocr.js';
import { log } from '../utils/logger.js';

const require = createRequire(import.meta.url);

export const SUPPORTED_EXTENSIONS: Record<string, { kind: FileKind; mime: string }> = {
  '.pdf': { kind: 'pdf', mime: 'application/pdf' },
  '.docx': { kind: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  '.png': { kind: 'image', mime: 'image/png' },
  '.jpg': { kind: 'image', mime: 'image/jpeg' },
  '.jpeg': { kind: 'image', mime: 'image/jpeg' },
  '.webp': { kind: 'image', mime: 'image/webp' },
};

/** Taille minimale (px) d'une image embarquée pour être conservée (ignore puces, filets…). */
const MIN_IMAGE_SIDE = 32;
/** En dessous de ce nombre de caractères, un PDF est considéré comme scanné → OCR. */
const PDF_MIN_TEXT_FOR_NO_OCR = 50;

export class ExtractionError extends Error {
  constructor(
    message: string,
    public readonly code: 'UNSUPPORTED_FORMAT' | 'CORRUPTED_FILE' | 'EXTRACTION_FAILED',
  ) {
    super(message);
  }
}

export function detectKind(filePath: string): { kind: FileKind; mime: string } {
  const info = SUPPORTED_EXTENSIONS[path.extname(filePath).toLowerCase()];
  if (!info) {
    throw new ExtractionError(
      `Format non supporté : "${path.extname(filePath) || '(sans extension)'}". Acceptés : ${Object.keys(SUPPORTED_EXTENSIONS).join(', ')}`,
      'UNSUPPORTED_FORMAT',
    );
  }
  return info;
}

/** Vérifie la signature binaire (évite qu'un .pdf renommé soit traité comme tel). */
function checkMagicBytes(buf: Buffer, kind: FileKind): void {
  const head = buf.subarray(0, 12);
  const ok =
    kind === 'pdf'
      ? head.subarray(0, 5).toString('latin1') === '%PDF-'
      : kind === 'docx'
        ? head[0] === 0x50 && head[1] === 0x4b // PK (zip)
        : true; // images : validées par sharp
  if (!ok) throw new ExtractionError(`Le contenu du fichier ne correspond pas à un ${kind.toUpperCase()} valide`, 'CORRUPTED_FILE');
}

export async function extractFile(filePath: string, buffer?: Buffer): Promise<ExtractionResult> {
  const { kind, mime } = detectKind(filePath);
  const buf = buffer ?? (await fs.readFile(filePath));
  checkMagicBytes(buf, kind);
  const started = Date.now();
  try {
    const partial =
      kind === 'pdf' ? await extractPdf(buf) : kind === 'docx' ? await extractDocx(buf) : await extractImage(buf);
    return {
      kind,
      ...partial,
      text: normalizeWhitespace(partial.text),
      metadata: { ...partial.metadata, fileSize: buf.length, mimeType: mime },
      durationMs: Date.now() - started,
    };
  } catch (err) {
    if (err instanceof ExtractionError) throw err;
    throw new ExtractionError(`Extraction ${kind.toUpperCase()} impossible : ${(err as Error).message}`, 'EXTRACTION_FAILED');
  }
}

type PartialExtraction = Omit<ExtractionResult, 'kind' | 'durationMs' | 'metadata'> & {
  metadata: Omit<ExtractionResult['metadata'], 'fileSize' | 'mimeType'>;
};

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------------------------------------------ PDF -- */

// Import paresseux : pdfjs-dist est un module ESM assez lourd.
let pdfjsPromise: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | null = null;
const loadPdfjs = () => (pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs'));

interface PdfImageObject {
  width: number;
  height: number;
  kind?: number; // 1 = GRAYSCALE_1BPP, 2 = RGB_24BPP, 3 = RGBA_32BPP
  data?: Uint8Array | Uint8ClampedArray;
}

async function pdfImageToPng(img: PdfImageObject): Promise<Buffer | null> {
  const { width, height, kind, data } = img;
  if (!data || !width || !height) return null;
  let channels: 1 | 3 | 4;
  let raw: Buffer;
  if (kind === 3) {
    channels = 4;
    raw = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  } else if (kind === 2) {
    channels = 3;
    raw = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  } else if (kind === 1) {
    // 1 bit par pixel, lignes alignées sur l'octet → 8 bits
    channels = 1;
    const rowBytes = (width + 7) >> 3;
    raw = Buffer.alloc(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        raw[y * width + x] = bit ? 255 : 0;
      }
    }
  } else {
    return null;
  }
  if (raw.length < width * height * channels) return null;
  return sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
}

async function extractPdf(buf: Buffer): Promise<PartialExtraction> {
  const pdfjs = await loadPdfjs();
  const pdfjsDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    isEvalSupported: false, // durcissement (pas d'eval de code issu du PDF)
    disableFontFace: true,
    useSystemFonts: false,
    standardFontDataUrl: path.join(pdfjsDir, 'standard_fonts') + path.sep,
    cMapUrl: path.join(pdfjsDir, 'cmaps') + path.sep,
    cMapPacked: true,
    verbosity: 0,
  }).promise;

  const warnings: string[] = [];
  const images: ExtractedImage[] = [];
  const pageTexts: string[] = [];
  const seen = new Set<string>();

  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);

      // --- Texte : reconstruction des lignes via hasEOL / position verticale
      const content = await page.getTextContent();
      let text = '';
      let lastY: number | null = null;
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const y = item.transform[5];
        if (lastY !== null && Math.abs(y - lastY) > 2 && !text.endsWith('\n')) text += '\n';
        text += item.str;
        if (item.hasEOL) text += '\n';
        lastY = y;
      }
      pageTexts.push(`--- Page ${n} ---\n${normalizeWhitespace(text)}`);

      // --- Images embarquées
      try {
        const ops = await page.getOperatorList();
        for (let i = 0; i < ops.fnArray.length; i++) {
          const fn = ops.fnArray[i];
          let img: PdfImageObject | null = null;
          if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintImageXObjectRepeat) {
            const name = ops.argsArray[i][0] as string;
            if (seen.has(name)) continue;
            seen.add(name);
            const store = name.startsWith('g_') ? page.commonObjs : page.objs;
            img = await new Promise<PdfImageObject | null>((resolve) => {
              try {
                store.get(name, (o: PdfImageObject) => resolve(o));
              } catch {
                resolve(null);
              }
              setTimeout(() => resolve(null), 10_000);
            });
          } else if (fn === pdfjs.OPS.paintInlineImageXObject) {
            img = ops.argsArray[i][0] as PdfImageObject;
          }
          if (!img || img.width < MIN_IMAGE_SIDE || img.height < MIN_IMAGE_SIDE) continue;
          const png = await pdfImageToPng(img);
          if (!png) {
            warnings.push(`Page ${n} : image ignorée (format interne non géré)`);
            continue;
          }
          images.push({ imageId: uuidv4(), buffer: png, format: 'png', width: img.width, height: img.height, page: n, origin: 'embedded' });
        }
      } catch (err) {
        warnings.push(`Page ${n} : extraction des images échouée (${(err as Error).message})`);
      }
      page.cleanup();
    }

    // --- Métadonnées
    let title: string | undefined, author: string | undefined, producer: string | undefined;
    try {
      const meta = await doc.getMetadata();
      const info = meta.info as Record<string, unknown>;
      title = (info?.Title as string) || undefined;
      author = (info?.Author as string) || undefined;
      producer = (info?.Producer as string) || undefined;
    } catch {
      /* métadonnées absentes */
    }

    let text = pageTexts.join('\n\n');
    let ocr: PartialExtraction['metadata']['ocr'] = { used: false };

    // PDF scanné (pas de couche texte) → OCR des images de page
    const rawLen = pageTexts.join('').replace(/--- Page \d+ ---/g, '').trim().length;
    if (rawLen < PDF_MIN_TEXT_FOR_NO_OCR && images.length > 0) {
      log.info(`🔤 PDF sans couche texte (${rawLen} car.) → OCR de ${images.length} image(s)`);
      const parts: string[] = [];
      const confs: number[] = [];
      for (const im of images) {
        const r = await ocrImage(im.buffer);
        parts.push(`--- Page ${im.page} (OCR) ---\n${r.text}`);
        confs.push(r.confidence);
      }
      text = parts.join('\n\n');
      ocr = { used: true, confidence: avg(confs), reason: 'pdf-sans-texte' };
    }

    return { text, images, metadata: { pageCount: doc.numPages, title, author, producer, ocr, warnings } };
  } finally {
    await doc.destroy();
  }
}

/* ----------------------------------------------------------------- DOCX -- */

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<img[^>]*>/gi, '')
      // contenu d'une cellule sur une seule ligne (les <p> internes deviennent des espaces)
      .replace(/<(td|th)([^>]*)>([\s\S]*?)<\/\1>/gi, (_m, t: string, attrs: string, inner: string) =>
        `<${t}${attrs}>${inner.replace(/<\/?(p|br)[^>]*>/gi, ' ').trim()}</${t}>`)
      .replace(/<\/(td|th)>\s*<(td|th)[^>]*>/gi, ' | ') // cellules d'une même ligne
      .replace(/<\/tr>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|h[1-6]|li|table|div)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<[^>]+>/g, ''),
  );
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

const xmlTag = (xml: string | undefined, tag: string) =>
  xml?.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`))?.[1];

async function extractDocx(buf: Buffer): Promise<PartialExtraction> {
  const warnings: string[] = [];
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw new ExtractionError('Fichier DOCX corrompu (archive illisible)', 'CORRUPTED_FILE');
  }
  if (!zip.file('word/document.xml')) {
    throw new ExtractionError('Fichier DOCX invalide (word/document.xml absent)', 'CORRUPTED_FILE');
  }

  // Texte (paragraphes + tableaux, ordre du document) via le HTML de mammoth
  const { value: html, messages } = await mammoth.convertToHtml(
    { buffer: buf },
    { convertImage: mammoth.images.imgElement(async () => ({ src: '' })) },
  );
  for (const m of messages) if (m.type === 'error') warnings.push(m.message);
  const text = htmlToText(html);

  // Images : fichiers word/media/* (ordre alphabétique = ordre d'insertion Word)
  const images: ExtractedImage[] = [];
  const media = Object.keys(zip.files)
    .filter((n) => n.startsWith('word/media/') && !zip.files[n].dir)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const name of media) {
    const data = await zip.file(name)!.async('nodebuffer');
    const ext = path.extname(name).slice(1).toLowerCase();
    try {
      const png = sharp(data);
      const meta = await png.metadata();
      if ((meta.width ?? 0) < MIN_IMAGE_SIDE || (meta.height ?? 0) < MIN_IMAGE_SIDE) continue;
      images.push({ imageId: uuidv4(), buffer: await png.png().toBuffer(), format: 'png', width: meta.width, height: meta.height, origin: 'embedded' });
    } catch {
      // EMF/WMF… non décodables par sharp : conservés tels quels
      images.push({ imageId: uuidv4(), buffer: data, format: ext || 'bin', origin: 'embedded' });
      warnings.push(`Image ${path.basename(name)} conservée au format d'origine (${ext})`);
    }
  }

  const core = await zip.file('docProps/core.xml')?.async('string');
  const app = await zip.file('docProps/app.xml')?.async('string');
  const pages = Number(xmlTag(app, 'Pages'));

  return {
    text,
    images,
    metadata: {
      pageCount: Number.isFinite(pages) && pages > 0 ? pages : undefined,
      title: xmlTag(core, 'dc:title') || undefined,
      author: xmlTag(core, 'dc:creator') || undefined,
      producer: xmlTag(app, 'Application') || undefined,
      warnings,
    },
  };
}

/* --------------------------------------------------------------- IMAGES -- */

async function extractImage(buf: Buffer): Promise<PartialExtraction> {
  let meta: Metadata;
  try {
    meta = await sharp(buf).metadata();
  } catch {
    throw new ExtractionError('Image illisible ou corrompue', 'CORRUPTED_FILE');
  }
  // Image d'origine conservée (convertie en PNG pour homogénéiser le stockage)
  const png = await sharp(buf).rotate().png().toBuffer();
  const { text, confidence } = await ocrImage(buf);
  return {
    text,
    images: [{ imageId: uuidv4(), buffer: png, format: 'png', width: meta.width, height: meta.height, origin: 'original' }],
    metadata: {
      width: meta.width,
      height: meta.height,
      ocr: { used: true, confidence, reason: 'image' },
      warnings: confidence < 0.5 ? [`Confiance OCR faible (${Math.round(confidence * 100)}%)`] : [],
    },
  };
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
