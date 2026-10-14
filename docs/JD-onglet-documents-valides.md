# JOB DESCRIPTION : Doc Scanner Agent — Onglet « Documents validés »

## 📋 Contexte
Évolution du MVP local **Doc Scanner Agent** (repo `gbrutkiewicz/poc-press-review`).
L'interface actuelle (`public/`) ne montre que les documents **en attente**. Une fois validé, un document disparaît de l'écran. On ne peut alors le retrouver que via l'API (`/api/export`, `/api/documents?status=validated`) ou SQLite.

**Responsable** : Gilles (CTO adjoint, Mazarine)
**Environnement** : inchangé. macOS/Linux, Node.js ≥ 20.9, **100 % local, zéro dépendance cloud, zéro clé API**.
**Point de départ** : branche du MVP (PR #1), stack et conventions existantes.

---

## 🎯 Objectif Principal
Ajouter à l'UI un **onglet « Validés »** qui permet de :
1. Lister les documents validés et récupérer facilement leur **documentId**.
2. Ouvrir la **fiche détaillée** d'un document : texte extrait complet, informations additionnelles (métadonnées, tags, validation) et **images extraites**.
3. Si nécessaire, **remettre un document en attente** pour une nouvelle validation.

---

## ✅ Livrables Attendus

### Phase 1 : Navigation (Priorité 🔴 HAUTE)
- [ ] **Onglets** en haut de page : `À valider (n)` · `Validés (n)`, avec les compteurs issus de `/api/health`.
- [ ] **Routage par hash**, pour que le rafraîchissement, le bouton Retour et les liens directs fonctionnent :
  - `#/a-valider` (défaut) : écran actuel, inchangé
  - `#/valides` : liste des documents validés
  - `#/documents/{documentId}` : fiche détaillée
- [ ] La barre d'outils (scan, exports) reste accessible depuis tous les onglets.
- ✅ Aucune régression sur l'écran de validation existant.

### Phase 2 : Liste des documents validés (Priorité 🔴 HAUTE)
- [ ] **Une ligne ou carte par document**, contenant :
  - nom du fichier + icône de type (PDF / DOCX / image)
  - **documentId** affiché en abrégé (8 premiers caractères) + **bouton « Copier »** (id complet dans le presse-papiers)
  - tags **validés**, en pastilles regroupées par catégorie (sources, régions, thèmes, produits)
  - validé par + date de validation
  - confiance du tagging automatique (%) et nombre d'images
- [ ] **Tri** : dernière validation d'abord.
- [ ] **Recherche** plein texte sur le nom du fichier et le texte extrait (champ unique, appliqué après une courte pause de saisie).
- [ ] **Filtres** : catégorie + valeur de tag (liste fermée), validateur, période (du / au).
- [ ] **Pagination** : 25 par page, avec le total affiché. Volume cible : 30–40 docs/jour, soit ~10 000/an.
- [ ] Un clic sur une ligne ouvre la fiche `#/documents/{id}`.
- [ ] État vide explicite (« Aucun document validé » / « Aucun résultat pour ces filtres »).
- ✅ Testé avec au moins 50 documents validés (script de génération accepté).

### Phase 3 : Fiche document (Priorité 🔴 HAUTE)
- [ ] **En-tête** : nom du fichier, documentId complet + bouton Copier, statut, lien « ← Retour à la liste » (filtres conservés).
- [ ] **Bloc « Informations »** : toutes les données déjà en base, en lecture seule :
  - type, type MIME, taille (Ko/Mo), nombre de pages, dimensions (images)
  - chemin d'origine, empreinte SHA-256 (abrégée, copiable)
  - date de scan, date de dernière mise à jour
  - métadonnées du fichier : titre, auteur, producteur
  - OCR : utilisé oui/non, confiance (%), motif (`image` / `pdf-sans-texte`)
  - avertissements d'extraction (`metadata.warnings`)
- [ ] **Bloc « Tags »** : comparaison entre la **proposition automatique** et les **tags validés** :
  - ✔ conservés · ➕ ajoutés par l'humain · ➖ retirés par l'humain
  - score de confiance et mots-clés déclencheurs (`matches`) au survol
  - confiance globale, moteur (`keywords` / `keywords+ollama`), motifs de revue
  - *Intérêt :* ce diff servira à recalibrer les poids de `src/config/tags.ts`.
- [ ] **Bloc « Validation »** : validé par, date, notes. **Historique** complet si le document a été validé plusieurs fois (la table `validations` contient déjà une ligne par validation).
- [ ] **Bloc « Texte extrait »** :
  - texte complet, police monospace, séparateurs `--- Page N ---` mis en évidence
  - recherche dans le texte avec surlignage et nombre d'occurrences
  - boutons « Copier le texte » et « Télécharger .txt »
  - textes longs : zone défilante, sans bloquer la page
- [ ] **Bloc « Images »** :
  - galerie de vignettes (page, dimensions, origine `embedded` / `original`)
  - **visionneuse** au clic : image pleine taille, précédente/suivante, fermeture (Échap), navigation au clavier (← →)
  - téléchargement de l'image
  - message clair si aucune image n'a été extraite, ou si le fichier image manque sur le disque
- ✅ Testé sur les 3 samples (PDF, DOCX, PNG) et sur un document sans image.

### Phase 4 : Remise en attente (Priorité 🟠 MOYENNE)
- [ ] Bouton **« Remettre en attente »** sur la fiche, avec demande de confirmation, nom et motif obligatoires.
- [ ] Le document repasse en `pending` et réapparaît dans « À valider », avec les **derniers tags validés pré-cochés**.
- [ ] **Aucune donnée supprimée** : l'action est tracée dans l'historique.

### Phase 5 : Backend / API (Priorité 🟠 MOYENNE)
- [ ] **`GET /api/validated`** : liste paginée, jointure avec la **dernière** validation.
  - Query : `limit` (≤ 100, défaut 25), `offset`, `q`, `category`, `tag`, `validatedBy`, `from`, `to` (ISO)
  - Réponse : `{ total, items: [{ documentId, filename, kind, fileSize, pageCount, imageCount, autoConfidence, validation: { validatedTags, validatedBy, validatedAt, notes } }] }`
  - Le texte complet **n'est pas** renvoyé dans la liste (seulement un aperçu de 200 caractères).
- [ ] **`GET /api/documents/:id`** (existant) enrichi de :
  - `validations` : historique complet (pas seulement la dernière)
  - `tagDiff` : `{ kept, added, removed }` par catégorie
- [ ] **`GET /api/documents/:id/text`** : `text/plain; charset=utf-8`, en pièce jointe `{filename}.txt`.
- [ ] **`GET /api/documents/:id/images/:imageId?size=thumb`** : vignette de 320 px de large générée avec `sharp` et mise en cache dans `data/images/{documentId}/thumbs/`. Sans paramètre, l'image originale est servie (comportement actuel).
- [ ] **`POST /api/documents/:id/reopen`** : `{ by, reason }` → statut `pending`, événement tracé.
- [ ] **Migration n° 2** (dans `MIGRATIONS` de `src/services/storage.ts`, appliquée automatiquement au démarrage) :
  - colonne `action TEXT NOT NULL DEFAULT 'validate'` sur `validations` (`'validate'` | `'reopen'`), ou table `document_events` dédiée (au choix, à justifier)
  - `getLatestValidation()` ne doit retenir que les lignes `action = 'validate'`
  - index utiles pour le tri et les filtres (`validated_at`, `validated_by`)
- [ ] Recherche : `LIKE` suffit pour le MVP. Prévoir l'emplacement pour un passage à **SQLite FTS5** (sans l'implémenter).
- ✅ Les erreurs suivent le format existant : `{ success: false, code, error }`, avec les codes 400 / 404 / 409.

