import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { config, PROJECT_ROOT, rel } from '../config/env.js';
import type { DocumentRecord, ExtractionResult, TaggingResult } from '../types/document.js';
import { detectKind, ExtractionError, extractFile, SUPPORTED_EXTENSIONS } from './extraction.js';
import { findByHash, saveDocument, saveError } from './storage.js';
import { tagDocument } from './tagging.js';
import { log } from '../utils/logger.js';

export class ScanError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
  }
}

/** Résumé d'extraction renvoyé par l'API (sans les buffers d'images). */
export interface ExtractionSummary {
  kind: ExtractionResult['kind'];
  textLength: number;
  textPreview: string;
  text: string;
  imageCount: number;
  images: { imageId: string; storagePath: string; page: number | null; width: number | null; height: number | null }[];
  metadata: ExtractionResult['metadata'];
  durationMs: number;
}

export interface ScanResult {
  success: true;
  documentId: string;
  duplicate: boolean;
  extraction: ExtractionSummary | null;
  tagging: TaggingResult | null;
  document?: DocumentRecord;
}

/**
 * Résout et contrôle un chemin : il doit exister, être un fichier régulier et
 * se trouver (après résolution des liens symboliques) dans INPUT_DIR ou une
 * racine ALLOWED_ROOTS. Empêche l'API de lire n'importe quel fichier du poste.
 */
export function resolveAllowedPath(filePath: unknown): string {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new ScanError('Paramètre "filePath" manquant ou invalide', 400, 'BAD_REQUEST');
  }
  // Chemin relatif → depuis la racine du projet ; nom de fichier seul → depuis INPUT_DIR
  let candidate = path.isAbsolute(filePath) ? filePath : path.resolve(PROJECT_ROOT, filePath);
  if (!fs.existsSync(candidate) && !/[\\/]/.test(filePath)) candidate = path.join(config.inputDir, filePath);
  if (!fs.existsSync(candidate)) throw new ScanError(`Fichier introuvable : ${filePath}`, 404, 'FILE_NOT_FOUND');
  const real = fs.realpathSync(candidate);
  const roots = [config.inputDir, ...config.allowedRoots].filter((r) => fs.existsSync(r)).map((r) => fs.realpathSync(r));
  if (!roots.some((r) => real === r || real.startsWith(r + path.sep))) {
    throw new ScanError(
      `Chemin hors des répertoires autorisés (${[config.inputDir, ...config.allowedRoots].map(rel).join(', ')}) : ${filePath}`,
      403,
      'PATH_NOT_ALLOWED',
    );
  }
  const st = fs.statSync(real);
  if (!st.isFile()) throw new ScanError(`Ce n'est pas un fichier : ${filePath}`, 400, 'NOT_A_FILE');
  if (st.size === 0) throw new ScanError(`Fichier vide : ${filePath}`, 422, 'EMPTY_FILE');
  if (st.size > config.maxFileSize) {
    throw new ScanError(`Fichier trop volumineux (${(st.size / 1048576).toFixed(1)} Mo > ${config.maxFileSize / 1048576} Mo)`, 413, 'FILE_TOO_LARGE');
  }
  return real;
}

export async function scanFile(filePath: unknown, opts: { force?: boolean } = {}): Promise<ScanResult> {
  const absPath = resolveAllowedPath(filePath);
  const filename = path.basename(absPath);

  let kindInfo;
  try {
    kindInfo = detectKind(absPath);
  } catch (err) {
    throw new ScanError((err as Error).message, 415, 'UNSUPPORTED_FORMAT');
  }

  const buffer = fs.readFileSync(absPath);
  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');

  // Dédoublonnage : même contenu déjà scanné → on renvoie l'existant
  if (!opts.force) {
    const existing = findByHash(fileHash);
    if (existing) {
      log.info(`♻️  Déjà scanné (${filename}) → ${existing.documentId}`);
      return { success: true, documentId: existing.documentId, duplicate: true, extraction: null, tagging: existing.tagging, document: existing };
    }
  }

  const documentId = uuidv4();
  log.info(`📄 Extracting ${filename} (${kindInfo.kind}, ${(buffer.length / 1024).toFixed(0)} Ko)`);

  let extraction: ExtractionResult;
  try {
    extraction = await extractFile(absPath, buffer);
  } catch (err) {
    const message = (err as Error).message;
    log.error(`Extraction échouée pour ${filename}`, err);
    saveError({ documentId, filename, filePath: absPath, fileHash, kind: kindInfo.kind, mimeType: kindInfo.mime, fileSize: buffer.length, error: message });
    const code = err instanceof ExtractionError ? err.code : 'EXTRACTION_FAILED';
    throw new ScanError(message, code === 'EXTRACTION_FAILED' ? 500 : 422, code);
  }
  log.info(
    `   ↳ ${extraction.text.length} caractères, ${extraction.images.length} image(s)` +
      `${extraction.metadata.pageCount ? `, ${extraction.metadata.pageCount} page(s)` : ''}` +
      `${extraction.metadata.ocr?.used ? `, OCR ${Math.round((extraction.metadata.ocr.confidence ?? 0) * 100)}%` : ''}` +
      ` en ${extraction.durationMs} ms`,
  );

  log.info(`🏷️  Tagging ${filename}`);
  const tagging = await tagDocument(extraction.text, extraction, filename);
  const fmt = (c: keyof TaggingResult['tags']) => tagging.tags[c].map((t) => `${t.value} (${t.confidence})`).join(', ') || '—';
  log.info(`   ↳ sources: ${fmt('sources')} | régions: ${fmt('regions')} | thèmes: ${fmt('themes')} | produits: ${fmt('products')}`);
  log.info(`   ↳ confiance ${tagging.confidence}${tagging.requiresManualReview ? ' → ⚠️ revue manuelle requise' : ''}`);

  const { images } = saveDocument({ documentId, filename, filePath: absPath, fileHash, extraction, tagging });
  log.info(`💾 Saved ${documentId} (${images.length} image(s) → ${rel(path.join(config.imagesDir, documentId))})`);

  return {
    success: true,
    documentId,
    duplicate: false,
    extraction: {
      kind: extraction.kind,
      textLength: extraction.text.length,
      textPreview: extraction.text.slice(0, 200),
      text: extraction.text,
      imageCount: images.length,
      images: images.map((i) => ({ imageId: i.imageId, storagePath: i.storagePath, page: i.page, width: i.width, height: i.height })),
      metadata: extraction.metadata,
      durationMs: extraction.durationMs,
    },
    tagging,
  };
}

/** Liste les fichiers supportés d'un répertoire (non récursif, fichiers cachés exclus). */
export function listInputFiles(dir = config.inputDir): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => !f.startsWith('.') && SUPPORTED_EXTENSIONS[path.extname(f).toLowerCase()])
    .sort()
    .map((f) => path.join(dir, f));
}

/** Scanne séquentiellement (l'OCR est gourmand : pas de parallélisme en MVP). */
export async function scanDirectory(dir = config.inputDir, opts: { force?: boolean } = {}) {
  const results: { file: string; ok: boolean; documentId?: string; duplicate?: boolean; error?: string; code?: string }[] = [];
  for (const file of listInputFiles(dir)) {
    try {
      const r = await scanFile(file, opts);
      results.push({ file: path.basename(file), ok: true, documentId: r.documentId, duplicate: r.duplicate });
    } catch (err) {
      results.push({ file: path.basename(file), ok: false, error: (err as Error).message, code: (err as ScanError).code });
    }
  }
  return results;
}
