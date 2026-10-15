# JOB DESCRIPTION : Doc Scanner Agent — Upload de fichiers dans `data/input`

## 📋 Contexte
Évolution du **Doc Scanner Agent** (repo `gbrutkiewicz/poc-press-review`, branche `evol-revue`).
Aujourd'hui, pour faire scanner un document, il faut le copier à la main dans `data/input/` (Finder / terminal), puis cliquer sur « Scanner tout » ou attendre la surveillance du dossier. Les personnes qui font la revue de presse doivent pouvoir **déposer leurs fichiers directement depuis l'interface web**.

**Responsable** : Gilles (CTO adjoint, Mazarine)
**Environnement** : inchangé. macOS/Linux, Node.js ≥ 20.9, **100 % local, zéro dépendance cloud, zéro clé API**, serveur lié à `127.0.0.1`.
**Point de départ** : branche `evol-revue` (onglets À valider / Validés / Erreurs, fiche document).

---

## 🎯 Objectif Principal
Permettre de :
1. **Déposer un ou plusieurs fichiers** (PDF, DOCX, PNG, JPG, WebP) depuis l'interface, par glisser-déposer ou sélection, avec une barre de progression par fichier.
2. Les **enregistrer de façon sûre** dans `data/input/`.
3. Les **scanner automatiquement** et suivre leur état jusqu'au résultat : lien vers la fiche, doublon détecté, ou erreur expliquée.

---

## ⚠️ Point d'architecture à traiter en premier
La surveillance du dossier (`chokidar`, `src/index.ts`) scanne déjà tout fichier qui arrive dans `data/input/`, avec **sa propre file d'attente**. Les scans lancés par l'API (`/api/scan`, `/api/scan/input`) passent, eux, **en dehors de cette file**.
Si l'upload écrit dans `data/input/` puis lance un scan, **le même fichier sera scanné deux fois en parallèle**. Le dédoublonnage par empreinte (`findByHash`) ne protège pas contre deux scans *simultanés* : les deux vérifications passent avant la première insertion. On obtient alors des doublons en base et deux OCR concurrents (RAM).

