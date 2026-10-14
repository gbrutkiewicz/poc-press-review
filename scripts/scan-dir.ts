/**
 * Scan en ligne de commande (sans serveur) de data/input ou d'un dossier donné.
 * Usage : npm run scan [-- <dossier>] [-- --force]
 *   Le dossier doit être INPUT_DIR ou listé dans ALLOWED_ROOTS (.env).
 */
import path from 'node:path';
import { config, rel } from '../src/config/env.js';
import { scanDirectory } from '../src/services/scanner.js';
import { closeDb, getDocument } from '../src/services/storage.js';
import { shutdownOcr } from '../src/services/ocr.js';

const args = process.argv.slice(2);
const force = args.includes('--force');
const dir = path.resolve(args.find((a) => !a.startsWith('--')) ?? config.inputDir);

console.log(`🔎 Scan de ${rel(dir)}${force ? ' (force)' : ''}\n`);
const results = await scanDirectory(dir, { force });

console.log('\n=== Résumé ===');
for (const r of results) {
  if (!r.ok) {
    console.log(`❌ ${r.file} — ${r.error}`);
    continue;
  }
  const d = getDocument(r.documentId!)!;
  const t = d.tagging!;
  const tags = (['sources', 'regions', 'themes', 'products'] as const)
    .map((c) => `${c}=[${t.tags[c].map((x) => x.value).join(', ')}]`)
    .join(' ');
  console.log(`${t.requiresManualReview ? '🟠' : '🟢'} ${r.file}${r.duplicate ? ' (déjà scanné)' : ''} — ${d.extractedText.length} car. — conf ${t.confidence}\n   ${tags}`);
}
if (!results.length) console.log('(aucun fichier supporté)');

await shutdownOcr();
closeDb();
