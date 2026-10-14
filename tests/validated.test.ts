/**
 * Onglet « Validés » : migration v2, /api/validated, fiche, texte, vignettes,
 * remise en attente, garde-fou XSS. DATA_DIR temporaire.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-scanner-validated-'));
process.env.DATA_DIR = TMP;
process.env.INPUT_DIR = path.join(TMP, 'input');
process.env.OLLAMA_MODE = 'off';

const storage = await import('../src/services/storage.js');
const { createApp } = await import('../src/app.js');
const { scanFile } = await import('../src/services/scanner.js');

let server: Server;
let base = '';
const ids: Record<string, string> = {};
const LEGACY_ID = '00000000-0000-4000-8000-000000000001';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Res = { status: number; body: any; headers: Headers };
const get = async (url: string): Promise<Res> => {
  const r = await fetch(base + url);
  return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text(), headers: r.headers };
};
const post = async (url: string, data: unknown): Promise<Omit<Res, 'headers'>> => {
  const r = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  return { status: r.status, body: await r.json() };
};
const validate = (documentId: string, tags: Record<string, string[]>, validatedBy = 'Gilles', notes?: string) =>
  post('/api/validations/save', { documentId, tags: { sources: [], regions: [], themes: [], products: [], ...tags }, validatedBy, notes });

before(async () => {
  // 1. Base au schéma v1 avec un document validé "historique"
  fs.mkdirSync(path.dirname(path.join(TMP, 'scanner.db')), { recursive: true });
  const v1 = new Database(path.join(TMP, 'scanner.db'));
  v1.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT NOT NULL)`);
  v1.exec(storage.MIGRATIONS[0].sql);
  v1.prepare(`INSERT INTO schema_migrations VALUES (1, 'v1', ?)`).run(new Date().toISOString());
  const now = '2026-01-15T10:00:00.000Z';
  v1.prepare(
    `INSERT INTO documents (document_id, filename, file_path, file_hash, kind, mime_type, file_size, extracted_text, status, created_at, updated_at)
     VALUES (?, 'ancien.pdf', '/x/ancien.pdf', 'h1', 'pdf', 'application/pdf', 10, 'Texte <img src=x onerror=alert(1)> ancien', 'validated', ?, ?)`,
  ).run(LEGACY_ID, now, now);
  v1.prepare(`INSERT INTO validations (document_id, validated_tags, validated_by, notes, validated_at) VALUES (?, ?, 'Camille', 'v1', ?)`).run(
    LEGACY_ID, JSON.stringify({ sources: ['Blog'], regions: [], themes: ['Mode'], products: [] }), now,
  );
  v1.close();

  // 2. Samples
  fs.mkdirSync(process.env.INPUT_DIR!, { recursive: true });
  for (const f of ['sample-fashion.pdf', 'sample-report.docx']) fs.copyFileSync(path.join(ROOT, 'samples', f), path.join(process.env.INPUT_DIR!, f));
  ids.pdf = (await scanFile('sample-fashion.pdf')).documentId;
  ids.docx = (await scanFile('sample-report.docx')).documentId;

  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server?.close();
  storage.closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('migration v2 appliquée sur une base v1 sans perte de données', () => {
  const db = storage.getDb();
  const versions = (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[]).map((r) => r.version);
  assert.deepEqual(versions, [1, 2]);
  const legacy = storage.getLatestValidation(LEGACY_ID);
  assert.equal(legacy?.validatedBy, 'Camille');
  assert.deepEqual(legacy?.validatedTags.themes, ['Mode']);
  assert.equal(storage.getValidationHistory(LEGACY_ID)[0].action, 'validate');
});

test('validation + /api/validated : tri, champs, pas de texte complet', async () => {
  assert.equal((await validate(ids.pdf, { sources: ['Magazine Papier'], regions: ['EMEA'], themes: ['Mode', 'Maroquinerie'], products: ['Sac 2.55'] })).status, 200);
  assert.equal((await validate(ids.docx, { sources: ['Autre'], themes: ['Horlogerie'], products: ['Montre J12'] }, 'Inès', 'rapport T3')).status, 200);

  const { status, body } = await get('/api/validated');
  assert.equal(status, 200);
  assert.equal(body.total, 3);
  assert.deepEqual(body.items.map((i: { documentId: string }) => i.documentId), [ids.docx, ids.pdf, LEGACY_ID]); // plus récent d'abord
  const pdf = body.items[1];
  assert.equal(pdf.filename, 'sample-fashion.pdf');
  assert.ok(pdf.imageCount >= 1);
  assert.ok(pdf.textPreview.length <= 200);
  assert.equal(pdf.text, undefined);
  assert.equal(pdf.validation.validatedBy, 'Gilles');
  assert.deepEqual(body.validators.sort(), ['Camille', 'Gilles', 'Inès']);
});

test('/api/validated : filtres et pagination', async () => {
  const total = async (qs: string) => (await get(`/api/validated?${qs}`)).body.total;
  assert.equal(await total('q=tweed'), 1); // texte extrait
  assert.equal(await total('q=TWEED'), 1); // insensible à la casse
  assert.equal(await total('q=rapport%20T3'), 1); // notes
  assert.equal(await total('q=100%25'), 0); // % échappé
  assert.equal(await total('category=themes&tag=Mode'), 2);
  assert.equal(await total('tag=Montre%20J12'), 1); // sans catégorie
  assert.equal(await total('category=products&tag=Sac%202.55'), 1);
  assert.equal(await total('validatedBy=gilles'), 1); // insensible à la casse
  assert.equal(await total('to=2026-01-15'), 1); // journée incluse
  assert.equal(await total('from=2026-01-16'), 2);
  assert.equal(await total('category=themes&tag=Mode&validatedBy=Camille'), 1); // combinés

  const p1 = (await get('/api/validated?limit=2&offset=0')).body;
  const p2 = (await get('/api/validated?limit=2&offset=2')).body;
  assert.equal(p1.items.length, 2);
  assert.equal(p2.items.length, 1);
  assert.equal(p1.total, 3);
});

test('/api/validated : paramètres invalides → 400', async () => {
  for (const qs of ['limit=0', 'limit=101', 'limit=abc', 'offset=-1', 'category=couleurs', 'tag=Inconnu', 'category=regions&tag=Mode', 'from=hier']) {
    const r = await get(`/api/validated?${qs}`);
    assert.equal(r.status, 400, qs);
    assert.equal(r.body.success, false);
  }
});

test('fiche : historique, diff des tags, texte .txt', async () => {
  const { body: doc } = await get(`/api/documents/${ids.pdf}`);
  assert.equal(doc.status, 'validated');
  assert.equal(doc.validations.length, 1);
  assert.ok(doc.tagDiff.themes.kept.includes('Mode'));
  assert.ok(doc.tagDiff.sources.kept.includes('Magazine Papier'));
  assert.ok(doc.tagDiff.regions.removed.length >= 1); // AMER/APAC proposés puis retirés
  assert.ok(Array.isArray(doc.images) && doc.images.length >= 1);

  const txt = await get(`/api/documents/${ids.pdf}/text`);
  assert.equal(txt.status, 200);
  assert.match(txt.headers.get('content-type')!, /text\/plain/);
  assert.match(txt.headers.get('content-disposition')!, /sample-fashion\.txt/);
  assert.match(txt.body, /--- Page 1 ---/);
});

test('vignette générée puis réutilisée', async () => {
  const { body: doc } = await get(`/api/documents/${ids.pdf}`);
  const img = doc.images[0];
  const r1 = await fetch(`${base}/api/documents/${ids.pdf}/images/${img.imageId}?size=thumb`);
  assert.equal(r1.status, 200);
  const thumb = path.join(TMP, 'images', ids.pdf, 'thumbs', `${img.imageId}.png`);
  assert.ok(fs.existsSync(thumb));
  const mtime = fs.statSync(thumb).mtimeMs;
  const r2 = await fetch(`${base}/api/documents/${ids.pdf}/images/${img.imageId}?size=thumb`);
  assert.equal(r2.status, 200);
  assert.equal(fs.statSync(thumb).mtimeMs, mtime);
  const { default: sharp } = await import('sharp');
  const small = await sharp(Buffer.from(await r2.arrayBuffer())).metadata();
  assert.equal(small.width, 320);
  assert.ok(img.width > 320);
});

test('identifiants invalides → 400, inconnus → 404', async () => {
  assert.equal((await get('/api/documents/abc')).status, 400);
  assert.equal((await get('/api/documents/..%2F..%2Fetc')).status, 400);
  assert.equal((await get('/api/documents/00000000-0000-4000-8000-00000000ffff')).status, 404);
  assert.equal((await get(`/api/documents/${ids.pdf}/images/not-a-uuid`)).status, 400);
  assert.equal((await get(`/api/documents/${ids.pdf}/text`)).status, 200);
});

test('remise en attente : statut, historique, tags pré-cochés, 409', async () => {
  assert.equal((await post(`/api/documents/${ids.docx}/reopen`, { by: 'Gilles' })).status, 400); // motif manquant
  const r = await post(`/api/documents/${ids.docx}/reopen`, { by: 'Gilles', reason: 'Mauvaise source' });
  assert.equal(r.status, 200);
  assert.equal(r.body.event.action, 'reopen');

  assert.equal((await post(`/api/documents/${ids.docx}/reopen`, { by: 'Gilles', reason: 'bis' })).status, 409); // déjà en attente

  const pending = (await get('/api/validations/pending')).body;
  const p = pending.find((d: { documentId: string }) => d.documentId === ids.docx);
  assert.ok(p, 'réapparaît dans À valider');
  assert.equal(p.reopened.by, 'Gilles');
  assert.deepEqual(p.preselected.products, ['Montre J12']); // derniers tags validés

  const { body: doc } = await get(`/api/documents/${ids.docx}`);
  assert.equal(doc.status, 'pending');
  assert.deepEqual(doc.validations.map((e: { action: string }) => e.action), ['reopen', 'validate']);
  assert.equal((await get('/api/validated')).body.total, 2);

  // revalidation : la liste reprend la nouvelle validation
  await validate(ids.docx, { sources: ['Magazine Online'], themes: ['Horlogerie'] }, 'Hugo');
  const list = (await get('/api/validated')).body;
  assert.equal(list.total, 3);
  assert.equal(list.items[0].validation.validatedBy, 'Hugo');
  assert.equal((await get(`/api/documents/${ids.docx}`)).body.validations.length, 3);
});

test('export CSV filtré', async () => {
  const r = await fetch(`${base}/api/export?format=csv&category=themes&tag=Mode`);
  const csv = await r.text();
  assert.equal(csv.trim().split('\n').length, 1 + 2); // en-tête + 2 docs "Mode"
});

test('garde-fou XSS : aucun innerHTML dans le JavaScript de l’UI', () => {
  const dir = path.join(ROOT, 'public', 'js');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/.test(src), `${f} : insertion HTML interdite`);
  }
});