➡️ **Exigé** : une **file de scan unique** (`src/services/scanQueue.ts`), utilisée par la surveillance du dossier, l'API et l'upload :
- exécution **séquentielle** (un seul scan à la fois, l'OCR étant gourmand) ;
- **dédoublonnage des fichiers en cours** : un fichier déjà en file ou en cours de scan renvoie la **même promesse** au lieu d'être scanné une seconde fois ;
- état consultable (en attente / en cours / terminé) pour l'interface.

---

## ✅ Livrables Attendus

### Phase 1 : File de scan unique (Priorité 🔴 HAUTE)
- [ ] `scanQueue.enqueue(absPath, opts) → Promise<ScanResult>` : séquentiel, dédoublonnage des fichiers en cours par chemin réel (`realpath`).
- [ ] La surveillance du dossier, `POST /api/scan`, `POST /api/scan/input` et l'upload passent **tous** par cette file.
- [ ] `GET /api/queue` : `{ running: {file, startedAt} | null, pending: [file…] }`.
- ✅ Test : 2 demandes de scan simultanées du même fichier → **1 seul document** en base, 1 seule extraction.

### Phase 2 : API d'upload (Priorité 🔴 HAUTE)
- [ ] **`POST /api/upload?filename=<nom>&scan=1`**. Corps : le fichier brut (`Content-Type: application/octet-stream`), **un fichier par requête**.
  - Choix assumé : pas de `multipart/form-data`, donc **aucune nouvelle dépendance** (multer/busboy). Le navigateur envoie chaque fichier avec `fetch`/`XMLHttpRequest`, ce qui donne une progression native par fichier.
  - Lecture en flux avec **limite de taille** `MAX_FILE_SIZE_MB` appliquée pendant la réception : la requête est interrompue (413) dès le dépassement, sans tout garder en mémoire.
- [ ] **Nom de fichier assaini** :
  - `path.basename` + normalisation Unicode NFC ; suppression des caractères de contrôle et de `/ \ : * ? " < > |` ; pas de nom vide, ni de nom commençant par `.` ; 150 caractères max (extension comprise) ;
  - **extension en liste blanche** (`SUPPORTED_EXTENSIONS` existant) → 415 sinon.
- [ ] **Contrôle du contenu** avant enregistrement définitif :
  - **signature binaire** (réutiliser `checkMagicBytes`, `%PDF-` / zip) ; images décodables par `sharp` → 422 sinon ;
  - fichier vide → 422.
- [ ] **Écriture atomique** : écriture dans `data/input/.upload-<uuid>.part` (fichier caché, donc **ignoré par la surveillance**), puis `rename` vers le nom final. Le fichier temporaire est supprimé en cas d'erreur ou de connexion coupée.
- [ ] **Conflit de nom** :
  - même nom **et** même contenu (SHA-256) → pas de nouvelle copie, réponse `duplicate: true` + `documentId` existant s'il a déjà été scanné ;
  - même nom, contenu différent → suffixe automatique `nom (2).pdf`, `nom (3).pdf`… **jamais d'écrasement**.
- [ ] **Scan** : avec `scan=1` (défaut), le fichier est mis dans la file et la réponse attend le résultat. Avec `scan=0`, la réponse est immédiate après l'enregistrement.
- [ ] Réponse : `{ success, file: { name, size, sha256, savedAs }, duplicate, scan: ScanResult | null }`.
- ✅ Format d'erreur existant : `{ success: false, code, error }` (`400 BAD_FILENAME`, `413 FILE_TOO_LARGE`, `415 UNSUPPORTED_FORMAT`, `422 CORRUPTED_FILE / EMPTY_FILE`).

### Phase 3 : Interface (Priorité 🔴 HAUTE)
- [ ] Bouton **« Déposer des fichiers »** dans la barre d'outils (visible sur tous les onglets) → sélecteur de fichiers **multiple**, filtré sur `.pdf,.docx,.png,.jpg,.jpeg,.webp`.
- [ ] **Glisser-déposer** de fichiers n'importe où sur la page : un calque « Déposez vos fichiers ici » apparaît pendant le survol.
- [ ] **Panneau d'envoi**, une ligne par fichier :
  - nom, taille, **barre de progression** de l'envoi ;
  - états : `En attente` → `Envoi 45 %` → `Scan en cours…` → `✅ Scanné` (lien vers la fiche) / `♻️ Déjà présent` (lien vers le document existant) / `❌ Erreur` (message clair) ;
  - bouton « Annuler » tant que l'envoi n'est pas fini ;
  - panneau repliable, avec bouton « Effacer la liste » une fois tout terminé.
- [ ] **Contrôles côté navigateur avant envoi** (extension, taille max), avec un message immédiat. Le serveur refait **tous** les contrôles.
- [ ] Au plus **3 envois simultanés**. Les scans restent séquentiels côté serveur.
- [ ] Case **« Scanner automatiquement »** (cochée par défaut, mémorisée dans le navigateur).
- [ ] Les compteurs des onglets et la liste « À valider » se rafraîchissent à chaque scan terminé.
- [ ] Le champ texte « Scanner ce fichier » (chemin) est **conservé** pour les cas avancés.
- ✅ Testé avec : 1 PDF, 5 fichiers mélangés, 1 fichier refusé (.txt), 1 fichier trop gros, 1 doublon.

### Phase 4 : Contenu de `data/input` (Priorité 🟠 MOYENNE)
- [ ] **`GET /api/input`** : liste des fichiers présents dans `data/input/` (nom, taille, date) avec leur statut (`non scanné` / `en file` / `scanné` + `documentId` / `erreur`), en croisant par empreinte avec la base.
- [ ] Section « Fichiers déposés » (repliable, sous la barre d'outils, ou onglet dédié) affichant cette liste, avec un bouton « Scanner » sur les fichiers non scannés.
- ✅ Permet de voir les fichiers copiés à la main et jamais scannés.

---

## 🔒 Exigences de Sécurité
L'upload est la **première fonction qui écrit sur le disque à partir de données envoyées par le navigateur**. Points obligatoires :

| Risque | Mesure |
|---|---|
| Traversée de répertoire (`../../.ssh/x`) | Nom assaini (cf. Phase 2). Le chemin final est recalculé et **vérifié comme étant dans `INPUT_DIR`** après résolution. |
| Écrasement de fichiers | Jamais d'écrasement : suffixe automatique. |
| Fichier déguisé (`.pdf` qui n'en est pas un) | Signature binaire + décodage `sharp` pour les images. |
| Saturation disque / mémoire | Limite de taille appliquée pendant la réception. Corps limité à un fichier par requête. Fichiers `.part` nettoyés au démarrage. |
| **Requête forgée par un site tiers (CSRF vers `localhost`)** | Une page web malveillante ouverte dans le navigateur peut envoyer des requêtes à `http://localhost:3000`. Toutes les routes **POST** (upload, mais aussi scan, validation, remise en attente) doivent refuser (403) les requêtes dont l'en-tête `Origin` est présent et différent de l'origine du serveur, ou dont `Sec-Fetch-Site` vaut `cross-site`. |
| DNS rebinding | Refuser (421/403) les requêtes dont l'en-tête `Host` n'est pas `localhost:<port>` ou `127.0.0.1:<port>` (sauf si `HOST` est configuré autrement). |
| Contenu non fiable affiché | Noms de fichiers et messages insérés via `textContent` uniquement (le test « aucun `innerHTML` » existant reste vert). |

---

## 🛠️ Contraintes Techniques

| Sujet | Règle |
|---|---|
| Dépendances | **Aucune nouvelle dépendance runtime** (upload brut + `express.raw` ou lecture du flux de la requête). |
| UI | Modules JS vanilla dans `public/js/` (nouveau `upload.js`), sans CDN. La CSP actuelle reste inchangée. |
| Compatibilité | La surveillance du dossier et la copie manuelle dans `data/input/` continuent de fonctionner à l'identique. |
| Accessibilité | Bouton d'envoi utilisable au clavier ; le glisser-déposer n'est **pas** le seul moyen. Progression annoncée (`aria-live`). |
| Responsive | Utilisable à 375 px (sur mobile, sans glisser-déposer, via le bouton). |

---

## 📁 Fichiers Concernés (indicatif)

```
src/services/scanQueue.ts     # (nouveau) file de scan unique + dédoublonnage des fichiers en cours
src/services/upload.ts        # (nouveau) assainissement du nom, écriture atomique, conflits
src/app.ts                    # POST /api/upload, GET /api/input, GET /api/queue, contrôle Origin/Host
src/index.ts                  # la surveillance du dossier passe par scanQueue ; nettoyage des .part au démarrage
public/js/upload.js           # (nouveau) sélecteur, glisser-déposer, panneau d'envoi, progression
public/js/main.js             # branchement + rafraîchissement des compteurs
public/index.html, style.css
tests/upload.test.ts          # (nouveau)
README.md                     # section « Déposer des fichiers »
```

---

## ✨ Critères d'Acceptation

### ✅ MUST HAVE (bloquants)
1. Dépôt d'un ou plusieurs fichiers depuis l'interface (bouton **et** glisser-déposer) → fichiers présents dans `data/input/`, scannés, visibles dans « À valider ».
2. **Aucun double scan** : 1 fichier déposé = 1 document en base, même avec la surveillance du dossier active.
3. Nom assaini, extension et signature contrôlées, taille limitée, jamais d'écrasement, aucun fichier `.part` résiduel.
4. Requêtes POST provenant d'une autre origine refusées (403).
5. Aucune régression : copie manuelle + surveillance du dossier, « Scanner tout », onglets, `npm test` vert, fonctionnement hors ligne.

### 🟢 SHOULD HAVE
6. Progression par fichier, états détaillés jusqu'au lien vers la fiche.
7. Doublon reconnu (même contenu) avec lien vers le document existant.
8. Liste du contenu de `data/input` avec statut de scan.

### 🟡 NICE TO HAVE
9. **Coller une capture d'écran** (Ctrl/Cmd + V) → envoyée comme `capture-AAAAMMJJ-HHMMSS.png`. Très utile pour les captures d'articles en ligne et de posts Instagram.
10. Position dans la file affichée (« 2 fichiers avant le vôtre »).
11. Envoi d'un dossier entier (`webkitdirectory`), sans sous-dossiers.

---

## 🧪 Tests Attendus
- **Unitaires** : assainissement des noms (`../../x.pdf`, `con\u0000.pdf`, `.htaccess`, nom de 300 caractères, accents décomposés NFD → NFC, `rapport.PDF`), génération du suffixe `(2)`, `(3)`.
- **API (`node:test`)** :
  - upload d'un PDF valide (`201`, fichier présent, document créé) ;
  - `.txt` → 415 ; faux PDF → 422 (aucun fichier laissé dans `data/input`) ; fichier > limite → 413 (aucun `.part` résiduel) ;
  - même fichier envoyé deux fois → `duplicate: true`, un seul document ;
  - même nom, contenu différent → `nom (2).pdf` ;
  - `Origin: https://evil.example` → 403 ; `Host: evil.example` → refusé ;
  - **concurrence** : upload + scan déclenché par la surveillance du dossier du même fichier → 1 seul document.
- **Manuel** : checklist dans la PR (glisser-déposer, annulation, 5 fichiers mélangés, mobile 375 px, clavier).

---

## 🚀 Démo Attendue

```bash
npm install && npm run build && npm start
open http://localhost:3000
# 1. Glisser 3 fichiers (PDF, DOCX, PNG) sur la page → progression → « ✅ Scanné » → liens vers les fiches
# 2. Redéposer le même PDF → « ♻️ Déjà présent »
# 3. Déposer un .txt → refusé avec message
# 4. Onglet « À valider » : les 3 documents sont là, compteurs à jour

curl -X POST "http://localhost:3000/api/upload?filename=article.pdf" \
  -H "Content-Type: application/octet-stream" --data-binary @article.pdf
```

---

## 🚫 Hors Périmètre
- Suppression ou renommage de fichiers de `data/input/` depuis l'interface.
- Upload depuis une autre machine du réseau (le serveur reste lié à `127.0.0.1`).
- Authentification (chantier séparé, **prérequis** avant toute ouverture réseau).
- Archives (`.zip`) et formats non supportés par l'extraction.

---

## 📞 Clarifications Avant Démarrage
1. **Scan automatique** après dépôt : par défaut (proposé), ou dépôt seul puis scan manuel ?
   → Défaut : scan automatique, désactivable par une case à cocher.
2. **Taille maximale** : les 50 Mo actuels conviennent-ils aux PDF magazine haute définition ?
   → Défaut : 50 Mo (`MAX_FILE_SIZE_MB`).
3. **Doublon** : un fichier déjà scanné redéposé doit-il être ignoré (proposé) ou rescanné ?
   → Défaut : ignoré, avec lien vers le document existant.
4. **Coller une capture** (nice to have) : utile dès cette itération ?

---

## 🎬 Timeline Estimée
- **1h30** : file de scan unique + bascule de la surveillance du dossier et des routes existantes + test de concurrence
- **1h30** : `POST /api/upload` (flux, limite, assainissement, écriture atomique, conflits) + tests
- **45 min** : contrôle `Origin` / `Host` sur les routes POST + tests
- **2h** : interface (bouton, glisser-déposer, panneau d'envoi, progression, annulation, états)
- **45 min** : `GET /api/input` + section « Fichiers déposés »
- **45 min** : README, checklist, vérifications mobile/clavier
- **Buffer** : 1h

**Total** : ~7–8h de travail concentré.
