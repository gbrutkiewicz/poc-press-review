/**
 * Génère N documents validés FICTIFS (préfixe "seed-") pour tester la liste,
 * la recherche, les filtres et la pagination de l'onglet « Validés ».
 * Usage : npm run seed -- 50        (défaut 50 ; 10000 pour un test de charge)
 *         npm run seed -- --clean   (supprime les documents "seed-")
 */
import crypto from 'node:crypto';
import { config } from '../src/config/env.js';
import { PRODUCTS, REGIONS, SOURCES, THEMES } from '../src/config/tags.js';
import { closeDb, getDb, saveDocument, saveValidation } from '../src/services/storage.js';
import { tagByKeywords } from '../src/services/tagging.js';
import type { ExtractionResult, PlainTags } from '../src/types/document.js';

const args = process.argv.slice(2);
const db = getDb();

if (args.includes('--clean')) {
  const n = db.prepare(`DELETE FROM documents WHERE filename LIKE 'seed-%'`).run().changes;
  console.log(`🧹 ${n} document(s) "seed-" supprimé(s)`);
  closeDb();
  process.exit(0);
}

const count = Math.max(1, Number(args.find((a) => /^\d+$/.test(a)) ?? 50));
const pick = <T>(arr: readonly T[], n: number) => [...arr].sort(() => Math.random() - 0.5).slice(0, n);
const PEOPLE = ['Gilles', 'Camille', 'Inès', 'Hugo'];
const PHRASES = [
  'Le défilé haute couture à Paris a dévoilé une robe en tweed et le sac 2.55.',
  'Le parfum Chanel N°5 célébré sur Instagram par les ambassadrices à Tokyo.',
  'La montre J12 s’impose dans la presse horlogère suisse, de Genève à Dubaï.',
  'Lunettes de soleil et escarpins : les accessoires de l’été à Los Angeles.',
  'Une soirée de lancement à New York pour le parfum Coco Mademoiselle.',
  'Reportage décoration : l’art de vivre et le mobilier design à Milan.',
];

const insertAll = db.transaction(() => {
  for (let i = 1; i <= count; i++) {
    const kind = (['pdf', 'docx', 'image'] as const)[i % 3];
    const text = `--- Page 1 ---\n${pick(PHRASES, 3).join('\n')}\nArticle de test n°${i}.`;
    const extraction: ExtractionResult = {
      kind, text, images: [], durationMs: 1,
      metadata: { fileSize: 20_000 + i * 37, mimeType: kind === 'pdf' ? 'application/pdf' : kind === 'docx' ? 'application/msword' : 'image/png', pageCount: kind === 'image' ? undefined : 1 + (i % 3), warnings: [] },
    };
    const documentId = crypto.randomUUID();
    const filename = `seed-${String(i).padStart(5, '0')}.${kind === 'image' ? 'png' : kind}`;
    saveDocument({ documentId, filename, filePath: `${config.inputDir}/${filename}`, fileHash: crypto.randomBytes(32).toString('hex'), extraction, tagging: tagByKeywords(text, extraction, filename) });
    const tags: PlainTags = { sources: pick(SOURCES, 1), regions: pick(REGIONS, i % 3), themes: pick(THEMES, 1 + (i % 2)), products: pick(PRODUCTS, i % 3) };
    saveValidation(documentId, tags, PEOPLE[i % PEOPLE.length], i % 5 === 0 ? `Note de test ${i}` : null);
    // dates de validation étalées sur 90 jours
    const at = new Date(Date.now() - Math.random() * 90 * 86_400_000).toISOString();
    db.prepare(`UPDATE validations SET validated_at = ? WHERE document_id = ?`).run(at, documentId);
  }
});

const t = Date.now();
insertAll();
console.log(`🌱 ${count} document(s) validé(s) fictif(s) créés en ${Date.now() - t} ms (nettoyage : npm run seed -- --clean)`);
closeDb();
