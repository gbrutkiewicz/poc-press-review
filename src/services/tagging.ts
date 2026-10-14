import { config } from '../config/env.js';
import { CATEGORY_RULES, KEYWORDS, TAG_LISTS, type TagCategory } from '../config/tags.js';
import type { ExtractionResult, PlainTags, TagDiff, TaggingResult, TagScore, TagSet } from '../types/document.js';
import { log } from '../utils/logger.js';

export const CATEGORIES: TagCategory[] = ['sources', 'regions', 'themes', 'products'];

/** minuscules, sans accents, apostrophes/espaces homogènes. */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/\s+/g, ' ');
}

// Compilation unique des patterns, bornés par des frontières de "mot".
// (\b ne marche pas avec @, #, ° → lookarounds explicites)
const compiled = new Map<string, RegExp>();
function rx(pattern: string): RegExp {
  let r = compiled.get(pattern);
  if (!r) {
    r = new RegExp(`(?<![a-z0-9])(?:${pattern})(?![a-z0-9])`, 'g');
    compiled.set(pattern, r);
  }
  r.lastIndex = 0;
  return r;
}

const toConfidence = (raw: number) => Math.round((1 - Math.exp(-raw)) * 100) / 100;

interface Accumulator {
  raw: number;
  matches: Set<string>;
}

/** Score brut par tag pour une catégorie. */
function scoreCategory(category: TagCategory, normText: string): Map<string, Accumulator> {
  const out = new Map<string, Accumulator>();
  for (const [tag, rules] of Object.entries(KEYWORDS[category])) {
    for (const { pattern, weight } of rules) {
      const found = normText.match(rx(pattern));
      if (!found?.length) continue;
      const acc = out.get(tag) ?? { raw: 0, matches: new Set<string>() };
      // Rendement décroissant : 1 occurrence = poids, 10 occurrences ≈ 3.3 × poids
      acc.raw += weight * (1 + Math.log(found.length));
      for (const f of found.slice(0, 5)) acc.matches.add(f);
      out.set(tag, acc);
    }
  }
  return out;
}

/**
 * Signaux de contexte (indépendants du texte) : le type de fichier dit
 * quelque chose de la source. Poids faibles : ils départagent, ne décident pas.
 */
function contextSignals(extraction: Pick<ExtractionResult, 'kind' | 'metadata'>, filename: string): Partial<Record<string, number>> {
  const f = normalize(filename);
  const s: Partial<Record<string, number>> = {};
  if (extraction.kind === 'pdf') s['Magazine Papier'] = 0.75; // revue de presse print = PDF dans la grande majorité des cas
  if (extraction.kind === 'image') {
    s['Magazine Online'] = 0.25;
    s['Instagram'] = 0.25;
  }
  if (/insta|ig[_-]/.test(f)) s['Instagram'] = (s['Instagram'] ?? 0) + 0.5;
  if (/screenshot|capture/.test(f)) s['Magazine Online'] = (s['Magazine Online'] ?? 0) + 0.25;
  return s;
}

export function tagByKeywords(
  text: string,
  extraction: Pick<ExtractionResult, 'kind' | 'metadata'>,
  filename = '',
): TaggingResult {
  // Les marqueurs "--- Page N ---" ajoutés par l'extraction ne doivent pas compter
  const body = text.replace(/^--- Page \d+[^\n]*---$/gm, '');
  const normText = normalize(`${filename.replace(/[_.-]+/g, ' ')}\n${body}`);
  const tags = {} as TagSet;

  for (const category of CATEGORIES) {
    const scores = scoreCategory(category, normText);
    if (category === 'sources') {
      for (const [tag, w] of Object.entries(contextSignals(extraction, filename))) {
        const acc = scores.get(tag) ?? { raw: 0, matches: new Set<string>() };
        acc.raw += w!;
        acc.matches.add(`[contexte:${extraction.kind}]`);
        scores.set(tag, acc);
      }
    }
    tags[category] = [...scores.entries()]
      .map(([value, acc]): TagScore => ({
        value,
        confidence: toConfidence(acc.raw),
        matches: [...acc.matches],
        origin: [...acc.matches].every((m) => m.startsWith('[contexte')) ? 'context' : 'keywords',
      }))
      .filter((t) => t.confidence >= config.minTagScore)
      .sort((a, b) => b.confidence - a.confidence);
  }

  return finalize(tags, 'keywords');
}

