/**
 * LISTES FERMÉES + règles de matching par mots-clés.
 *
 * - Les valeurs (`SOURCES`, `REGIONS`, `THEMES`, `PRODUCTS`) sont les seules
 *   acceptées par le tagging ET par la validation humaine.
 * - Les patterns sont appliqués sur un texte normalisé : minuscules, sans
 *   accents (é → e), espaces compactés. Écrire donc les patterns SANS accent.
 * - Chaque pattern est borné par des frontières de mot (pas de match de "la"
 *   dans "plateau"). Pour un match partiel, terminer le pattern par `\w*`.
 * - Poids : 1 = signal fort, 0.5 = moyen, 0.25 = faible.
 *   Confiance d'un tag = 1 - exp(-Σ poids × (1 + ln(occurrences)))
 *   → 1 signal fort ≈ 0.63 ; 1 moyen ≈ 0.39 ; 1 faible ≈ 0.22.
 */

export const SOURCES = [
  'Instagram',
  'Magazine Papier',
  'Magazine Online',
  'Blog',
  'Réseaux Sociaux',
  'Événement',
  'Autre',
] as const;

export const REGIONS = ['AMER', 'EMEA', 'APAC', 'Global'] as const;

export const THEMES = [
  'Horlogerie',
  'Parfum & Beauté',
  'Mode',
  'Eyewear',
  'Joaillerie',
  'Maroquinerie',
  'Lifestyle',
] as const;

// TODO(Mazarine) : compléter avec la liste produits définitive.
export const PRODUCTS = [
  'Robe',
  'Sac 2.55',
  'Sac Grand Shopping',
  'Chanel N°5',
  'Chanel Coco Mademoiselle',
  'Montre J12',
  'Lunettes de Soleil',
  'Sac 19',
  'Costume',
  'Chemise',
  'Chaussures',
] as const;

export type Source = (typeof SOURCES)[number];
export type Region = (typeof REGIONS)[number];
export type Theme = (typeof THEMES)[number];
export type Product = (typeof PRODUCTS)[number];

export type TagCategory = 'sources' | 'regions' | 'themes' | 'products';

export const TAG_LISTS: Record<TagCategory, readonly string[]> = {
  sources: SOURCES,
  regions: REGIONS,
  themes: THEMES,
  products: PRODUCTS,
};

/** Contraintes de cardinalité (cf. cahier des charges). */
export const CATEGORY_RULES: Record<TagCategory, { min: number; label: string }> = {
  sources: { min: 1, label: 'Sources' },
  regions: { min: 0, label: 'Régions' },
  themes: { min: 1, label: 'Thèmes' },
  products: { min: 0, label: 'Produits' },
};

export interface KeywordRule {
  pattern: string;
  weight: number;
}

const S = 1; // fort
const M = 0.5; // moyen
const W = 0.25; // faible

