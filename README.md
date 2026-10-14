# Doc Scanner Agent — MVP local

Agent Node.js **100 % local** qui scanne des documents (PDF, Word, images), en extrait le texte brut et les images, les tague sur 4 listes fermées (sources, régions, thèmes, produits) et les soumet à une validation humaine via une UI web minimale.

- **Aucun appel cloud, aucune clé API.** Les modèles OCR (français + anglais) sont installés via npm et lus depuis le disque.
- Vérifié : extraction, OCR, tagging, stockage et tests passent dans un namespace Linux **sans aucune interface réseau** (`unshare -n`).
- Les seuls appels réseau possibles vont vers **Ollama sur localhost** (optionnel), et l'URL est refusée si elle ne pointe pas sur la machine locale.

---

## Démarrage rapide

Prérequis : **Node.js ≥ 20.9** (macOS ou Linux). Voir [Pourquoi Node 20 et pas 18](#pourquoi-node-20-et-pas-18).

```bash
npm install          # télécharge les dépendances (seule étape qui utilise le réseau)
npm run build        # compile TypeScript → dist/
npm run samples      # génère les 3 documents de test dans data/input/
npm start
```

Sortie attendue :

```
📁 Watching: ./data/input
💾 Database: ./data/scanner.db
📊 0 en attente, 0 validé(s), 0 en erreur
🚀 Agent running on http://localhost:3000
🤖 Ollama absent → tagging par mots-clés uniquement
```

Puis ouvrir **http://localhost:3000** et cliquer sur **« Scanner tout ./data/input »**.

### Tester en ligne de commande

```bash
# Scanner un fichier (chemin relatif à la racine du projet, ou simple nom de fichier de data/input)
curl -X POST http://localhost:3000/api/scan \
  -H "Content-Type: application/json" \
  -d '{"filePath": "./data/input/sample-fashion.pdf"}'

# Documents en attente de validation
curl http://localhost:3000/api/validations/pending

# Valider un document
curl -X POST http://localhost:3000/api/validations/save \
  -H "Content-Type: application/json" \
  -d '{"documentId":"<id>","tags":{"sources":["Instagram"],"regions":["EMEA"],"themes":["Parfum & Beauté"],"products":["Chanel N°5"]},"validatedBy":"Gilles","notes":"ok"}'
```

Sans serveur : `npm run scan` scanne `data/input/` et affiche un résumé.
Tests : `npm test` (25 tests : tagging unitaire, bout en bout sur les 3 samples, onglet « Validés »).

### Consulter les documents validés

L'interface a trois onglets :

| Onglet | Adresse | Contenu |
|---|---|---|
| **À valider** | `#/a-valider` | Documents en attente, tags proposés pré-cochés, bouton ✅ Valider |
| **Validés** | `#/valides` | Liste paginée (25/page), dernière validation d'abord : id copiable, tags validés, validateur, date. Recherche (nom, texte, notes), filtres par tag, validateur et période, export CSV de la sélection |
| **Erreurs** | `#/erreurs` | Visible seulement s'il y a des échecs d'extraction ; bouton « Rescanner » |

Un clic sur un document ouvre sa **fiche** (`#/documents/{id}`, lien direct qui survit au rafraîchissement) :
- **Informations** : type, taille, pages, chemin d'origine, SHA-256, dates, métadonnées, OCR, avertissements.
- **Tags** : comparaison proposition automatique ↔ validation (✔ conservé, ➕ ajouté, ➖ retiré), scores et mots-clés déclencheurs ; un clic sur un tag cherche son mot-clé dans le texte.
- **Validation** : validateur, date, notes, historique complet ; bouton **Remettre en attente** (nom + motif obligatoires, rien n'est supprimé).
- **Texte extrait** : séparateurs de page, recherche sans accents avec surlignage, copie, téléchargement `.txt`.
- **Images** : vignettes, visionneuse plein écran (← → Échap), téléchargement.

Pour tester la liste avec du volume : `npm run seed -- 50` (ou `10000`) crée des documents validés fictifs préfixés `seed-` ; `npm run seed -- --clean` les supprime.

### Vos propres documents

Déposez-les dans `data/input/`. Avec le serveur lancé, la surveillance (`WATCH=true`) les scanne automatiquement à l'arrivée. Sinon, utilisez le bouton de l'UI ou `npm run scan`.
Le contenu de `data/` (documents, images extraites, base SQLite) est **exclu de git**.

---

## Ce qui est livré

| Phase | Statut | Détail |
|---|---|---|
| **Extraction PDF** | ✅ | Texte page par page (`--- Page N ---`), images embarquées → PNG, métadonnées (pages, taille, titre, auteur, producteur). **PDF scanné** (sans couche texte) → OCR automatique des images de page. |
| **Extraction Word** | ✅ | Paragraphes, listes, **tableaux** (une ligne par rangée, cellules séparées par ` \| `), images embarquées, métadonnées. |
| **Extraction images** | ✅ | PNG / JPG / WebP. OCR `tesseract.js` fra+eng avec pré-traitement (niveaux de gris, normalisation, agrandissement) et filtrage des lignes de bruit. Image d'origine conservée. |
| **Tagging mots-clés** | ✅ | Listes fermées, regex sur texte normalisé (sans accents), score de confiance 0–1 par tag, confiance globale, `requiresManualReview` avec motifs. |
| **Tagging Ollama** | ✅ optionnel | En renfort si la confiance est sous le seuil. Les valeurs hors listes sont rejetées. Si Ollama est absent ou en erreur, on garde le résultat mots-clés. |
| **SQLite** | ✅ | Tables `documents`, `images`, `validations`. Migrations versionnées appliquées au démarrage. |
| **Fichiers** | ✅ | `data/images/{documentId}/{imageId}.png`, taille vérifiée après écriture, rollback si l'insertion SQL échoue. |
| **UI validation** | ✅ | Page unique `/` (ou `/validation`). Toutes les valeurs des listes sont proposées, les tags suggérés sont pré-cochés avec leur score, texte complet et vignettes à la demande. |
| **API Express** | ✅ | Voir ci-dessous. |
| **Bonus** | ✅ | Watcher `data/input`, export CSV/JSON, dédoublonnage par hash SHA-256, tests. |

### Résultats sur les fichiers de test

| Fichier | Extraction | Tags principaux | Revue |
|---|---|---|---|
| `sample-fashion.pdf` (généré) | 2 p., 1 595 car., 1 image, 0,3 s | Magazine Papier · EMEA, AMER, APAC · Mode, Maroquinerie · Robe, Sac 2.55, Sac Grand Shopping… | 🟢 0,98 |
| `sample-report.docx` (généré) | 1 138 car., tableau OK, 1 image | EMEA, AMER, APAC, Global · Horlogerie, Parfum & Beauté · N°5, J12, Coco Mademoiselle… | 🟢 0,89 |
| `sample-screenshot.png` (généré) | OCR 94 %, 287 car., 1,7 s | Instagram · EMEA · Parfum & Beauté · Chanel N°5 | 🟢 0,90 |
| PDF magazine réel (2 p.) | 5 894 car., 5 images, 0,4 s | Magazine Papier · Lifestyle, Mode | 🟢 0,86 |
| Capture article Chanel (WebP) | OCR 66 %, ~3 000 car., 19 s* | Magazine Online · EMEA (rue Cambon) · Mode, Maroquinerie | 🟢 0,79 |

\* Le premier OCR inclut l'initialisation de tesseract (≈ 1 s) ; l'image est très haute et contient beaucoup de photos.

---

## API

| Méthode | Route | Description |
|---|---|---|
| `POST` | `/api/scan` | `{ filePath, force? }` → `{ success, documentId, duplicate, extraction, tagging }` |
| `POST` | `/api/scan/input` | Scanne tout `data/input` (fichiers déjà vus ignorés sauf `force: true`) |
| `GET` | `/api/validations/pending` | Documents en attente, plus récents d'abord |
| `POST` | `/api/validations/save` | `{ documentId, tags, validatedBy, notes }` → marque `validated` |
| `GET` | `/api/validated` | Documents validés, paginés et filtrés : `limit` (1–100, défaut 25), `offset`, `q`, `category` + `tag`, `validatedBy`, `from`, `to` (AAAA-MM-JJ). Réponse `{ total, items, validators }` |
| `POST` | `/api/documents/:id/reopen` | `{ by, reason }` → remet un document validé en attente (409 sinon) |
| `GET` | `/api/documents/:id/text` | Texte extrait en `.txt` |
| `GET` | `/api/documents?status=` | Liste (pending / validated / error) |
| `GET` | `/api/documents/:id` | Document complet : texte, métadonnées, tags, images, dernière validation, `validations` (historique), `tagDiff` |
| `GET` | `/api/documents/:id/images/:imageId` | Image extraite ; `?size=thumb` → vignette 320 px (mise en cache dans `thumbs/`), `?download=1` → téléchargement |
| `GET` | `/api/export?format=csv\|json` | Export des validations ; accepte les mêmes filtres que `/api/validated` |
| `GET` | `/api/config/tags` | Listes fermées et seuil |
| `GET` | `/api/health` | État, compteurs, disponibilité d'Ollama |

Les identifiants (`:id`, `:imageId`) doivent être des UUID (`400 BAD_ID` sinon). Codes d'erreur : `400 BAD_REQUEST / BAD_JSON / BAD_QUERY / BAD_TAGS`, `409 NOT_VALIDATED`, `403 PATH_NOT_ALLOWED`, `404 FILE_NOT_FOUND`, `413 FILE_TOO_LARGE`, `415 UNSUPPORTED_FORMAT`, `422 CORRUPTED_FILE / EMPTY_FILE`, `500 EXTRACTION_FAILED`. Un échec d'extraction est aussi enregistré en base (`status = 'error'`).

---

## Tagging : fonctionnement et réglages

Tout est dans **`src/config/tags.ts`** : les 4 listes et, pour chaque valeur, des motifs pondérés (fort 1 / moyen 0,5 / faible 0,25).

- Le texte est normalisé (minuscules, sans accents) et chaque motif est borné aux frontières de mot : « la » ne matche pas dans « plateau », « réel » ne déclenche pas Instagram.
- Calcul : `confiance = 1 − exp(−Σ poids × (1 + ln(occurrences)))`. Un signal fort ≈ 0,63, deux ≈ 0,86.
- Signaux de contexte (sources uniquement) : un PDF penche vers *Magazine Papier*, une image vers *Instagram / Magazine Online*.
- Règles : au moins 1 source (*Autre* par défaut) et au moins 1 thème. Régions et produits peuvent rester vides.
- **Revue manuelle** si la meilleure source ou le meilleur thème est sous `REVIEW_THRESHOLD` (0,6 par défaut), ou si la confiance globale (moyenne des meilleures sources, thèmes et régions) est sous ce seuil.
- La validation humaine refuse toute valeur hors liste fermée.

Les motifs de l'exemple du cahier des charges ont été adaptés. Par exemple, `la` (Los Angeles) matchait tous les articles français, `@` tous les e-mails, et `n°` confondait « N°5 » avec un numéro de magazine.

**À compléter :** la liste `PRODUCTS` définitive (clarification n° 1 du cahier des charges).

### Ollama (optionnel)

```bash
ollama serve & ollama pull llama3.1
# .env : OLLAMA_MODE=auto (défaut) | always | off
```

En mode `auto`, Ollama n'est appelé que pour les documents en revue manuelle. Accord mots-clés + LLM : +0,25. Tag proposé par le LLM seul : 0,5.

---

## Configuration (`.env`)

Copier `.env.example` vers `.env`. Toutes les valeurs ont un défaut.

| Variable | Défaut | Rôle |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `3000` | Écoute **locale uniquement** par défaut |
| `INPUT_DIR` | `./data/input` | Dossier surveillé et seule racine autorisée par défaut |
| `ALLOWED_ROOTS` | — | Autres dossiers autorisés pour `/api/scan` (séparés par des virgules) |
| `MAX_FILE_SIZE_MB` | `50` | Taille max d'un fichier |
| `REVIEW_THRESHOLD` | `0.6` | Seuil de revue manuelle |
| `MIN_TAG_SCORE` | `0.2` | Score minimal pour proposer un tag |
| `OCR_LANGS` | `fra+eng` | Langues OCR (paquet `@tesseract.js-data/<lang>` requis) |
| `WATCH` | `true` | Surveillance de `INPUT_DIR` |
| `OLLAMA_MODE` / `OLLAMA_URL` / `OLLAMA_MODEL` | `auto` / `http://localhost:11434` / `llama3.1` | Ollama |

---

## Sécurité (choix du MVP)

- **Pas de réseau sortant** : modèles OCR embarqués (`@tesseract.js-data/fra|eng`) copiés dans `data/tessdata/`. Le moteur WASM tesseract est lu depuis `node_modules`. pdfjs lit ses polices depuis le disque.
- **Confinement des chemins** : `/api/scan` n'accepte que des fichiers situés (après résolution des liens symboliques) dans `INPUT_DIR` ou `ALLOWED_ROOTS`. `/etc/passwd`, `../` et les liens qui sortent de ces dossiers → 403.
- **Contrôle du contenu** : extension en liste blanche + vérification de la signature binaire (`%PDF-`, zip). Images validées par sharp. Taille max.
- **pdfjs** avec `isEvalSupported: false`.
- **UI** : le texte extrait et l'OCR sont des données non fiables, toujours insérés via `textContent` (un test interdit `innerHTML` dans `public/js`).
- **Serveur** lié à `127.0.0.1`, JSON limité à 1 Mo, en-têtes `CSP` stricts (aucune ressource externe), `nosniff`, `X-Frame-Options: DENY`.
- **Ollama** : URL refusée si elle ne pointe pas sur localhost. Réponses du LLM filtrées sur les listes fermées.
- **Pas d'authentification** sur l'UI/API : acceptable pour un MVP lié à `127.0.0.1`, mais à ajouter avant tout déploiement partagé.
- `npm audit` : il reste 1 alerte modérée (`sprintf-js`, via l'utilitaire en ligne de commande de mammoth). Ce code n'est jamais exécuté par l'agent.

### Pourquoi Node 20 et pas 18

Le cahier des charges demandait Node 18+. Mais les versions de `sharp` compatibles Node 18 (≤ 0.35.5-rc.1) embarquent une libvips/librsvg avec des **CVE de sévérité haute** (GHSA-f88m-g3jw-g9cj, GHSA-wq5f-xc86-pv6w). Or l'agent décode justement des images non maîtrisées. Le correctif (`sharp` 0.35.5) exige Node ≥ 20.9, et Node 18 n'a plus de correctifs de sécurité depuis avril 2025. Les autres dépendances restent compatibles Node 18 si besoin de revenir en arrière (`sharp@^0.33.5`), au prix de ces vulnérabilités.

---

## Écarts par rapport à la stack imposée

| Prévu | Retenu | Raison |
|---|---|---|
| `docx` pour *parser* Word | `mammoth` + `jszip` | `docx` ne sait que **générer** des fichiers Word. Il est conservé (devDependency) pour générer le sample. |
| `node-fetch` | `fetch` natif | Intégré à Node ≥ 18, une dépendance de moins. |
| `chokidar@3.5` | `chokidar@4` | La v3 tire `braces`, qui a une vulnérabilité haute. |
| `uuid@9` | `uuid@11` | La v9 n'est plus maintenue. |
| `pdfjs-dist@4+` | `4.10.38` (figée) | Les v5+ exigent Node ≥ 20.16 / 22. |

---

## Structure

```
├── src/
│   ├── index.ts                 # Démarrage : serveur, watcher, arrêt propre
│   ├── app.ts                   # Application Express (routes API), testable
│   ├── config/
│   │   ├── env.ts               # Configuration (.env)
│   │   └── tags.ts              # LISTES FERMÉES + motifs pondérés
│   ├── services/
│   │   ├── extraction.ts        # PDF (pdfjs), DOCX (mammoth/jszip), images
│   │   ├── ocr.ts               # tesseract.js local + pré-traitement
│   │   ├── tagging.ts           # Mots-clés + Ollama (optionnel)
│   │   ├── storage.ts           # SQLite, migrations, fichiers images, liste des validés
│   │   ├── thumbnails.ts        # Vignettes sharp + cache
│   │   └── scanner.ts           # Orchestration extraction → tagging → stockage
│   ├── types/document.ts
│   └── utils/logger.ts
├── public/                      # UI (HTML/CSS + modules JS sans dépendance)
│   └── js/                      # main (routeur), pending, validated, document, viewer, errors
├── scripts/
│   ├── generate-samples.ts      # Génère les 3 documents de test
│   ├── scan-dir.ts              # Scan en ligne de commande
│   └── seed-validated.ts        # Documents validés fictifs (tests de volume)
├── tests/                       # node:test (unitaires, bout en bout, onglet Validés)
├── docs/                        # Job descriptions des évolutions
├── samples/                     # Documents de test générés (fictifs)
└── data/                        # Runtime, exclu de git
    ├── input/  images/{documentId}/(thumbs/)  tessdata/  scanner.db
```

## Pistes après le MVP

- OCR : découpage par zones pour ignorer les photos des captures composites (gain de vitesse et de qualité).
- Liste produits complète, puis calibrage des poids sur 30–40 documents validés (l'export CSV sert de jeu de vérité).
- Authentification de l'UI, journal d'audit, Docker.