/** Applique les règles de cardinalité, calcule la confiance globale et le flag de revue. */
function finalize(tags: TagSet, engine: TaggingResult['engine']): TaggingResult {
  const reasons: string[] = [];

  // Source obligatoire → "Autre" par défaut
  if (tags.sources.length === 0) {
    tags.sources.push({ value: 'Autre', confidence: 0, matches: [], origin: 'fallback' });
    reasons.push('Aucune source détectée (défaut : Autre)');
  }
  if (tags.themes.length === 0) reasons.push('Aucun thème détecté');

  // Confiance globale : moyenne des meilleurs scores des catégories obligatoires
  // (+ régions si présentes). Les produits sont optionnels et n'entrent pas en compte.
  const tops = [tags.sources[0]?.confidence ?? 0, tags.themes[0]?.confidence ?? 0];
  if (tags.regions.length) tops.push(tags.regions[0].confidence);
  const confidence = Math.round((tops.reduce((a, b) => a + b, 0) / tops.length) * 100) / 100;

  for (const category of ['sources', 'themes'] as const) {
    const top = tags[category][0];
    if (top && top.confidence < config.reviewThreshold) {
      reasons.push(`${CATEGORY_RULES[category].label} : confiance ${top.confidence} < ${config.reviewThreshold}`);
    }
  }
  if (confidence < config.reviewThreshold) reasons.push(`Confiance globale ${confidence} < ${config.reviewThreshold}`);

  return { tags, confidence, requiresManualReview: reasons.length > 0, reviewReasons: reasons, engine };
}

/* ------------------------------------------------------- Ollama (option) -- */

let ollamaAvailable: boolean | null = null;
let ollamaCheckedAt = 0;

function assertLoopback(url: string): void {
  const host = new URL(url).hostname;
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    throw new Error(`OLLAMA_URL doit pointer sur la machine locale (reçu : ${host})`);
  }
}

export async function isOllamaAvailable(): Promise<boolean> {
  if (config.ollama.mode === 'off') return false;
  // cache 60 s pour ne pas sonder à chaque document
  if (ollamaAvailable !== null && Date.now() - ollamaCheckedAt < 60_000) return ollamaAvailable;
  try {
    assertLoopback(config.ollama.url);
    const res = await fetch(`${config.ollama.url}/api/tags`, { signal: AbortSignal.timeout(1500) });
    const body = (await res.json()) as { models?: { name: string }[] };
    ollamaAvailable = res.ok && !!body.models?.some((m) => m.name.split(':')[0] === config.ollama.model.split(':')[0]);
    if (res.ok && !ollamaAvailable) log.warn(`Ollama joignable mais modèle "${config.ollama.model}" absent (ollama pull ${config.ollama.model})`);
  } catch {
    ollamaAvailable = false;
  }
  ollamaCheckedAt = Date.now();
  return ollamaAvailable;
}

function buildPrompt(text: string): string {
  const lists = CATEGORIES.map((c) => `- ${c}: ${JSON.stringify(TAG_LISTS[c])}`).join('\n');
  return `Tu es un assistant de revue de presse pour une maison de luxe.
Classe le document ci-dessous en choisissant UNIQUEMENT des valeurs dans ces listes fermées :
${lists}

Règles : au moins 1 valeur pour "sources" et "themes" ; "regions" et "products" peuvent être vides.
Réponds UNIQUEMENT avec un objet JSON de la forme {"sources":[],"regions":[],"themes":[],"products":[]}.

DOCUMENT :
"""
${text.slice(0, 6000)}
"""`;
}

