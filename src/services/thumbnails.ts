import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../config/env.js';
import type { ImageRecord } from '../types/document.js';

export const THUMB_WIDTH = 320;

/**
 * Renvoie le chemin d'une vignette PNG (320 px de large), générée à la
 * première demande puis réutilisée : data/images/{documentId}/thumbs/{imageId}.png.
 * Renvoie null si l'image n'est pas décodable (ex. EMF issu d'un .docx) :
 * l'appelant sert alors l'original.
 */
export async function getThumbnailPath(img: ImageRecord): Promise<string | null> {
  const original = path.resolve(config.dataDir, img.storagePath);
  const dir = path.join(config.imagesDir, img.documentId, 'thumbs');
  const thumb = path.join(dir, `${img.imageId}.png`);
  if (fs.existsSync(thumb)) return thumb;
  if (!fs.existsSync(original)) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    // écriture atomique : fichier temporaire puis renommage (requêtes concurrentes)
    const tmp = `${thumb}.${process.pid}.${Date.now()}.tmp`;
    await sharp(original).resize({ width: THUMB_WIDTH, withoutEnlargement: true }).png().toFile(tmp);
    fs.renameSync(tmp, thumb);
    return thumb;
  } catch {
    return null;
  }
}
