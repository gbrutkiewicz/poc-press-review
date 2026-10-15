import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { config, PROJECT_ROOT, rel } from './config/env.js';
import { TAG_LISTS, CATEGORY_RULES } from './config/tags.js';
import { ScanError } from './services/scanner.js';
import { enqueue, queueState, scanDirectory } from './services/scanQueue.js';
import {
  findAnyByHash,
  getDocument,
  getDocumentFull,
  getImage,
  getImages,
  getLastEvent,
  getValidationHistory,
  listDocuments,
  listValidated,
  listValidators,
  reopenDocument,
  saveValidation,
  stats,
  type ValidatedQuery,
} from './services/storage.js';
import { CATEGORIES, computeTagDiff, isOllamaAvailable, preselectedTags, validatePlainTags } from './services/tagging.js';
import { getThumbnailPath } from './services/thumbnails.js';
import { receiveUpload } from './services/upload.js';
import { SUPPORTED_EXTENSIONS } from './services/extraction.js';
import { queueStatusOf } from './services/scanQueue.js';
import type { DocumentStatus } from './types/document.js';
import { log } from './utils/logger.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: string[],
  ) {
    super(message);
  }
}

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);

/** Lit et contrôle les filtres de la liste des validés (query string). */
function parseValidatedQuery(q: Request['query']): ValidatedQuery {
  const str = (k: string) => (typeof q[k] === 'string' && (q[k] as string).trim() ? (q[k] as string).trim() : undefined);
  const out: ValidatedQuery = { q: str('q'), tag: str('tag'), category: str('category'), validatedBy: str('validatedBy') };

  for (const k of ['limit', 'offset'] as const) {
    const v = str(k);
    if (v === undefined) continue;
    if (!/^\d+$/.test(v)) throw new HttpError(400, 'BAD_QUERY', `"${k}" doit être un entier positif`);
    out[k] = Number(v);
  }
  if (out.limit !== undefined && (out.limit < 1 || out.limit > 100)) throw new HttpError(400, 'BAD_QUERY', '"limit" doit être entre 1 et 100');

  if (out.category && !(CATEGORIES as string[]).includes(out.category)) {
    throw new HttpError(400, 'BAD_QUERY', `"category" inconnue (attendu : ${CATEGORIES.join(', ')})`);
  }
  if (out.tag) {
    const lists = out.category ? [TAG_LISTS[out.category as keyof typeof TAG_LISTS]] : Object.values(TAG_LISTS);
    if (!lists.some((l) => l.includes(out.tag!))) throw new HttpError(400, 'BAD_QUERY', `"tag" hors liste fermée : ${out.tag}`);
  }
  for (const k of ['from', 'to'] as const) {
    const v = str(k);
    if (v === undefined) continue;
    if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v) || Number.isNaN(Date.parse(v))) {
      throw new HttpError(400, 'BAD_QUERY', `"${k}" doit être une date ISO (AAAA-MM-JJ)`);
    }
    out[k] = v;
  }
  return out;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const hostnameOf = (hostHeader: string) => hostHeader.replace(/:\d+$/, '').toLowerCase();

/**
 * Protection du serveur local contre les pages web tierces ouvertes dans le navigateur :
 * - DNS rebinding : l'en-tête Host doit désigner la machine locale (ou HOST configuré) ;
 * - CSRF : une requête qui modifie quelque chose (POST…) venant d'une autre origine est refusée.
 * Les clients sans navigateur (curl, scripts) n'envoient pas d'Origin et restent acceptés.
 */
function localOnly(req: Request, _res: Response, next: NextFunction) {
  const host = req.headers.host ?? '';
  const allowed = LOOPBACK.has(hostnameOf(host)) || hostnameOf(host) === config.host.toLowerCase();
  if (!allowed) return next(new HttpError(403, 'BAD_HOST', `Hôte non autorisé : ${host.slice(0, 100)}`));
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.headers.origin;
    let sameOrigin = true;
    if (origin) {
      try {
        sameOrigin = new URL(origin).host.toLowerCase() === host.toLowerCase();
      } catch {
        sameOrigin = false;
      }
    }
    if (!sameOrigin || req.headers['sec-fetch-site'] === 'cross-site') {
      return next(new HttpError(403, 'CROSS_ORIGIN', 'Requête provenant d’un autre site refusée'));
    }
  }
  next();
}