---

## 🛠️ Contraintes Techniques

| Sujet | Règle |
|---|---|
| Stack | Inchangée : Express + TypeScript, `better-sqlite3`, `sharp`. **Aucune nouvelle dépendance runtime** sans justification. |
| UI | HTML/CSS/JS **vanilla** dans `public/`, sans framework ni CDN. La CSP actuelle (`script-src 'self'`) reste inchangée. |
| Sécurité XSS | Le texte extrait et l'OCR sont des **données non fiables** : insertion **uniquement** via `textContent` / `createElement`, **jamais** `innerHTML` avec des données. Le surlignage de recherche doit être construit avec des nœuds DOM. |
| Sécurité API | `documentId` / `imageId` validés au format UUID avant toute requête. Les chemins d'image restent confinés à `data/images` (contrôle existant). Le serveur reste lié à `127.0.0.1`. |
| Performance | Liste < 300 ms avec 10 000 documents. Les images de la liste et de la galerie utilisent les vignettes et `loading="lazy"`. |
| Accessibilité | Visionneuse utilisable au clavier, `alt` sur les images, contrastes suffisants, onglets avec `aria-selected`. |
| Responsive | Utilisable à 375 px de large, sans défilement horizontal de la page. |
| Style | Registre sobre de l'UI actuelle (noir / blanc / beige, typographie système). |

---

