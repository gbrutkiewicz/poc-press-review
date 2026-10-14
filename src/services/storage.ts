import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config/env.js';
import { CATEGORIES } from './tagging.js';
import type {
  DocumentRecord,
  DocumentStatus,
  ExtractionResult,
  ImageRecord,
  PlainTags,
  TaggingResult,
  ValidatedListItem,
  ValidationEvent,
  ValidationRecord,
} from '../types/document.js';

/** Migrations versionnées, appliquées automatiquement au démarrage. */
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'schema initial',
    sql: `
      CREATE TABLE documents (
        document_id     TEXT PRIMARY KEY,
        filename        TEXT NOT NULL,
        file_path       TEXT NOT NULL,
        file_hash       TEXT NOT NULL,
        kind            TEXT NOT NULL,
        mime_type       TEXT NOT NULL,
        file_size       INTEGER NOT NULL,
        page_count      INTEGER,
        extracted_text  TEXT NOT NULL DEFAULT '',
        metadata_json   TEXT NOT NULL DEFAULT '{}',
        tags_json       TEXT,
        confidence      REAL,
        requires_review INTEGER NOT NULL DEFAULT 1,
        status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','validated','error')),
        error           TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX idx_documents_status ON documents(status, created_at DESC);
      CREATE INDEX idx_documents_hash ON documents(file_hash);

      CREATE TABLE images (
        image_id      TEXT PRIMARY KEY,
        document_id   TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
        storage_path  TEXT NOT NULL,
        format        TEXT NOT NULL,
        width         INTEGER,
        height        INTEGER,
        page          INTEGER,
        origin        TEXT NOT NULL,
        extracted_at  TEXT NOT NULL
      );
      CREATE INDEX idx_images_document ON images(document_id);

      CREATE TABLE validations (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id     TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
        validated_tags  TEXT NOT NULL,
        validated_by    TEXT NOT NULL,
        notes           TEXT,
        validated_at    TEXT NOT NULL
      );
      CREATE INDEX idx_validations_document ON validations(document_id);
    `,
  },
  {
    version: 2,
    name: 'historique des validations (validate / reopen)',
    // Une ligne par événement : 'validate' (validation humaine) ou 'reopen'
    // (remise en attente ; validated_by = auteur, notes = motif,
    // validated_tags = instantané des tags validés au moment de la remise).
    sql: `
      ALTER TABLE validations ADD COLUMN action TEXT NOT NULL DEFAULT 'validate' CHECK (action IN ('validate','reopen'));
      CREATE INDEX idx_validations_doc_action ON validations(document_id, action, id);
      CREATE INDEX idx_validations_date ON validations(validated_at DESC);
      CREATE INDEX idx_validations_by ON validations(validated_by COLLATE NOCASE);
    `,
  },
];

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  fs.mkdirSync(config.imagesDir, { recursive: true });
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(d: Database.Database): number[] {
  d.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT NOT NULL)`);
  const done = new Set((d.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version));
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    d.transaction(() => {
      d.exec(m.sql);
      d.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
    })();
    applied.push(m.version);
  }
  return applied;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

/* --------------------------------------------------------------- écriture -- */

export interface SaveInput {
  documentId: string;
  filename: string;
  filePath: string;
  fileHash: string;
  extraction: ExtractionResult;
  tagging: TaggingResult;
}

/**
 * Écrit les images sur disque PUIS insère document + images dans une seule
 * transaction. En cas d'échec, les fichiers déjà écrits sont supprimés
 * (pas d'orphelins, pas de ligne SQL pointant vers un fichier absent).
 */
export function saveDocument(input: SaveInput): { document: DocumentRecord; images: ImageRecord[] } {
  const d = getDb();
  const now = new Date().toISOString();
  const dir = path.join(config.imagesDir, input.documentId);
  const images: ImageRecord[] = [];

  try {
    if (input.extraction.images.length) fs.mkdirSync(dir, { recursive: true });
    for (const img of input.extraction.images) {
      const file = path.join(dir, `${img.imageId}.${img.format}`);
      fs.writeFileSync(file, img.buffer);
      // Vérification d'intégrité : le fichier doit exister avec la bonne taille
      if (fs.statSync(file).size !== img.buffer.length) throw new Error(`Écriture incomplète : ${file}`);
      images.push({
        imageId: img.imageId,
        documentId: input.documentId,
        storagePath: path.relative(config.dataDir, file),
        format: img.format,
        width: img.width ?? null,
        height: img.height ?? null,
        page: img.page ?? null,
        origin: img.origin,
        extractedAt: now,
      });
    }

    d.transaction(() => {
      const { extraction: ex, tagging: tg } = input;
      // Un rescan réussi remplace les traces d'échec du même fichier
      d.prepare(`DELETE FROM documents WHERE file_hash = ? AND status = 'error'`).run(input.fileHash);
      d.prepare(
        `INSERT INTO documents (document_id, filename, file_path, file_hash, kind, mime_type, file_size, page_count,
           extracted_text, metadata_json, tags_json, confidence, requires_review, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(
        input.documentId, input.filename, input.filePath, input.fileHash, ex.kind, ex.metadata.mimeType,
        ex.metadata.fileSize, ex.metadata.pageCount ?? null, ex.text, JSON.stringify(ex.metadata),
        JSON.stringify(tg), tg.confidence, tg.requiresManualReview ? 1 : 0, now, now,
      );
      const ins = d.prepare(
        `INSERT INTO images (image_id, document_id, storage_path, format, width, height, page, origin, extracted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const i of images) ins.run(i.imageId, i.documentId, i.storagePath, i.format, i.width, i.height, i.page, i.origin, i.extractedAt);
    })();
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }

  return { document: getDocument(input.documentId)!, images };
}

/** Trace un échec de scan (visible dans l'API, n'apparaît pas dans "pending"). */
export function saveError(p: { documentId: string; filename: string; filePath: string; fileHash: string; kind: string; mimeType: string; fileSize: number; error: string }): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO documents (document_id, filename, file_path, file_hash, kind, mime_type, file_size, status, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'error', ?, ?, ?)`,
    )
    .run(p.documentId, p.filename, p.filePath, p.fileHash, p.kind, p.mimeType, p.fileSize, p.error, now, now);
}

