import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import sharp from 'sharp';
import { config } from '../config/env.js';
import { checkMagicBytes, ExtractionError, SUPPORTED_EXTENSIONS } from './extraction.js';
import { ScanError } from './scanner.js';

/** Préfixe des fichiers temporaires (cachés → ignorés par la surveillance du dossier). */
export const PART_PREFIX = '.upload-';
const MAX_NAME_LENGTH = 150;

/**
 * Assainit un nom de fichier fourni par le navigateur :
 * dernier segment uniquement (pas de chemin), Unicode NFC, sans caractères de
 * contrôle ni réservés, sans point initial, 150 caractères max, extension en
 * liste blanche.
 */
export function sanitizeFilename(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new ScanError('Paramètre "filename" manquant', 400, 'BAD_FILENAME');
  let name = raw.normalize('NFC').split(/[\\/]/).pop() ?? '';
  name = name
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '');

  const ext = path.extname(name);
  if (!SUPPORTED_EXTENSIONS[ext.toLowerCase()]) {
    throw new ScanError(
      `Format non supporté : "${ext || '(sans extension)'}". Acceptés : ${Object.keys(SUPPORTED_EXTENSIONS).join(', ')}`,
      415,
      'UNSUPPORTED_FORMAT',
    );
  }
  let base = name.slice(0, -ext.length).trim();
  if (!base) throw new ScanError('Nom de fichier invalide', 400, 'BAD_FILENAME');
  if (base.length + ext.length > MAX_NAME_LENGTH) base = base.slice(0, MAX_NAME_LENGTH - ext.length).trim();
  return base + ext;
}

/** Variante suffixée : "nom.pdf" → "nom (2).pdf". */
export function suffixedName(name: string, n: number): string {
  const ext = path.extname(name);
  return `${name.slice(0, -ext.length)} (${n})${ext}`;
}

const sha256File = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export interface SavedUpload {
  name: string; // nom demandé (assaini)
  savedAs: string; // nom final dans data/input
  path: string;
  size: number;
  sha256: string;
  duplicate: boolean; // même nom et même contenu déjà présents : aucune copie
}

/**
 * Reçoit le corps brut de la requête dans data/input :
 *  1. écriture en flux dans un fichier caché .upload-<uuid>.part, avec limite
 *     de taille appliquée pendant la réception ;
 *  2. contrôle du contenu (vide, signature binaire, image décodable) ;
 *  3. publication atomique sans écrasement (link + unlink ; suffixe (2), (3)…
 *     si un fichier différent porte déjà ce nom).
 * Le fichier temporaire est toujours supprimé en cas d'échec.
 */
export async function receiveUpload(req: IncomingMessage, rawName: unknown): Promise<SavedUpload> {
  const name = sanitizeFilename(rawName);
  const max = config.maxFileSize;
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) {
    req.resume();
    throw new ScanError(`Fichier trop volumineux (${(declared / 1048576).toFixed(1)} Mo > ${max / 1048576} Mo)`, 413, 'FILE_TOO_LARGE');
  }

  fs.mkdirSync(config.inputDir, { recursive: true });
  const tmp = path.join(config.inputDir, `${PART_PREFIX}${crypto.randomUUID()}.part`);
  const hash = crypto.createHash('sha256');
  let size = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(tmp, { flags: 'wx' });
      const fail = (err: Error) => {
        req.unpipe(out);
        out.destroy();
        reject(err);
      };
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > max) {
          req.pause();
          fail(new ScanError(`Fichier trop volumineux (> ${max / 1048576} Mo)`, 413, 'FILE_TOO_LARGE'));
          return;
        }
        hash.update(chunk);
      });
      req.on('aborted', () => fail(new ScanError('Envoi interrompu', 400, 'UPLOAD_ABORTED')));
      req.on('error', fail);
      out.on('error', fail);
      out.on('finish', resolve);
      req.pipe(out);
    });

    if (size === 0) throw new ScanError('Fichier vide', 422, 'EMPTY_FILE');
    const kind = SUPPORTED_EXTENSIONS[path.extname(name).toLowerCase()].kind;
    const head = Buffer.alloc(16);
    const fd = fs.openSync(tmp, 'r');
    fs.readSync(fd, head, 0, 16, 0);
    fs.closeSync(fd);
    try {
      checkMagicBytes(head, kind);
      if (kind === 'image') await sharp(tmp).metadata();
    } catch (err) {
      const msg = err instanceof ExtractionError ? err.message : `Le contenu ne correspond pas à une image valide`;
      throw new ScanError(msg, 422, 'CORRUPTED_FILE');
    }

    const sha256 = hash.digest('hex');
    for (let n = 1; n < 1000; n++) {
      const candidate = n === 1 ? name : suffixedName(name, n);
      const target = path.join(config.inputDir, candidate);
      // ceinture et bretelles : le chemin final doit rester dans INPUT_DIR
      if (path.dirname(path.resolve(target)) !== path.resolve(config.inputDir)) throw new ScanError('Nom de fichier invalide', 400, 'BAD_FILENAME');
      if (fs.existsSync(target)) {
        if (fs.statSync(target).size === size && sha256File(target) === sha256) {
          fs.rmSync(tmp, { force: true });
          return { name, savedAs: candidate, path: target, size, sha256, duplicate: true };
        }
        continue;
      }
      try {
        fs.linkSync(tmp, target); // échoue (EEXIST) si le nom vient d'être pris : jamais d'écrasement
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw err;
      }
      fs.rmSync(tmp, { force: true });
      return { name, savedAs: candidate, path: target, size, sha256, duplicate: false };
    }
    throw new ScanError('Trop de fichiers portent déjà ce nom', 409, 'NAME_CONFLICT');
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Supprime les fichiers temporaires laissés par un arrêt brutal. */
export function cleanupPartials(): number {
  if (!fs.existsSync(config.inputDir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(config.inputDir)) {
    if (f.startsWith(PART_PREFIX) && f.endsWith('.part')) {
      fs.rmSync(path.join(config.inputDir, f), { force: true });
      n++;
    }
  }
  return n;
}