## 📁 Fichiers Concernés (indicatif)

```
src/index.ts                  # nouvelles routes
src/services/storage.ts       # migration v2, requêtes liste/filtre/historique/reopen
src/services/thumbnails.ts    # (nouveau) vignettes sharp + cache
src/types/document.ts         # types ValidatedListItem, TagDiff, ValidationEvent
public/index.html             # onglets + conteneurs de vues
public/app.js                 # routeur par hash, vues liste / fiche, visionneuse
public/style.css
tests/validated.test.ts       # (nouveau)
README.md                     # section « Consulter les documents validés »
```

---

## ✨ Critères d'Acceptation

### ✅ MUST HAVE (bloquants)
1. Onglet « Validés » listant tous les documents validés, dernière validation en premier, avec **documentId copiable en un clic**.
2. Fiche document affichant le **texte complet**, les **informations additionnelles** (métadonnées, OCR, avertissements, validation) et les **images** (vignettes + plein écran).
3. Liens directs `#/documents/{id}` fonctionnels après un rafraîchissement.
4. Aucune régression : écran « À valider », scan, exports CSV/JSON, `npm test` vert.
5. Aucun appel réseau externe : tout fonctionne hors ligne.

### 🟢 SHOULD HAVE
6. Recherche, filtres et pagination.
7. Comparaison tags automatiques / validés.
8. Remise en attente tracée (+ historique).
9. Vignettes générées et mises en cache.

### 🟡 NICE TO HAVE
10. Onglet « Erreurs » (documents en `status = 'error'` avec le message et un bouton « Rescanner »).
11. Export CSV/JSON de la **sélection filtrée** courante.
12. Raccourcis clavier dans la liste (↑ ↓ Entrée).
13. Surlignage dans le texte des mots-clés qui ont déclenché chaque tag.

---

## 🧪 Tests Attendus
- **Unitaires (storage)** : filtres combinés, pagination (`total` exact), dernière validation vs historique, migration v2 appliquée sur une base v1 existante **sans perte de données**.
- **API (bout en bout, `node:test`)** : `/api/validated` (filtres, bornes de `limit`, id invalide → 400), `/text`, `?size=thumb` (fichier créé puis réutilisé), `reopen` (statut, historique, 409 si le document n'est pas validé).
- **Sécurité** : un document dont le texte contient `<img src=x onerror=alert(1)>` s'affiche **littéralement** dans la liste et la fiche.
- **Manuel** : checklist dans la PR (navigation, visionneuse au clavier, copie de l'id, affichage mobile 375 px).

---

## 🚀 Démo Attendue

```bash
npm install && npm run build && npm run samples && npm start
open http://localhost:3000
# 1. « Scanner tout » → valider les 3 samples dans l'onglet « À valider »
# 2. Onglet « Validés » → 3 documents, copier un id
# 3. Ouvrir sample-report.docx → texte avec le tableau, métadonnées, 1 image en plein écran
# 4. « Remettre en attente » → le document réapparaît dans « À valider »

curl "http://localhost:3000/api/validated?tag=Mode&category=themes&limit=10"
```

---

## 🚫 Hors Périmètre
- Modifier les tags directement depuis l'onglet « Validés » (passer par « Remettre en attente »).
- Authentification et gestion des rôles (chantier séparé, à faire avant tout usage partagé).
- Suppression de documents.
- Recherche FTS5 et recherche sémantique.

---

## 📞 Clarifications Avant Démarrage
1. **Remise en attente** : réservée à certaines personnes, ou ouverte à tous tant qu'il n'y a pas d'authentification ?
   → Défaut : ouverte à tous, avec nom et motif obligatoires.
2. **Historique** : faut-il aussi tracer qui a **consulté** une fiche (journal d'audit) ?
   → Défaut : non (seulement validations et remises en attente).
3. **Recherche** : texte seul, ou aussi notes et validateur ?
   → Défaut : nom de fichier + texte extrait + notes.
4. **Affichage de la liste** : tableau dense (consultation rapide) ou cartes (comme l'écran actuel) ?
   → Défaut : tableau sur ordinateur, cartes sur mobile.

---

## 🎬 Timeline Estimée
- **1h30** : migration v2 + requêtes storage + routes API + tests API
- **2h** : routeur par hash, onglets, liste (recherche / filtres / pagination)
- **2h** : fiche document (infos, comparaison des tags, texte + recherche, galerie + visionneuse)
- **45 min** : vignettes + remise en attente
- **45 min** : tests de sécurité/XSS, responsive, README, checklist de PR
- **Buffer** : 1h

**Total** : ~7–8h de travail concentré.