export function saveValidation(documentId: string, tags: PlainTags, validatedBy: string, notes: string | null): ValidationRecord {
  const d = getDb();
  const now = new Date().toISOString();
  d.transaction(() => {
    d.prepare('INSERT INTO validations (document_id, validated_tags, validated_by, notes, validated_at) VALUES (?, ?, ?, ?, ?)').run(
      documentId, JSON.stringify(tags), validatedBy, notes, now,
    );
    d.prepare(`UPDATE documents SET status = 'validated', updated_at = ? WHERE document_id = ?`).run(now, documentId);
  })();
  return { documentId, validatedTags: tags, validatedBy, notes, validatedAt: now };
}

/* ---------------------------------------------------------------- lecture -- */

interface DocRow {
  document_id: string; filename: string; file_path: string; file_hash: string; kind: string; mime_type: string;
  file_size: number; page_count: number | null; extracted_text: string; metadata_json: string; tags_json: string | null;
  status: DocumentStatus; error: string | null; created_at: string; updated_at: string;
}

function toRecord(r: DocRow): DocumentRecord {
  return {
    documentId: r.document_id,
    filename: r.filename,
    filePath: r.file_path,
    fileHash: r.file_hash,
    kind: r.kind as DocumentRecord['kind'],
    mimeType: r.mime_type,
    fileSize: r.file_size,
    pageCount: r.page_count,
    extractedText: r.extracted_text,
    metadata: JSON.parse(r.metadata_json),
    tagging: r.tags_json ? JSON.parse(r.tags_json) : null,
    status: r.status,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getDocument(documentId: string): DocumentRecord | null {
  const r = getDb().prepare('SELECT * FROM documents WHERE document_id = ?').get(documentId) as DocRow | undefined;
  return r ? toRecord(r) : null;
}

export function getDocumentFull(documentId: string): DocumentRecord | null {
  const doc = getDocument(documentId);
  if (!doc) return null;
  doc.images = getImages(documentId);
  doc.validation = getLatestValidation(documentId);
  return doc;
}

export function findByHash(hash: string): DocumentRecord | null {
  const r = getDb()
    .prepare(`SELECT * FROM documents WHERE file_hash = ? AND status != 'error' ORDER BY created_at DESC LIMIT 1`)
    .get(hash) as DocRow | undefined;
  return r ? toRecord(r) : null;
}

export function listDocuments(status?: DocumentStatus): DocumentRecord[] {
  const rows = (
    status
      ? getDb().prepare('SELECT * FROM documents WHERE status = ? ORDER BY created_at DESC, rowid DESC').all(status)
      : getDb().prepare('SELECT * FROM documents ORDER BY created_at DESC, rowid DESC').all()
  ) as DocRow[];
  return rows.map(toRecord);
}

export function getImages(documentId: string): ImageRecord[] {
  return (getDb().prepare('SELECT * FROM images WHERE document_id = ? ORDER BY page, extracted_at').all(documentId) as Record<string, unknown>[]).map(
    (r) => ({
      imageId: r.image_id as string,
      documentId: r.document_id as string,
      storagePath: r.storage_path as string,
      format: r.format as string,
      width: r.width as number | null,
      height: r.height as number | null,
      page: r.page as number | null,
      origin: r.origin as ImageRecord['origin'],
      extractedAt: r.extracted_at as string,
    }),
  );
}

export function getImage(documentId: string, imageId: string): ImageRecord | null {
  return getImages(documentId).find((i) => i.imageId === imageId) ?? null;
}

export function getLatestValidation(documentId: string): ValidationRecord | null {
  const r = getDb()
    .prepare(`SELECT * FROM validations WHERE document_id = ? AND action = 'validate' ORDER BY id DESC LIMIT 1`)
    .get(documentId) as Record<string, string> | undefined;
  if (!r) return null;
  return {
    documentId: r.document_id,
    validatedTags: JSON.parse(r.validated_tags),
    validatedBy: r.validated_by,
    notes: r.notes,
    validatedAt: r.validated_at,
  };
}

export function stats(): Record<DocumentStatus | 'images', number> {
  const d = getDb();
  const count = (s: string) => (d.prepare('SELECT COUNT(*) AS n FROM documents WHERE status = ?').get(s) as { n: number }).n;
  return {
    pending: count('pending'),
    validated: count('validated'),
    error: count('error'),
    images: (d.prepare('SELECT COUNT(*) AS n FROM images').get() as { n: number }).n,
  };
}

/* ------------------------------------------------- historique / reopen -- */

function toEvent(r: Record<string, unknown>): ValidationEvent {
  return {
    id: r.id as number,
    documentId: r.document_id as string,
    action: r.action as ValidationEvent['action'],
    tags: JSON.parse(r.validated_tags as string),
    by: r.validated_by as string,
    notes: (r.notes as string | null) ?? null,
    at: r.validated_at as string,
  };
}

/** Historique complet (validations + remises en attente), du plus récent au plus ancien. */
export function getValidationHistory(documentId: string): ValidationEvent[] {
  return (getDb().prepare('SELECT * FROM validations WHERE document_id = ? ORDER BY id DESC').all(documentId) as Record<string, unknown>[]).map(toEvent);
}

/** Dernier événement (validate ou reopen) — sert à savoir si un document "pending" a été remis en attente. */
export function getLastEvent(documentId: string): ValidationEvent | null {
  const r = getDb().prepare('SELECT * FROM validations WHERE document_id = ? ORDER BY id DESC LIMIT 1').get(documentId) as
    | Record<string, unknown>
    | undefined;
  return r ? toEvent(r) : null;
}

/** Remet un document validé en attente. Rien n'est supprimé : l'action est tracée. */
export function reopenDocument(documentId: string, by: string, reason: string): ValidationEvent {
  const d = getDb();
  const now = new Date().toISOString();
  const last = getLatestValidation(documentId);
  let id = 0;
  d.transaction(() => {
    id = Number(
      d
        .prepare(`INSERT INTO validations (document_id, validated_tags, validated_by, notes, validated_at, action) VALUES (?, ?, ?, ?, ?, 'reopen')`)
        .run(documentId, JSON.stringify(last?.validatedTags ?? {}), by, reason, now).lastInsertRowid,
    );
    d.prepare(`UPDATE documents SET status = 'pending', updated_at = ? WHERE document_id = ?`).run(now, documentId);
  })();
  return { id, documentId, action: 'reopen', tags: last?.validatedTags ?? ({} as PlainTags), by, notes: reason, at: now };
}

/* ------------------------------------------------- liste des validés -- */

export interface ValidatedQuery {
  limit?: number;
  offset?: number;
  q?: string;
  category?: string;
  tag?: string;
  validatedBy?: string;
  from?: string; // ISO (date ou date-heure), inclus
  to?: string; // ISO ; une date seule (AAAA-MM-JJ) inclut toute la journée
  withTagging?: boolean; // ajoute le tagging automatique (export)
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Dernière validation de chaque document (sous-requête réutilisée). */
const LATEST_VALIDATION = `
  SELECT v.* FROM validations v
  WHERE v.action = 'validate'
    AND v.id = (SELECT MAX(v2.id) FROM validations v2 WHERE v2.document_id = v.document_id AND v2.action = 'validate')`;

/**
 * Liste paginée des documents validés, jointe à leur dernière validation,
 * triée par date de validation décroissante. Le texte complet n'est pas
 * renvoyé (aperçu de 200 caractères).
 * Recherche : LIKE sur nom de fichier, texte extrait et notes.
 * TODO(FTS5) : remplacer le LIKE par une table virtuelle FTS5 au-delà de ~50k documents.
 */
export function listValidated(query: ValidatedQuery = {}): { total: number; items: ValidatedListItem[] } {
  const where: string[] = [`d.status = 'validated'`];
  const params: unknown[] = [];

  if (query.q?.trim()) {
    const like = `%${escapeLike(query.q.trim())}%`;
    where.push(`(d.filename LIKE ? ESCAPE '\\' OR d.extracted_text LIKE ? ESCAPE '\\' OR lv.notes LIKE ? ESCAPE '\\')`);
    params.push(like, like, like);
  }
  if (query.tag) {
    if (query.category) {
      // category est contrôlée en amont (liste blanche) : interpolation sûre
      if (!(CATEGORIES as string[]).includes(query.category)) throw new Error(`Catégorie inconnue : ${query.category}`);
      where.push(`EXISTS (SELECT 1 FROM json_each(lv.validated_tags, '$.${query.category}') WHERE value = ?)`);
    } else {
      where.push(`EXISTS (SELECT 1 FROM json_tree(lv.validated_tags) WHERE type = 'text' AND atom = ?)`);
    }
    params.push(query.tag);
  }
  if (query.validatedBy?.trim()) {
    where.push(`lv.validated_by = ? COLLATE NOCASE`);
    params.push(query.validatedBy.trim());
  }
  if (query.from) {
    where.push(`lv.validated_at >= ?`);
    params.push(new Date(query.from).toISOString());
  }
  if (query.to) {
    const end = new Date(query.to);
    if (/^\d{4}-\d{2}-\d{2}$/.test(query.to)) end.setUTCDate(end.getUTCDate() + 1); // journée incluse
    where.push(/^\d{4}-\d{2}-\d{2}$/.test(query.to) ? `lv.validated_at < ?` : `lv.validated_at <= ?`);
    params.push(end.toISOString());
  }

  const from = `FROM documents d JOIN (${LATEST_VALIDATION}) lv ON lv.document_id = d.document_id WHERE ${where.join(' AND ')}`;
  const d = getDb();
  const total = (d.prepare(`SELECT COUNT(*) AS n ${from}`).get(...params) as { n: number }).n;

  const limit = Math.min(Math.max(Math.trunc(query.limit ?? 25), 1), query.withTagging ? 1_000_000 : 100);
  const offset = Math.max(Math.trunc(query.offset ?? 0), 0);
  const rows = d
    .prepare(
      `SELECT d.document_id, d.filename, d.kind, d.file_size, d.page_count, d.confidence, d.created_at,
              substr(d.extracted_text, 1, 200) AS preview,
              ${query.withTagging ? 'd.tags_json,' : ''}
              (SELECT COUNT(*) FROM images i WHERE i.document_id = d.document_id) AS image_count,
              lv.validated_tags, lv.validated_by, lv.validated_at, lv.notes
       ${from}
       ORDER BY lv.validated_at DESC, lv.id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Record<string, unknown>[];

  return {
    total,
    items: rows.map((r) => ({
      documentId: r.document_id as string,
      filename: r.filename as string,
      kind: r.kind as ValidatedListItem['kind'],
      fileSize: r.file_size as number,
      pageCount: r.page_count as number | null,
      imageCount: r.image_count as number,
      autoConfidence: r.confidence as number | null,
      textPreview: r.preview as string,
      scannedAt: r.created_at as string,
      validation: {
        documentId: r.document_id as string,
        validatedTags: JSON.parse(r.validated_tags as string),
        validatedBy: r.validated_by as string,
        validatedAt: r.validated_at as string,
        notes: (r.notes as string | null) ?? null,
      },
      ...(query.withTagging ? { autoTagging: r.tags_json ? JSON.parse(r.tags_json as string) : null } : {}),
    })),
  };
}

/** Validateurs distincts (pour le filtre de l'UI). */
export function listValidators(): string[] {
  return (
    getDb().prepare(`SELECT DISTINCT validated_by AS v FROM validations WHERE action = 'validate' ORDER BY v COLLATE NOCASE`).all() as { v: string }[]
  ).map((r) => r.v);
}