async function askOllama(text: string): Promise<PlainTags | null> {
  assertLoopback(config.ollama.url);
  const res = await fetch(`${config.ollama.url}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.ollama.model, prompt: buildPrompt(text), format: 'json', stream: false, options: { temperature: 0 } }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { response } = (await res.json()) as { response: string };
  const parsed = JSON.parse(response) as Partial<Record<TagCategory, unknown>>;
  // On ne garde que les valeurs des listes fermées (le LLM peut halluciner)
  const out = {} as PlainTags;
  for (const c of CATEGORIES) {
    const arr = Array.isArray(parsed[c]) ? (parsed[c] as unknown[]) : [];
    out[c] = [...new Set(arr.filter((v): v is string => typeof v === 'string' && TAG_LISTS[c].includes(v)))];
  }
  return out;
}

/** Fusion : accord keywords+LLM → bonus ; tag proposé par le LLM seul → confiance 0.5. */
function merge(base: TaggingResult, llm: PlainTags): TaggingResult {
  const tags = structuredClone(base.tags);
  for (const c of CATEGORIES) {
    // retire le fallback "Autre" si le LLM propose une vraie source
    if (c === 'sources' && llm.sources.length) tags.sources = tags.sources.filter((t) => t.origin !== 'fallback');
    for (const value of llm[c]) {
      const existing = tags[c].find((t) => t.value === value);
      if (existing) {
        existing.confidence = Math.min(1, Math.round((existing.confidence + 0.25) * 100) / 100);
        existing.origin = 'keywords+ollama';
      } else {
        tags[c].push({ value, confidence: 0.5, matches: [], origin: 'ollama' });
      }
    }
    tags[c].sort((a, b) => b.confidence - a.confidence);
  }
  return finalize(tags, 'keywords+ollama');
}

/**
 * Point d'entrée : keywords d'abord ; Ollama seulement en renfort
 * (mode auto : si revue manuelle requise ; mode always : toujours).
 * Toute erreur Ollama → résultat keywords conservé (dégradation gracieuse).
 */
export async function tagDocument(
  text: string,
  extraction: Pick<ExtractionResult, 'kind' | 'metadata'>,
  filename = '',
): Promise<TaggingResult> {
  const base = tagByKeywords(text, extraction, filename);
  const { mode } = config.ollama;
  if (mode === 'off' || (mode === 'auto' && !base.requiresManualReview) || !text.trim()) return base;
  if (!(await isOllamaAvailable())) return base;
  try {
    log.info(`🤖 Ollama (${config.ollama.model}) en renfort du tagging…`);
    const llm = await askOllama(text);
    return llm ? merge(base, llm) : base;
  } catch (err) {
    log.warn(`Ollama indisponible, tagging keywords conservé (${(err as Error).message})`);
    return base;
  }
}

/** Contrôle d'une proposition de tags (validation humaine). */
export function validatePlainTags(input: unknown): { ok: true; tags: PlainTags } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const tags = {} as PlainTags;
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  for (const c of CATEGORIES) {
    const raw = obj[c] ?? [];
    if (!Array.isArray(raw)) {
      errors.push(`"${c}" doit être un tableau`);
      continue;
    }
    const invalid = raw.filter((v) => typeof v !== 'string' || !TAG_LISTS[c].includes(v));
    if (invalid.length) errors.push(`${CATEGORY_RULES[c].label} : valeur(s) hors liste fermée ${JSON.stringify(invalid)}`);
    tags[c] = [...new Set(raw.filter((v): v is string => typeof v === 'string' && TAG_LISTS[c].includes(v)))];
    if (tags[c].length < CATEGORY_RULES[c].min) errors.push(`${CATEGORY_RULES[c].label} : au moins ${CATEGORY_RULES[c].min} valeur requise`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, tags };
}

/**
 * Tags pré-cochés dans l'UI : meilleure proposition de chaque catégorie, plus
 * toute proposition ≥ 0.5. Règle unique, utilisée par l'écran de validation
 * ET par la comparaison automatique ↔ validé.
 */
export function preselectedTags(tagging: TaggingResult | null): PlainTags {
  const out = {} as PlainTags;
  for (const c of CATEGORIES) {
    const list = tagging?.tags[c] ?? [];
    out[c] = list.filter((t, i) => i === 0 || t.confidence >= 0.5).map((t) => t.value);
  }
  return out;
}

/** Diff entre la proposition pré-cochée et les tags validés par l'humain. */
export function computeTagDiff(tagging: TaggingResult | null, validated: PlainTags): TagDiff {
  const auto = preselectedTags(tagging);
  const out = {} as TagDiff;
  for (const c of CATEGORIES) {
    const a = new Set(auto[c]);
    const v = new Set(validated[c] ?? []);
    out[c] = {
      kept: [...v].filter((x) => a.has(x)),
      added: [...v].filter((x) => !a.has(x)),
      removed: [...a].filter((x) => !v.has(x)),
    };
  }
  return out;
}
