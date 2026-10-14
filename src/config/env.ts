import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Racine du projet (dist/src/config/env.js → ../../..). */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Mini-parseur .env (évite une dépendance ; Node 18 n'a pas --env-file). */
function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    const [, key, raw] = m;
    if (process.env[key] !== undefined) continue; // l'environnement réel prime
    process.env[key] = raw.replace(/^(['"])(.*)\1$/, '$2');
  }
}
loadDotEnv(path.join(PROJECT_ROOT, '.env'));

const str = (k: string, d: string) => process.env[k]?.trim() || d;
const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && process.env[k]?.trim() ? v : d;
};
const abs = (p: string) => (path.isAbsolute(p) ? p : path.resolve(PROJECT_ROOT, p));

const dataDir = abs(str('DATA_DIR', './data'));

export type OllamaMode = 'auto' | 'off' | 'always';

export const config = {
  host: str('HOST', '127.0.0.1'),
  port: num('PORT', 3000),
  dataDir,
  inputDir: abs(str('INPUT_DIR', path.join(dataDir, 'input'))),
  imagesDir: path.join(dataDir, 'images'),
  tessdataDir: path.join(dataDir, 'tessdata'),
  dbPath: path.join(dataDir, 'scanner.db'),
  allowedRoots: str('ALLOWED_ROOTS', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(abs),
  maxFileSize: num('MAX_FILE_SIZE_MB', 50) * 1024 * 1024,
  reviewThreshold: num('REVIEW_THRESHOLD', 0.6),
  minTagScore: num('MIN_TAG_SCORE', 0.2),
  ocrLangs: str('OCR_LANGS', 'fra+eng'),
  watch: str('WATCH', 'true') !== 'false',
  ollama: {
    mode: (['auto', 'off', 'always'].includes(str('OLLAMA_MODE', 'auto'))
      ? str('OLLAMA_MODE', 'auto')
      : 'auto') as OllamaMode,
    url: str('OLLAMA_URL', 'http://localhost:11434'),
    model: str('OLLAMA_MODEL', 'llama3.1'),
  },
};

/** Chemin affiché relativement à la racine (logs lisibles). */
export const rel = (p: string) => {
  const r = path.relative(PROJECT_ROOT, p);
  return r.startsWith('..') ? p : `./${r}`;
};
