import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { config, PROJECT_ROOT, rel } from './config/env.js';
import { TAG_LISTS, CATEGORY_RULES } from './config/tags.js';
import { shutdownOcr } from './services/ocr.js';
import { ScanError, scanDirectory, scanFile } from './services/scanner.js';
import {
  closeDb,
  getDb,
  getDocument,
  getDocumentFull,
  getImage,
  getLatestValidation,
  listDocuments,
  saveValidation,
  stats,
} from './services/storage.js';
import { CATEGORIES, isOllamaAvailable, validatePlainTags } from './services/tagging.js';
import type { DocumentStatus } from './types/document.js';
import { log } from './utils/logger.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// En-têtes de sécurité minimaux (UI locale, aucune ressource externe)
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'");
  next();
});

app.use(express.static(path.join(PROJECT_ROOT, 'public')));
app.get('/validation', (_req, res) => res.sendFile(path.join(PROJECT_ROOT, 'public', 'index.html')));

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);

/* ------------------------------------------------------------------ API -- */

app.get('/api/health', wrap(async (_req, res) => {
  res.json({ status: 'ok', stats: stats(), ollama: config.ollama.mode === 'off' ? 'off' : (await isOllamaAvailable()) ? 'available' : 'unavailable' });
}));

app.get('/api/config/tags', (_req, res) => {
  res.json({ lists: TAG_LISTS, rules: CATEGORY_RULES, reviewThreshold: config.reviewThreshold, inputDir: rel(config.inputDir) });
});

/** POST /api/scan  { filePath, force? } */
app.post('/api/scan', wrap(async (req, res) => {
  const result = await scanFile(req.body?.filePath, { force: req.body?.force === true });
  res.status(result.duplicate ? 200 : 201).json(result);
}));

/** POST /api/scan/input  — scanne tout INPUT_DIR (fichiers déjà vus ignorés) */
app.post('/api/scan/input', wrap(async (req, res) => {
  const results = await scanDirectory(config.inputDir, { force: req.body?.force === true });
  res.json({ success: true, inputDir: rel(config.inputDir), results });
}));

app.get('/api/documents', (req, res) => {
  const status = req.query.status as DocumentStatus | undefined;
  if (status && !['pending', 'validated', 'error'].includes(status)) return res.status(400).json({ success: false, error: 'status invalide' });
  res.json(listDocuments(status).map(({ extractedText, ...d }) => ({ ...d, textPreview: extractedText.slice(0, 200) })));
});

app.get('/api/documents/:id', (req, res) => {
  const doc = getDocumentFull(req.params.id);
  if (!doc) return res.status(404).json({ success: false, error: 'Document introuvable' });
  res.json(doc);
});

app.get('/api/documents/:id/images/:imageId', (req, res) => {
  const img = getImage(req.params.id, req.params.imageId);
  if (!img) return res.status(404).json({ success: false, error: 'Image introuvable' });
  const file = path.resolve(config.dataDir, img.storagePath);
  if (!file.startsWith(config.imagesDir + path.sep) || !fs.existsSync(file)) return res.status(404).json({ success: false, error: 'Fichier image manquant' });
  res.sendFile(file);
});

/** GET /api/validations/pending — plus récents d'abord */
app.get('/api/validations/pending', (_req, res) => {
  res.json(
    listDocuments('pending').map((d) => ({
      documentId: d.documentId,
      filename: d.filename,
      kind: d.kind,
      createdAt: d.createdAt,
      pageCount: d.pageCount,
      textPreview: d.extractedText.slice(0, 200),
      textLength: d.extractedText.length,
      tagging: d.tagging,
      ocr: d.metadata.ocr ?? null,
      warnings: d.metadata.warnings ?? [],
      imageCount: getDocumentFull(d.documentId)?.images?.length ?? 0,
    })),
  );
});

/** POST /api/validations/save  { documentId, tags, validatedBy, notes } */
app.post('/api/validations/save', (req, res) => {
  const { documentId, tags, validatedBy, notes } = req.body ?? {};
  if (typeof documentId !== 'string' || !getDocument(documentId)) {
    return res.status(404).json({ success: false, error: 'documentId inconnu' });
  }
  const doc = getDocument(documentId)!;
  if (doc.status === 'error') return res.status(409).json({ success: false, error: 'Document en erreur : rescanner avant validation' });
  if (typeof validatedBy !== 'string' || !validatedBy.trim() || validatedBy.length > 100) {
    return res.status(400).json({ success: false, error: '"validatedBy" requis (100 caractères max)' });
  }
  const check = validatePlainTags(tags);
  if (!check.ok) return res.status(400).json({ success: false, error: 'Tags invalides', details: check.errors });
  const validation = saveValidation(documentId, check.tags, validatedBy.trim(), typeof notes === 'string' && notes.trim() ? notes.trim().slice(0, 2000) : null);
  log.info(`✅ Validé ${doc.filename} par ${validation.validatedBy}`);
  res.json({ success: true, validation });
});

