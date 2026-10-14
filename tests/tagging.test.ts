import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, tagByKeywords, validatePlainTags } from '../src/services/tagging.js';

const ctx = (kind: 'pdf' | 'docx' | 'image') => ({ kind, metadata: { fileSize: 1, mimeType: '', warnings: [] } });
const values = (r: ReturnType<typeof tagByKeywords>, c: keyof typeof r.tags) => r.tags[c].map((t) => t.value);

test('normalize : minuscules, sans accents', () => {
  assert.equal(normalize('Défilé  Haute-Couture À PARIS'), 'defile haute-couture a paris');
});

test('tagging : article mode parisien', () => {
  const r = tagByKeywords('Le défilé haute couture à Paris : une robe en tweed et le sac 2.55.', ctx('pdf'));
  assert.ok(values(r, 'themes').includes('Mode'));
  assert.ok(values(r, 'regions').includes('EMEA'));
  assert.ok(values(r, 'products').includes('Robe'));
  assert.ok(values(r, 'products').includes('Sac 2.55'));
  assert.ok(values(r, 'sources').includes('Magazine Papier')); // signal de contexte PDF
});

test('tagging : post Instagram parfum', () => {
  const r = tagByKeywords('Instagram\n12 458 J\'aime\nLe parfum Chanel N°5 #chanel #parfum', ctx('image'));
  assert.equal(r.tags.sources[0].value, 'Instagram');
  assert.ok(values(r, 'themes').includes('Parfum & Beauté'));
  assert.ok(values(r, 'products').includes('Chanel N°5'));
  assert.ok(!values(r, 'sources').includes('Magazine Papier'), 'N°5 ne doit pas être lu comme un numéro de magazine');
});

test('tagging : frontières de mot (pas de faux positifs)', () => {
  const r = tagByKeywords('Un plateau, un tableau et un dressing réel.', ctx('docx'));
  assert.ok(!values(r, 'regions').length, 'aucune région');
  assert.ok(!values(r, 'sources').includes('Instagram'), '"réel" ≠ reel Instagram');
});

test('tagging : texte vide → source "Autre", revue manuelle', () => {
  const r = tagByKeywords('', ctx('docx'));
  assert.deepEqual(values(r, 'sources'), ['Autre']);
  assert.equal(r.requiresManualReview, true);
  assert.ok(r.reviewReasons.length > 0);
});

test('tagging : confiances bornées 0..1 et triées', () => {
  const r = tagByKeywords('montre montre montre watch chronographe J12 '.repeat(20), ctx('pdf'));
  for (const list of Object.values(r.tags)) {
    for (const t of list) assert.ok(t.confidence >= 0 && t.confidence <= 1);
    for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].confidence >= list[i].confidence);
  }
  assert.equal(r.tags.themes[0].value, 'Horlogerie');
});

test('validation : refuse les valeurs hors listes fermées', () => {
  const r = validatePlainTags({ sources: ['Instagram'], regions: ['Mars'], themes: ['Mode'], products: [] });
  assert.equal(r.ok, false);
});

test('validation : sources et thèmes obligatoires', () => {
  assert.equal(validatePlainTags({ sources: [], regions: [], themes: ['Mode'], products: [] }).ok, false);
  assert.equal(validatePlainTags({ sources: ['Blog'], regions: [], themes: [], products: [] }).ok, false);
  const ok = validatePlainTags({ sources: ['Blog', 'Blog'], themes: ['Mode'] });
  assert.ok(ok.ok && ok.tags.sources.length === 1 && ok.tags.regions.length === 0);
});

test('OCR : nettoyage des lignes bruit', async () => {
  const { cleanOcrText } = await import('../src/services/ocr.js');
  const out = cleanOcrText(">» è = 4 >\nai . i, v - 3\nCampagne Chanel Automne-Hiver 2026.\n12 458 J'aime\n#chanel #parfum");
  assert.equal(out, "Campagne Chanel Automne-Hiver 2026.\n12 458 J'aime\n#chanel #parfum");
});
