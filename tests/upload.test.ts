/**
 * Upload dans data/input : assainissement des noms, contrôles, conflits,
 * protection Origin/Host, file de scan unique (pas de double scan).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-scanner-upload-'));
const INPUT = path.join(TMP, 'input');
process.env.DATA_DIR = TMP;
process.env.INPUT_DIR = INPUT;
process.env.OLLAMA_MODE = 'off';
process.env.MAX_FILE_SIZE_MB = '1';

const { sanitizeFilename, suffixedName } = await import('../src/services/upload.js');
const { enqueue } = await import('../src/services/scanQueue.js');
const storage = await import('../src/services/storage.js');
const { createApp } = await import('../src/app.js');

const PDF = fs.readFileSync(path.join(ROOT, 'samples', 'sample-fashion.pdf'));
const DOCX = fs.readFileSync(path.join(ROOT, 'samples', 'sample-report.docx'));
let server: Server;
let base = '';
let port = 0;

/* eslint-disable @typescript-eslint/no-explicit-any */
async function upload(filename: string, body: Buffer | string, headers: Record<string, string> = {}, scan = true): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}/api/upload?filename=${encodeURIComponent(filename)}&scan=${scan ? 1 : 0}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...headers },
    body,
  });
  return { status: r.status, body: await r.json() };
}
const inputFiles = () => fs.readdirSync(INPUT).sort();
const docCount = () => (storage.getDb().prepare(`SELECT COUNT(*) AS n FROM documents WHERE status != 'error'`).get() as { n: number }).n;

