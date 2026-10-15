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

test('OCR : débris de photo retirés en début et fin de ligne', async () => {
  const { cleanLine } = await import('../src/services/ocr.js');
  // ligne de 30 px de haut ; mots = [texte, confiance, x0, x1]
  const line = (...words: [string, number, number, number][]) => ({
    bbox: { x0: 0, y0: 0, x1: 2000, y1: 30 },
    words: words.map(([text, confidence, x0, x1]) => ({ text, confidence, bbox: { x0, y0: 0, x1, y1: 30 } })),
  });
  // débris séparés par un grand écart (> 2 × hauteur), confiance basse
  assert.equal(
    cleanLine(line(['A', 40, 10, 30], ['Ce', 35, 60, 100], ['haute', 95, 400, 480], ['joaillerie', 94, 490, 620], ['chargé', 93, 630, 720])),
    'haute joaillerie chargé',
  );
  // débris en fin de ligne, collés au texte : retirés par la confiance de bord
  assert.equal(
    cleanLine(line(['Céline', 95, 10, 100], ['Dion', 94, 110, 170], ['g', 20, 180, 190], ['FN', 30, 200, 240])),
    'Céline Dion',
  );
  // groupe parasite de caractères isolés, même avec une bonne confiance
  assert.equal(cleanLine(line(['/', 85, 10, 20], ['A', 90, 30, 45], ['Un', 93, 400, 430], ['appartement', 91, 440, 600])), 'Un appartement');
  // symbole isolé en bord de ligne ; les guillemets français sont conservés
  assert.equal(cleanLine(line(['’', 80, 380, 388], ['Un', 93, 400, 430], ['salon', 91, 440, 520])), 'Un salon');
  assert.equal(cleanLine(line(['«', 90, 380, 395], ['Un', 93, 400, 430], ['salon', 91, 440, 520], ['»', 90, 525, 540])), '« Un salon »');
  // un mot réel peu sûr au milieu d'une phrase est gardé
  assert.equal(cleanLine(line(['souvent', 96, 10, 90], ['imposée', 23, 100, 180], ['aux', 96, 190, 220])), 'souvent imposée aux');
});
