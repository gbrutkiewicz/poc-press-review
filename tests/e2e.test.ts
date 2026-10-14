/**
 * Bout-en-bout sur les 3 samples : extraction → tagging → SQLite → fichiers.
 * Utilise un DATA_DIR temporaire (n'affecte pas data/).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-scanner-test-'));
process.env.DATA_DIR = TMP;
process.env.INPUT_DIR = path.join(TMP, 'input');
process.env.OLLAMA_MODE = 'off';
process.env.WATCH = 'false';

const { scanFile, ScanError } = await import('../src/services/scanner.js');
const storage = await import('../src/services/storage.js');
const { shutdownOcr } = await import('../src/services/ocr.js');

before(() => {
  fs.mkdirSync(process.env.INPUT_DIR!, { recursive: true });
  for (const f of ['sample-fashion.pdf', 'sample-report.docx', 'sample-screenshot.png']) {
    fs.copyFileSync(path.join(ROOT, 'samples', f), path.join(process.env.INPUT_DIR!, f));
  }
});

after(async () => {
  await shutdownOcr();
  storage.closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

function assertImagesOnDisk(documentId: string, expected: number) {
  const imgs = storage.getImages(documentId);
  assert.equal(imgs.length, expected);
  for (const i of imgs) assert.ok(fs.statSync(path.join(TMP, i.storagePath)).size > 0, `image manquante ${i.storagePath}`);
}

test('PDF : texte par page, image embarquée, métadonnées, tags', async () => {
  const r = await scanFile('sample-fashion.pdf');
  assert.match(r.extraction!.text, /--- Page 1 ---/);
  assert.match(r.extraction!.text, /--- Page 2 ---/);
  assert.match(r.extraction!.text, /tweed/);
  assert.equal(r.extraction!.metadata.pageCount, 2);
  assert.ok(r.extraction!.imageCount >= 1);
  assertImagesOnDisk(r.documentId, r.extraction!.imageCount);
  assert.equal(r.tagging!.tags.themes[0].value, 'Mode');
  assert.ok(r.tagging!.tags.regions.some((t) => t.value === 'EMEA'));
});

test('DOCX : paragraphes + tableau + image', async () => {
  const r = await scanFile('sample-report.docx');
  const text = r.extraction!.text;
  assert.match(text, /Rapport de retombées presse/);
  assert.match(text, /Chanel N°5 \| APAC/); // ligne de tableau
  assert.ok(r.extraction!.imageCount >= 1);
  assertImagesOnDisk(r.documentId, r.extraction!.imageCount);
  const products = r.tagging!.tags.products.map((t) => t.value);
  for (const p of ['Chanel N°5', 'Montre J12', 'Sac Grand Shopping']) assert.ok(products.includes(p), p);
});

test('PNG : OCR fr+eng, source Instagram', { timeout: 120_000 }, async () => {
  const r = await scanFile('sample-screenshot.png');
  assert.ok(r.extraction!.metadata.ocr?.used);
  assert.match(r.extraction!.text, /Instagram/i);
  assert.equal(r.tagging!.tags.sources[0].value, 'Instagram');
  assertImagesOnDisk(r.documentId, 1);
});

test('Dédoublonnage par hash', async () => {
  const r = await scanFile('sample-fashion.pdf');
  assert.equal(r.duplicate, true);
});

test('Validation humaine → statut validated', () => {
  const pending = storage.listDocuments('pending');
  assert.equal(pending.length, 3);
  storage.saveValidation(pending[0].documentId, { sources: ['Instagram'], regions: [], themes: ['Mode'], products: [] }, 'test', null);
  assert.equal(storage.getDocument(pending[0].documentId)!.status, 'validated');
  assert.equal(storage.listDocuments('pending').length, 2);
});

test('Erreurs : chemin hors racine, format non supporté, fichier corrompu', async () => {
  await assert.rejects(scanFile('/etc/hosts'), (e: InstanceType<typeof ScanError>) => e.code === 'PATH_NOT_ALLOWED');
  await assert.rejects(scanFile('nope.pdf'), (e: InstanceType<typeof ScanError>) => e.code === 'FILE_NOT_FOUND');
  fs.writeFileSync(path.join(process.env.INPUT_DIR!, 'notes.txt'), 'hello');
  await assert.rejects(scanFile('notes.txt'), (e: InstanceType<typeof ScanError>) => e.code === 'UNSUPPORTED_FORMAT');
  fs.writeFileSync(path.join(process.env.INPUT_DIR!, 'fake.pdf'), 'pas un pdf');
  await assert.rejects(scanFile('fake.pdf'), (e: InstanceType<typeof ScanError>) => e.code === 'CORRUPTED_FILE');
  assert.equal(storage.listDocuments('error').length, 1); // l'échec est tracé
});