/** GET /api/export?format=json|csv — documents validés + tags validés */
app.get('/api/export', (req, res) => {
  const rows = listDocuments('validated').map((d) => ({ doc: d, v: getLatestValidation(d.documentId) }));
  if (req.query.format === 'csv') {
    const esc = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const header = ['documentId', 'filename', 'kind', ...CATEGORIES, 'validatedBy', 'validatedAt', 'notes', 'autoConfidence'];
    const lines = rows.map(({ doc, v }) =>
      [doc.documentId, doc.filename, doc.kind, ...CATEGORIES.map((c) => v?.validatedTags[c].join('; ')), v?.validatedBy, v?.validatedAt, v?.notes, doc.tagging?.confidence]
        .map(esc)
        .join(','),
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="validations.csv"');
    return res.send('﻿' + [header.join(','), ...lines].join('\n'));
  }
  res.json(rows.map(({ doc, v }) => ({ documentId: doc.documentId, filename: doc.filename, kind: doc.kind, validation: v, autoTagging: doc.tagging })));
});

app.use('/api', (_req, res) => res.status(404).json({ success: false, error: 'Route inconnue' }));

// Gestion d'erreur centralisée
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ScanError) return res.status(err.status).json({ success: false, code: err.code, error: err.message });
  if ((err as { type?: string })?.type === 'entity.parse.failed') return res.status(400).json({ success: false, code: 'BAD_JSON', error: 'JSON invalide' });
  log.error('Erreur inattendue', err);
  res.status(500).json({ success: false, code: 'INTERNAL_ERROR', error: (err as Error)?.message ?? 'Erreur interne' });
});

/* -------------------------------------------------------------- watcher -- */

async function startWatcher(): Promise<{ close: () => Promise<void> } | null> {
  if (!config.watch) return null;
  try {
    const { default: chokidar } = await import('chokidar');
    const queue: string[] = [];
    let busy = false;
    const drain = async () => {
      if (busy) return;
      busy = true;
      while (queue.length) {
        const file = queue.shift()!;
        try {
          await scanFile(file);
        } catch (err) {
          log.error(`Watcher : ${path.basename(file)}`, err);
        }
      }
      busy = false;
    };
    const watcher = chokidar.watch(config.inputDir, {
      ignoreInitial: true,
      depth: 0,
      ignored: (p: string) => path.basename(p).startsWith('.'),
      awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
    });
    watcher.on('add', (file: string) => {
      log.info(`👀 Nouveau fichier : ${path.basename(file)}`);
      queue.push(file);
      void drain();
    });
    return watcher;
  } catch {
    log.warn('chokidar non installé : surveillance désactivée');
    return null;
  }
}

/* ---------------------------------------------------------------- start -- */

async function main() {
  fs.mkdirSync(config.inputDir, { recursive: true });
  getDb(); // migrations auto

  const server = app.listen(config.port, config.host, () => {
    const host = config.host === '127.0.0.1' || config.host === '0.0.0.0' ? 'localhost' : config.host;
    log.info(`🚀 Agent running on http://${host}:${config.port}`);
  });
  server.on('error', (err) => {
    log.error(`Impossible d'écouter sur ${config.host}:${config.port}`, err);
    process.exit(1);
  });

  const watcher = await startWatcher();
  log.info(watcher ? `📁 Watching: ${rel(config.inputDir)}` : `📁 Input: ${rel(config.inputDir)} (surveillance désactivée)`);
  log.info(`💾 Database: ${rel(config.dbPath)}`);
  const s = stats();
  log.info(`📊 ${s.pending} en attente, ${s.validated} validé(s), ${s.error} en erreur`);
  if (config.ollama.mode !== 'off') {
    void isOllamaAvailable().then((ok) =>
      log.info(ok ? `🤖 Ollama disponible (${config.ollama.model})` : '🤖 Ollama absent → tagging par mots-clés uniquement'),
    );
  }

  const shutdown = async () => {
    log.info('Arrêt…');
    server.close();
    await watcher?.close();
    await shutdownOcr();
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log.error('Démarrage impossible', err);
  process.exit(1);
});
