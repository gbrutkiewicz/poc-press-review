import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/env.js';
import { listInputFiles, resolveAllowedPath, scanFile, type ScanError, type ScanResult } from './scanner.js';
import { log } from '../utils/logger.js';

/**
 * File de scan UNIQUE, utilisée par la surveillance du dossier, l'API et l'upload.
 *
 * - Séquentielle : un seul scan à la fois (l'OCR est gourmand en RAM/CPU).
 *   Le contrôle de doublon par empreinte (findByHash) s'exécute donc toujours
 *   après l'insertion du scan précédent : deux scans du même contenu ne
 *   peuvent plus se croiser.
 * - Dédoublonnage des fichiers en cours : un fichier déjà en file ou en cours
 *   renvoie la même promesse.
 * - Source "watcher" : si le même fichier (même taille et date) vient d'être
 *   traité par une autre source (ex. l'upload, qui a déjà scanné), la
 *   surveillance réutilise ce résultat au lieu de rescanner.
 */

export type ScanSource = 'api' | 'upload' | 'watcher' | 'directory';

interface Entry {
  promise: Promise<ScanResult>;
  signature: string; // taille + mtime au moment de la mise en file
  doneAt: number | null;
}

const entries = new Map<string, Entry>(); // clé : chemin réel
const pending: string[] = [];
let running: { file: string; source: ScanSource; startedAt: string } | null = null;
let chain: Promise<unknown> = Promise.resolve();

/** Délai pendant lequel la surveillance réutilise un résultat récent (l'écriture → détection prend ~1 s). */
const RECENT_MS = 30_000;

const signatureOf = (file: string) => {
  const st = fs.statSync(file);
  return `${st.size}:${st.mtimeMs}`;
};

export function enqueue(filePath: unknown, opts: { force?: boolean; source?: ScanSource } = {}): Promise<ScanResult> {
  let abs: string;
  try {
    abs = resolveAllowedPath(filePath); // chemin réel contrôlé (lève une ScanError sinon)
  } catch (err) {
    return Promise.reject(err);
  }
  const source = opts.source ?? 'api';
  const signature = signatureOf(abs);
  const existing = entries.get(abs);

  if (existing && !opts.force) {
    if (existing.doneAt === null) return existing.promise; // déjà en file ou en cours
    if (source === 'watcher' && existing.signature === signature && Date.now() - existing.doneAt < RECENT_MS) {
      return existing.promise; // vient d'être traité par une autre source
    }
  }

  pending.push(abs);
  const promise = chain.then(async () => {
    pending.splice(pending.indexOf(abs), 1);
    running = { file: abs, source, startedAt: new Date().toISOString() };
    try {
      return await scanFile(abs, { force: opts.force });
    } finally {
      running = null;
      entry.doneAt = Date.now();
    }
  });
  const entry: Entry = { promise, signature, doneAt: null };
  entries.set(abs, entry);
  chain = promise.catch(() => undefined);
  pruneEntries();
  return promise;
}

function pruneEntries() {
  if (entries.size < 500) return;
  for (const [k, e] of entries) if (e.doneAt !== null && Date.now() - e.doneAt > RECENT_MS) entries.delete(k);
}

/** État de la file (pour l'UI). */
export function queueState() {
  const name = (f: string) => path.basename(f);
  return {
    running: running ? { file: name(running.file), source: running.source, startedAt: running.startedAt } : null,
    pending: pending.map(name),
  };
}

/** Statut d'un fichier dans la file : 'scanning' (en cours) | 'queued' (en attente) | null. */
export function queueStatusOf(absPath: string): 'scanning' | 'queued' | null {
  if (running?.file === absPath) return 'scanning';
  return pending.includes(absPath) ? 'queued' : null;
}

/** Scanne tout un dossier via la file (fichiers déjà vus ignorés sauf force). */
export async function scanDirectory(dir = config.inputDir, opts: { force?: boolean } = {}) {
  const files = listInputFiles(dir);
  const settled = await Promise.allSettled(files.map((f) => enqueue(f, { ...opts, source: 'directory' })));
  return settled.map((r, i) =>
    r.status === 'fulfilled'
      ? { file: path.basename(files[i]), ok: true, documentId: r.value.documentId, duplicate: r.value.duplicate }
      : { file: path.basename(files[i]), ok: false, error: (r.reason as Error).message, code: (r.reason as ScanError).code },
  );
}

/** Trace les échecs d'un scan lancé "en tâche de fond" (watcher). */
export function enqueueInBackground(file: string, source: ScanSource): void {
  enqueue(file, { source }).catch((err) => log.error(`Scan (${source}) : ${path.basename(file)}`, err));
}