export const KEYWORDS: Record<TagCategory, Record<string, KeywordRule[]>> = {
  sources: {
    Instagram: [
      { pattern: 'instagram|insta|ig', weight: S },
      { pattern: 'stories|story|reels? instagram|instagram reels?', weight: M },
      { pattern: 'j ?aime|likes?|abonnes|followers|publication sponsorisee', weight: M },
      // handle (@xxx) et hashtag (#xxx) — signaux faibles, aussi présents ailleurs
      { pattern: '@[a-z0-9_.]{2,}', weight: W },
      { pattern: '#[a-z0-9_]{2,}', weight: W },
    ],
    'Magazine Papier': [
      { pattern: 'magazine papier|edition papier|version papier|print', weight: S },
      { pattern: 'en kiosque|numero \\d{2,4}|n° ?\\d{2,4}|mensuel|hebdomadaire|trimestriel', weight: M },
      { pattern: 'abonnement|rubrique|idee recue|redaction', weight: W },
    ],
    'Magazine Online': [
      { pattern: 'magazine online|magazine en ligne|webzine', weight: S },
      { pattern: 'en ligne|online|lire aussi|newsletter|photo gracieusete', weight: M },
      // URLs : faible, car aussi citées dans la presse papier
      { pattern: 'web|site|article|redact(eur|rice) en chef|revue|https?://\\S+|www\\.\\S+', weight: W },
    ],
    Blog: [
      { pattern: 'blog|blogueu(r|se)|blogger|billet', weight: S },
      { pattern: 'mon avis|ma selection|coup de coeur', weight: W },
    ],
    'Réseaux Sociaux': [
      { pattern: 'tiktok|facebook|twitter|linkedin|youtube|pinterest|snapchat|threads', weight: S },
      { pattern: 'reseaux sociaux|social media|influenceu(r|se)|viral\\w*|partages?', weight: M },
    ],
    'Événement': [
      { pattern: 'evenement|vernissage|gala|cocktail|soiree de lancement|press day|avant-premiere', weight: S },
      { pattern: 'defile|soiree|lancement|exposition|inauguration|ceremonie|front row', weight: M },
    ],
    Autre: [
      { pattern: 'rapport|document interne|note interne|diffusion restreinte|communique de presse|dossier de presse', weight: M },
    ],
  },
  regions: {
    AMER: [
      { pattern: 'usa|etats-unis|united states|new york|los angeles|miami|canada|toronto|montreal|mexique|mexico|bresil|amerique\\w*', weight: S },
      { pattern: 'beverly hills|hollywood|chicago|san francisco', weight: M },
    ],
    EMEA: [
      { pattern: 'france|paris|europe|london|londres|milan|italie|allemagne|espagne|suisse|geneve|monaco|dubai|moyen-orient|afrique', weight: S },
      { pattern: 'rue cambon|place vendome|avenue montaigne|cote d.azur|deauville|saint-tropez|cannes', weight: S },
      { pattern: 'francais\\w*|europeen\\w*|parisien\\w*', weight: M },
    ],
    APAC: [
      { pattern: 'china|chine|asia|asie|japan|japon|tokyo|hong kong|shanghai|pekin|seoul|coree|singapour|australie|sydney|inde', weight: S },
      { pattern: 'asiatique\\w*|japonais\\w*|chinois\\w*', weight: M },
    ],
    Global: [
      { pattern: 'global|worldwide|monde entier|mondial\\w*|international\\w*', weight: S },
    ],
  },
  themes: {
    Horlogerie: [
      { pattern: 'montres?|watch(es)?|chronographe|horlog\\w*|calibre|tourbillon|cadran', weight: S },
      { pattern: 'j12', weight: W },
    ],
    'Parfum & Beauté': [
      { pattern: 'parfums?|fragrances?|beaute|cosmetiques?|maquillage|make-?up|eau de (parfum|toilette)', weight: S },
      { pattern: 'rouge a levres|vernis|soins?|skincare|mascara|fond de teint|senteur|flacon', weight: M },
    ],
    Mode: [
      { pattern: 'mode|fashion|haute couture|pret-a-porter|defile|runway', weight: S },
      { pattern: 'collections?|createur|directeur artistique|directrice artistique', weight: M },
      { pattern: 'robes?|tweed|tailleur|silhouette|manteaux?|vetements?|dressing|couture|look', weight: M },
      { pattern: 'veste|jupe|chemise|maille|dentelle|automne-hiver|printemps-ete|croisiere', weight: W },
    ],
    Eyewear: [
      { pattern: 'eyewear|lunettes|sunglasses|solaires|optique|montures?', weight: S },
    ],
    Joaillerie: [
      { pattern: 'joaillerie|haute joaillerie|bijoux?|jewel\\w*|diamants?|colliers?|bagues?|boucles d.oreilles', weight: S },
      { pattern: 'bracelets?|perles|or blanc|or jaune|camelia', weight: W },
    ],
    Maroquinerie: [
      { pattern: 'maroquinerie|sacs?|handbags?|bags?|pochettes?|portefeuilles?|cabas', weight: S },
      { pattern: 'cuir|crocodile|agneau|matelasse|bandouliere', weight: M },
    ],
    Lifestyle: [
      { pattern: 'lifestyle|art de vivre|decoration|interieur|mobilier', weight: S },
      { pattern: 'design|amenagement|placards?', weight: M },
      { pattern: 'voyage|gastronomie|hotel|restaurant|rangements?|meubles?|bien-etre', weight: M },
      { pattern: 'maison', weight: W },
    ],
  },
  products: {
    Robe: [{ pattern: 'robes?|dress(es)?|gown', weight: S }],
    'Sac 2.55': [{ pattern: '2[.,]55|sac 255', weight: S }],
    'Sac Grand Shopping': [{ pattern: 'grand shopping|gst', weight: S }],
    'Chanel N°5': [{ pattern: 'n° ?5|no ?5|numero 5|number 5|n5', weight: S }],
    'Chanel Coco Mademoiselle': [{ pattern: 'coco mademoiselle', weight: S }],
    'Montre J12': [{ pattern: 'j12', weight: S }],
    'Lunettes de Soleil': [{ pattern: 'lunettes de soleil|sunglasses|solaires', weight: S }],
    'Sac 19': [{ pattern: 'sac 19|chanel 19|19 bag', weight: S }],
    Costume: [{ pattern: 'costumes?|tailleurs?|suits?', weight: S }],
    Chemise: [{ pattern: 'chemises?|shirts?|chemisiers?', weight: S }],
    Chaussures: [
      { pattern: 'chaussures|shoes|escarpins|souliers|ballerines|bottes|bottines|mocassins|sneakers|slingbacks?|mules', weight: S },
    ],
  },
};