/** Empreinte des fichiers de data/input, mise en cache par (chemin, taille, date). */
const hashCache = new Map<string, { sig: string; hash: string }>();
function cachedHash(file: string, st: fs.Stats): string {
  const sig = `${st.size}:${st.mtimeMs}`;
  const hit = hashCache.get(file);
  if (hit?.sig === sig) return hit.hash;
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  hashCache.set(file, { sig, hash });
  return hash;
}

/** Nom de fichier sûr pour Content-Disposition (ASCII + variante UTF-8 encodée). */
function attachment(res: Response, filename: string): void {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(localOnly);
  app.use(express.json({ limit: '1mb' }));

  // En-têtes de sécurité minimaux (UI locale, aucune ressource externe)
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'",
    );
    next();
  });

  app.use(express.static(path.join(PROJECT_ROOT, 'public')));
  app.get('/validation', (_req, res) => res.sendFile(path.join(PROJECT_ROOT, 'public', 'index.html')));

  // Identifiants : format UUID obligatoire avant toute requête SQL / disque
  app.param(['id', 'imageId'], (_req, _res, next, value: string) => {
    next(UUID.test(value) ? undefined : new HttpError(400, 'BAD_ID', `Identifiant invalide : ${String(value).slice(0, 64)}`));
  });

  /* ---------------------------------------------------------------- API -- */

  app.get('/api/health', wrap(async (_req, res) => {
    res.json({ status: 'ok', stats: stats(), ollama: config.ollama.mode === 'off' ? 'off' : (await isOllamaAvailable()) ? 'available' : 'unavailable' });
  }));

  app.get('/api/config/tags', (_req, res) => {
    res.json({
      lists: TAG_LISTS,
      rules: CATEGORY_RULES,
      reviewThreshold: config.reviewThreshold,
      inputDir: rel(config.inputDir),
      maxFileSizeMb: config.maxFileSize / 1048576,
      extensions: Object.keys(SUPPORTED_EXTENSIONS),
    });
  });

  /** POST /api/scan  { filePath, force? } */
  app.post('/api/scan', wrap(async (req, res) => {
    const result = await enqueue(req.body?.filePath, { force: req.body?.force === true, source: 'api' });
    res.status(result.duplicate ? 200 : 201).json(result);
  }));

  /**
   * POST /api/upload?filename=<nom>&scan=1|0 — corps : le fichier brut (application/octet-stream).
   * Enregistre dans INPUT_DIR (nom assaini, contenu contrôlé, jamais d'écrasement) puis,
   * si scan=1 (défaut), le scanne via la file unique et renvoie le résultat.
   */
  app.post('/api/upload', wrap(async (req, res) => {
    const ctype = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (ctype && ctype !== 'application/octet-stream') {
      req.resume();
      throw new HttpError(415, 'BAD_CONTENT_TYPE', 'Envoyer le fichier brut avec Content-Type: application/octet-stream');
    }
    let saved;
    try {
      saved = await receiveUpload(req, req.query.filename);
    } catch (err) {
      if ((err as ScanError).code === 'FILE_TOO_LARGE') res.setHeader('Connection', 'close');
      throw err;
    }
    log.info(`📥 Reçu ${saved.savedAs} (${(saved.size / 1024).toFixed(0)} Ko)${saved.duplicate ? ' — déjà présent' : ''}`);
    const file = { name: saved.name, savedAs: saved.savedAs, size: saved.size, sha256: saved.sha256 };

    if (req.query.scan === '0') {
      const known = findAnyByHash(saved.sha256);
      return res.status(saved.duplicate ? 200 : 201).json({ success: true, file, duplicate: saved.duplicate, documentId: known?.documentId ?? null, scan: null });
    }
    try {
      const scan = await enqueue(saved.path, { source: 'upload' });
      const duplicate = saved.duplicate || scan.duplicate;
      // la réponse n'embarque pas le texte complet (déjà visible dans la fiche)
      const { document: _d, ...rest } = scan;
      if (rest.extraction) rest.extraction = { ...rest.extraction, text: '' };
      res.status(duplicate ? 200 : 201).json({ success: true, file, duplicate, documentId: scan.documentId, scan: rest });
    } catch (err) {
      // fichier bien enregistré mais scan en échec : visible dans l'onglet Erreurs
      const e = err as ScanError;
      res.status(201).json({ success: true, file, duplicate: saved.duplicate, documentId: null, scan: null, scanError: { code: e.code ?? 'SCAN_FAILED', error: e.message } });
    }
  }));

  /** GET /api/input — fichiers de INPUT_DIR et leur statut de scan */
  app.get('/api/input', (_req, res) => {
    const dir = config.inputDir;
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !f.startsWith('.')) : [];
    const items = files
      .map((name) => {
        const abs = path.join(dir, name);
        const st = fs.statSync(abs);
        if (!st.isFile()) return null;
        const supported = !!SUPPORTED_EXTENSIONS[path.extname(name).toLowerCase()];
        const base = { name, size: st.size, modifiedAt: st.mtime.toISOString(), supported };
        if (!supported) return { ...base, status: 'unsupported', documentId: null, error: null };
        const q = queueStatusOf(fs.realpathSync(abs));
        if (q) return { ...base, status: q, documentId: null, error: null };
        const doc = findAnyByHash(cachedHash(abs, st));
        if (!doc) return { ...base, status: 'new', documentId: null, error: null };
        return { ...base, status: doc.status, documentId: doc.documentId, error: doc.error };
      })
      .filter(Boolean)
      .sort((a, b) => b!.modifiedAt.localeCompare(a!.modifiedAt));
    res.json({ inputDir: rel(dir), items, queue: queueState() });
  });

  /** GET /api/queue — état de la file de scan */
  app.get('/api/queue', (_req, res) => res.json(queueState()));

  /** POST /api/scan/input  — scanne tout INPUT_DIR (fichiers déjà vus ignorés) */
  app.post('/api/scan/input', wrap(async (req, res) => {
    const results = await scanDirectory(config.inputDir, { force: req.body?.force === true });
    res.json({ success: true, inputDir: rel(config.inputDir), results });
  }));

  app.get('/api/documents', (req, res) => {
    const status = req.query.status as DocumentStatus | undefined;
    if (status && !['pending', 'validated', 'error'].includes(status)) throw new HttpError(400, 'BAD_QUERY', 'status invalide');
    res.json(listDocuments(status).map(({ extractedText, ...d }) => ({ ...d, textPreview: extractedText.slice(0, 200) })));
  });

  /** Fiche complète : texte, images, dernière validation, historique, diff des tags. */
  app.get('/api/documents/:id', (req, res) => {
    const doc = getDocumentFull(req.params.id);
    if (!doc) throw new HttpError(404, 'NOT_FOUND', 'Document introuvable');
    res.json({
      ...doc,
      validations: getValidationHistory(doc.documentId),
      tagDiff: doc.validation ? computeTagDiff(doc.tagging, doc.validation.validatedTags) : null,
    });
  });

  /** Texte extrait en .txt */
  app.get('/api/documents/:id/text', (req, res) => {
    const doc = getDocument(req.params.id);
    if (!doc) throw new HttpError(404, 'NOT_FOUND', 'Document introuvable');
    res.type('text/plain; charset=utf-8');
    attachment(res, `${doc.filename.replace(/\.[^.]+$/, '')}.txt`);
    res.send(doc.extractedText);
  });

  /** Image extraite ; ?size=thumb → vignette 320 px mise en cache */
  app.get('/api/documents/:id/images/:imageId', wrap(async (req, res) => {
    const img = getImage(req.params.id, req.params.imageId);
    if (!img) throw new HttpError(404, 'NOT_FOUND', 'Image introuvable');
    const file = path.resolve(config.dataDir, img.storagePath);
    if (!file.startsWith(config.imagesDir + path.sep) || !fs.existsSync(file)) throw new HttpError(404, 'IMAGE_MISSING', 'Fichier image manquant sur le disque');
    if (req.query.size === 'thumb') {
      const thumb = await getThumbnailPath(img);
      if (thumb) {
        res.setHeader('Cache-Control', 'private, max-age=86400');
        return res.sendFile(thumb);
      }
    }
    if (req.query.download === '1') attachment(res, `${req.params.imageId}.${img.format}`);
    res.sendFile(file);
  }));

  /** Remise en attente d'un document validé  { by, reason } */
  app.post('/api/documents/:id/reopen', (req, res) => {
    const doc = getDocument(req.params.id);
    if (!doc) throw new HttpError(404, 'NOT_FOUND', 'Document introuvable');
    if (doc.status !== 'validated') throw new HttpError(409, 'NOT_VALIDATED', 'Seul un document validé peut être remis en attente');
    const { by, reason } = req.body ?? {};
    const errors: string[] = [];
    if (typeof by !== 'string' || !by.trim() || by.length > 100) errors.push('"by" requis (100 caractères max)');
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000) errors.push('"reason" requis (2000 caractères max)');
    if (errors.length) throw new HttpError(400, 'BAD_REQUEST', 'Paramètres invalides', errors);
    const event = reopenDocument(doc.documentId, by.trim(), reason.trim());
    log.info(`↩️  Remis en attente ${doc.filename} par ${event.by} (${event.notes})`);
    res.json({ success: true, event });
  });

  /** GET /api/validations/pending — plus récents d'abord */
  app.get('/api/validations/pending', (_req, res) => {
    res.json(
      listDocuments('pending').map((d) => {
        const last = getLastEvent(d.documentId);
        const reopened = last?.action === 'reopen' ? last : null;
        return {
          documentId: d.documentId,
          filename: d.filename,
          kind: d.kind,
          createdAt: d.createdAt,
          pageCount: d.pageCount,
          textPreview: d.extractedText.slice(0, 200),
          textLength: d.extractedText.length,
          tagging: d.tagging,
          // document remis en attente → on repart des derniers tags validés
          preselected: reopened ? reopened.tags : preselectedTags(d.tagging),
          reopened: reopened ? { by: reopened.by, reason: reopened.notes, at: reopened.at } : null,
          ocr: d.metadata.ocr ?? null,
          warnings: d.metadata.warnings ?? [],
          imageCount: getImages(d.documentId).length,
        };
      }),
    );
  });

  /** POST /api/validations/save  { documentId, tags, validatedBy, notes } */
  app.post('/api/validations/save', (req, res) => {
    const { documentId, tags, validatedBy, notes } = req.body ?? {};
    const doc = typeof documentId === 'string' && UUID.test(documentId) ? getDocument(documentId) : null;
    if (!doc) throw new HttpError(404, 'NOT_FOUND', 'documentId inconnu');
    if (doc.status === 'error') throw new HttpError(409, 'DOCUMENT_ERROR', 'Document en erreur : rescanner avant validation');
    if (typeof validatedBy !== 'string' || !validatedBy.trim() || validatedBy.length > 100) {
      throw new HttpError(400, 'BAD_REQUEST', '"validatedBy" requis (100 caractères max)');
    }
    const check = validatePlainTags(tags);
    if (!check.ok) throw new HttpError(400, 'BAD_TAGS', 'Tags invalides', check.errors);
    const validation = saveValidation(doc.documentId, check.tags, validatedBy.trim(), typeof notes === 'string' && notes.trim() ? notes.trim().slice(0, 2000) : null);
    log.info(`✅ Validé ${doc.filename} par ${validation.validatedBy}`);
    res.json({ success: true, validation });
  });

  /** GET /api/validated — liste paginée et filtrée des documents validés */
  app.get('/api/validated', (req, res) => {
    const query = parseValidatedQuery(req.query);
    res.json({ ...listValidated(query), limit: query.limit ?? 25, offset: query.offset ?? 0, validators: listValidators() });
  });

  /** GET /api/export?format=json|csv[&filtres de /api/validated] — documents validés */
  app.get('/api/export', (req, res) => {
    const { limit: _l, offset: _o, ...filters } = parseValidatedQuery(req.query);
    const { items } = listValidated({ ...filters, withTagging: true, limit: 1_000_000 });
    if (req.query.format === 'csv') {
      const esc = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`;
      const header = ['documentId', 'filename', 'kind', ...CATEGORIES, 'validatedBy', 'validatedAt', 'notes', 'autoConfidence'];
      const lines = items.map((i) =>
        [i.documentId, i.filename, i.kind, ...CATEGORIES.map((c) => (i.validation.validatedTags[c] ?? []).join('; ')), i.validation.validatedBy, i.validation.validatedAt, i.validation.notes, i.autoConfidence]
          .map(esc)
          .join(','),
      );
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      attachment(res, 'validations.csv');
      return res.send('\uFEFF' + [header.join(','), ...lines].join('\n'));
    }
    res.json(items.map((i) => ({ documentId: i.documentId, filename: i.filename, kind: i.kind, validation: i.validation, autoTagging: i.autoTagging })));
  });

  app.use('/api', (_req, res) => res.status(404).json({ success: false, code: 'NOT_FOUND', error: 'Route inconnue' }));

  // Gestion d'erreur centralisée
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ success: false, code: err.code, error: err.message, ...(err.details ? { details: err.details } : {}) });
    if (err instanceof ScanError) return res.status(err.status).json({ success: false, code: err.code, error: err.message });
    if ((err as { type?: string })?.type === 'entity.parse.failed') return res.status(400).json({ success: false, code: 'BAD_JSON', error: 'JSON invalide' });
    log.error('Erreur inattendue', err);
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR', error: (err as Error)?.message ?? 'Erreur interne' });
  });

  return app;
}