before(async () => {
  fs.mkdirSync(INPUT, { recursive: true });
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  server?.close();
  storage.closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('assainissement des noms de fichier', () => {
  assert.equal(sanitizeFilename('../../.ssh/rapport.pdf'), 'rapport.pdf');
  assert.equal(sanitizeFilename('..\\..\\windows\\a.pdf'), 'a.pdf');
  assert.equal(sanitizeFilename('con\u0000tr\u001fole.pdf'), 'controle.pdf');
  assert.equal(sanitizeFilename('a:b*c?"<>|.png'), 'abc.png');
  assert.equal(sanitizeFilename('...cache.pdf'), 'cache.pdf');
  assert.equal(sanitizeFilename('rapport.PDF'), 'rapport.PDF');
  assert.equal(sanitizeFilename('Résumé.pdf'), 'Résumé.pdf'); // NFD → NFC
  assert.equal(sanitizeFilename('Résumé.pdf').length, 'Résumé.pdf'.length);
  const long = sanitizeFilename(`${'x'.repeat(300)}.pdf`);
  assert.equal(long.length, 150);
  assert.ok(long.endsWith('.pdf'));
  assert.throws(() => sanitizeFilename('.htaccess'), (e: any) => e.code === 'UNSUPPORTED_FORMAT');
  assert.throws(() => sanitizeFilename('notes.txt'), (e: any) => e.status === 415);
  assert.throws(() => sanitizeFilename('.pdf'), (e: any) => e.code === 'UNSUPPORTED_FORMAT' || e.code === 'BAD_FILENAME');
  assert.throws(() => sanitizeFilename(''), (e: any) => e.code === 'BAD_FILENAME');
  assert.throws(() => sanitizeFilename(['a.pdf']), (e: any) => e.code === 'BAD_FILENAME');
  assert.equal(suffixedName('nom.pdf', 2), 'nom (2).pdf');
});

test('upload d’un PDF valide : enregistré, scanné, document créé', async () => {
  const r = await upload('Article mode.pdf', PDF);
  assert.equal(r.status, 201);
  assert.equal(r.body.file.savedAs, 'Article mode.pdf');
  assert.equal(r.body.duplicate, false);
  assert.ok(r.body.documentId);
  assert.equal(r.body.scan.extraction.text, ''); // texte complet non renvoyé
  assert.deepEqual(inputFiles(), ['Article mode.pdf']);
  assert.equal(storage.getDocument(r.body.documentId)?.status, 'pending');
});

test('même fichier renvoyé → doublon, aucune copie, un seul document', async () => {
  const r = await upload('Article mode.pdf', PDF);
  assert.equal(r.status, 200);
  assert.equal(r.body.duplicate, true);
  assert.deepEqual(inputFiles(), ['Article mode.pdf']);
  assert.equal(docCount(), 1);
});

test('même nom, contenu différent → suffixe (2), jamais d’écrasement', async () => {
  const r = await upload('Article mode.pdf', Buffer.concat([PDF, Buffer.from('\n%v2')]), {}, false);
  assert.equal(r.status, 201);
  assert.equal(r.body.file.savedAs, 'Article mode (2).pdf');
  assert.equal(r.body.scan, null);
  assert.equal(fs.readFileSync(path.join(INPUT, 'Article mode.pdf')).length, PDF.length); // original intact
});

test('refus : format, faux contenu, vide, trop gros — aucun fichier laissé', async () => {
  const before = inputFiles();
  assert.equal((await upload('notes.txt', 'hello')).status, 415);
  assert.equal((await upload('faux.pdf', 'pas un pdf')).body.code, 'CORRUPTED_FILE');
  assert.equal((await upload('faux.docx', 'pas un zip')).status, 422);
  assert.equal((await upload('image.png', Buffer.from('PNG mais non'))).status, 422);
  assert.equal((await upload('vide.pdf', '')).body.code, 'EMPTY_FILE');
  const big = Buffer.concat([PDF, Buffer.alloc(1_200_000)]);
  const r = await upload('gros.pdf', big).catch(() => ({ status: 413, body: {} })); // la connexion peut être coupée
  assert.equal(r.status, 413);
  await new Promise((res) => setTimeout(res, 100));
  assert.deepEqual(inputFiles(), before); // ni fichier final, ni .part résiduel
});

test('Content-Type autre que octet-stream → 415', async () => {
  const r = await fetch(`${base}/api/upload?filename=a.pdf`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 415);
});

test('autre origine ou autre hôte → 403 (toutes les routes POST)', async () => {
  assert.equal((await upload('x.pdf', PDF, { Origin: 'https://evil.example' })).body.code, 'CROSS_ORIGIN');
  const scan = await fetch(`${base}/api/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{"filePath":"Article mode.pdf"}' });
  assert.equal(scan.status, 403);
  const save = await fetch(`${base}/api/validations/save`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' }, body: '{}' });
  assert.equal(save.status, 403);
  // même origine : accepté
  assert.equal((await upload('docx-ok.docx', DOCX, { Origin: `http://127.0.0.1:${port}` }, false)).status, 201);
  // DNS rebinding : Host étranger refusé, y compris en GET
  const http = await import('node:http');
  const status = await new Promise<number>((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/api/health', headers: { Host: `evil.example:${port}` } }, (res) => { res.resume(); resolve(res.statusCode!); });
  });
  assert.equal(status, 403);
});

test('file unique : scans simultanés du même fichier → un seul document', async () => {
  fs.writeFileSync(path.join(INPUT, 'rapport.docx'), DOCX);
  const before = docCount();
  const [a, b, c] = await Promise.all([
    enqueue('rapport.docx', { source: 'api' }),
    enqueue('rapport.docx', { source: 'watcher' }),
    enqueue('rapport.docx', { source: 'upload' }),
  ]);
  assert.equal(a.documentId, b.documentId);
  assert.equal(b.documentId, c.documentId);
  assert.equal(docCount(), before + 1);
  // la surveillance qui détecte le fichier juste après réutilise le résultat
  const d = await enqueue('rapport.docx', { source: 'watcher' });
  assert.equal(d.documentId, a.documentId);
  assert.equal(docCount(), before + 1);
});

test('GET /api/input : statuts des fichiers', async () => {
  fs.writeFileSync(path.join(INPUT, 'lisez-moi.txt'), 'x');
  const r: any = await (await fetch(`${base}/api/input`)).json();
  const by = Object.fromEntries(r.items.map((i: any) => [i.name, i]));
  assert.equal(by['Article mode.pdf'].status, 'pending');
  assert.ok(by['Article mode.pdf'].documentId);
  assert.equal(by['Article mode (2).pdf'].status, 'new'); // envoyé avec scan=0
  assert.equal(by['lisez-moi.txt'].status, 'unsupported');
  assert.ok(!r.items.some((i: any) => i.name.startsWith('.')));
});
