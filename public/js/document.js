import { api, post } from './api.js';
import { CATS, KIND_ICON, copyButton, debounce, flash, fmtDate, fmtSize, h, normalize, pct, storageGet, storageSet } from './dom.js';
import { describe, openViewer } from './viewer.js';
import { lastListQuery } from './validated.js';

const STATUS = { pending: 'En attente', validated: 'Validé', error: 'En erreur' };
const BACK = {
  validated: () => [`#/valides${lastListQuery ? '?' + lastListQuery : ''}`, 'Retour aux documents validés'],
  pending: () => ['#/a-valider', 'Retour à la validation'],
  error: () => ['#/erreurs', 'Retour aux erreurs'],
};

/** Fiche détaillée d'un document (#/documents/{id}). */
export async function renderDocument(root, id, { onChange }) {
  root.replaceChildren(h('p', { class: 'muted' }, 'Chargement…'));
  let doc;
  try {
    doc = await api(`/api/documents/${encodeURIComponent(id)}`);
  } catch (err) {
    root.replaceChildren(h('p', {}, h('a', { href: '#/valides' }, '← Documents validés')), h('p', { class: 'error' }, err.message));
    return;
  }
  const [backHref, backLabel] = BACK[doc.status]();
  const textBlock = textSection(doc);

  root.replaceChildren(...[
    h('p', {}, h('a', { href: backHref, class: 'back' }, `← ${backLabel}`)),
    h('header', { class: 'doc-head' },
      h('h2', {}, `${KIND_ICON[doc.kind] || ''} ${doc.filename}`),
      h('div', { class: 'doc-id' },
        h('span', { class: `status ${doc.status}` }, STATUS[doc.status]),
        h('code', {}, doc.documentId), copyButton(doc.documentId, 'Copier l’id'),
        doc.status === 'pending' && h('a', { href: '#/a-valider', class: 'button secondary small' }, 'Aller à la validation'))),
    doc.error && h('p', { class: 'error' }, `Erreur d'extraction : ${doc.error}`),
    h('div', { class: 'panels' },
      infoSection(doc),
      tagsSection(doc, (term) => textBlock.search(term)),
      validationSection(doc, onChange)),
    textBlock.node,
    imagesSection(doc),
  ].filter(Boolean));
}

/* ------------------------------------------------------- Informations -- */

function infoSection(doc) {
  const m = doc.metadata || {};
  const rows = [
    ['Type', `${doc.kind.toUpperCase()} (${doc.mimeType})`],
    ['Taille', fmtSize(doc.fileSize)],
    doc.pageCount != null && ['Pages', doc.pageCount],
    m.width && ['Dimensions', `${m.width} × ${m.height} px`],
    ['Chemin d’origine', h('span', { class: 'break' }, doc.filePath)],
    ['Empreinte SHA-256', h('span', {}, h('code', { title: doc.fileHash }, `${doc.fileHash.slice(0, 16)}…`), ' ', copyButton(doc.fileHash))],
    ['Scanné le', fmtDate(doc.createdAt)],
    ['Mis à jour le', fmtDate(doc.updatedAt)],
    m.title && ['Titre', m.title],
    m.author && ['Auteur', m.author],
    m.producer && ['Producteur', m.producer],
    ['OCR', m.ocr?.used ? `oui · confiance ${pct(m.ocr.confidence)} · ${m.ocr.reason === 'pdf-sans-texte' ? 'PDF sans couche texte' : 'image'}` : 'non'],
    ['Texte extrait', `${doc.extractedText.length.toLocaleString('fr-FR')} caractères`],
    ['Images', doc.images?.length ?? 0],
  ].filter(Boolean);
  return h('section', { class: 'panel' },
    h('h3', {}, 'Informations'),
    h('dl', {}, rows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
    m.warnings?.length ? h('div', { class: 'warnings' }, h('strong', {}, '⚠️ Avertissements'), h('ul', {}, m.warnings.map((w) => h('li', {}, w)))) : null);
}

/* --------------------------------------------------------------- Tags -- */

function tagsSection(doc, searchInText) {
  const t = doc.tagging;
  const scoreOf = (cat, value) => t?.tags[cat]?.find((x) => x.value === value);
  const chip = (cat, value, kind) => {
    const s = scoreOf(cat, value);
    const term = s?.matches?.find((m) => !m.startsWith('['));
    const label = { kept: '✔', added: '➕', removed: '➖', auto: '' }[kind];
    const title = [
      { kept: 'Proposé et conservé', added: 'Ajouté par l’humain', removed: 'Proposé puis retiré par l’humain', auto: 'Proposition automatique' }[kind],
      s ? `confiance ${pct(s.confidence)} (${s.origin})` : null,
      s?.matches?.length ? `déclencheurs : ${s.matches.join(', ')}` : null,
      term ? 'clic : chercher dans le texte' : null,
    ].filter(Boolean).join(' — ');
    return h(term ? 'button' : 'span', { type: term ? 'button' : undefined, class: `chip ${kind}`, title, onclick: term ? () => searchInText(term.replace(/^[#@]/, '')) : undefined },
      `${label} ${value}`.trim(), s && kind !== 'added' ? h('small', {}, ` ${pct(s.confidence)}`) : null);
  };

  const body = doc.tagDiff
    ? CATS.map(([cat, label]) => {
        const d = doc.tagDiff[cat];
        const chips = [...d.kept.map((v) => chip(cat, v, 'kept')), ...d.added.map((v) => chip(cat, v, 'added')), ...d.removed.map((v) => chip(cat, v, 'removed'))];
        return h('div', { class: 'tag-row' }, h('span', { class: 'tag-cat' }, label), h('span', { class: 'chips' }, chips.length ? chips : h('span', { class: 'muted' }, '—')));
      })
    : CATS.map(([cat, label]) =>
        h('div', { class: 'tag-row' }, h('span', { class: 'tag-cat' }, label),
          h('span', { class: 'chips' }, (t?.tags[cat] || []).length ? t.tags[cat].map((x) => chip(cat, x.value, 'auto')) : h('span', { class: 'muted' }, '—'))));

  return h('section', { class: 'panel' },
    h('h3', {}, doc.tagDiff ? 'Tags : automatique ↔ validé' : 'Tags proposés'),
    doc.tagDiff && h('p', { class: 'legend muted' }, '✔ conservé · ➕ ajouté par l’humain · ➖ retiré par l’humain'),
    body,
    t && h('p', { class: 'muted small' },
      `Confiance globale ${pct(t.confidence)} · moteur ${t.engine}`,
      t.reviewReasons?.length ? h('span', {}, h('br'), `Motifs de revue : ${t.reviewReasons.join(' · ')}`) : null));
}

/* --------------------------------------------------------- Validation -- */

function validationSection(doc, onChange) {
  const v = doc.validation;
  const history = doc.validations || [];
  const section = h('section', { class: 'panel' }, h('h3', {}, 'Validation'));

  if (v && doc.status === 'validated') {
    section.append(h('dl', {},
      h('dt', {}, 'Validé par'), h('dd', {}, v.validatedBy),
      h('dt', {}, 'Le'), h('dd', {}, fmtDate(v.validatedAt)),
      h('dt', {}, 'Notes'), h('dd', {}, v.notes || '—')));
  } else {
    section.append(h('p', { class: 'muted' }, doc.status === 'pending' ? 'Document en attente de validation.' : 'Pas de validation.'));
  }

  if (history.length) {
    section.append(h('details', { class: 'history', open: history.length > 1 },
      h('summary', {}, `Historique (${history.length})`),
      h('ol', {}, history.map((e) =>
        h('li', {},
          e.action === 'validate' ? `✅ Validé par ${e.by}` : `↩️ Remis en attente par ${e.by}`,
          h('span', { class: 'muted' }, ` — ${fmtDate(e.at)}`),
          e.notes && h('div', { class: 'muted' }, e.action === 'reopen' ? `Motif : ${e.notes}` : `Notes : ${e.notes}`),
          e.action === 'validate' && h('div', { class: 'small muted' }, CATS.map(([c]) => (e.tags[c] || []).join(', ')).filter(Boolean).join(' · ')))))));
  }

  if (doc.status === 'validated') {
    const by = h('input', { type: 'text', placeholder: 'Votre nom', maxlength: 100, value: storageGet('validatedBy'), required: true, 'aria-label': 'Votre nom' });
    const reason = h('input', { type: 'text', placeholder: 'Motif (obligatoire)', maxlength: 2000, required: true, 'aria-label': 'Motif' });
    const err = h('div', { class: 'error', role: 'alert' });
    section.append(h('form', { class: 'reopen', onsubmit: async (e) => {
      e.preventDefault();
      const btn = e.submitter;
      if (!by.value.trim() || !reason.value.trim()) { err.textContent = 'Nom et motif obligatoires.'; return; }
      if (!confirm(`Remettre « ${doc.filename} » en attente de validation ?`)) return;
      btn.disabled = true;
      try {
        storageSet('validatedBy', by.value);
        await post(`/api/documents/${doc.documentId}/reopen`, { by: by.value, reason: reason.value });
        flash(`↩️ ${doc.filename} remis en attente`);
        onChange();
        location.hash = '#/a-valider';
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
      }
    } },
      h('h4', {}, 'Remettre en attente'),
      h('div', { class: 'inline' }, by, reason, h('button', { type: 'submit', class: 'secondary' }, '↩️ Remettre en attente')),
      err));
  }
  return section;
}

/* --------------------------------------------------------------- Texte -- */

/** Index de correspondance texte normalisé → texte original (recherche sans accents). */
function normalizedIndex(text) {
  let norm = '';
  const map = [];
  for (let i = 0; i < text.length; i++) {
    const n = normalize(text[i]);
    for (let k = 0; k < n.length; k++) map.push(i);
    norm += n;
  }
  map.push(text.length);
  return { norm, map };
}

function textSection(doc) {
  const text = doc.extractedText || '';
  const pre = h('div', { class: 'fulltext', tabindex: 0, 'aria-label': 'Texte extrait' });
  const input = h('input', { type: 'search', placeholder: 'Rechercher dans le texte (sans tenir compte des accents)…', 'aria-label': 'Rechercher dans le texte' });
  const count = h('span', { class: 'muted', 'aria-live': 'polite' });
  const prevBtn = h('button', { type: 'button', class: 'secondary small', 'aria-label': 'Occurrence précédente' }, '↑');
  const nextBtn = h('button', { type: 'button', class: 'secondary small', 'aria-label': 'Occurrence suivante' }, '↓');
  const idx = normalizedIndex(text);
  let marks = [];
  let current = -1;

  /** Rend le texte : séparateurs de page stylés + occurrences surlignées (nœuds DOM uniquement). */
  function render(term) {
    const ranges = [];
    const t = normalize(term.trim());
    if (t.length >= 2) {
      let p = idx.norm.indexOf(t);
      while (p !== -1 && ranges.length < 2000) {
        ranges.push([idx.map[p], idx.map[p + t.length]]);
        p = idx.norm.indexOf(t, p + t.length);
      }
    }
    const frag = document.createDocumentFragment();
    let r = 0;
    const lineRe = /^--- Page \d+[^\n]*---$/gm;
    const separators = [...text.matchAll(lineRe)].map((m) => [m.index, m.index + m[0].length, m[0]]);
    let pos = 0;
    const pushText = (end) => {
      while (pos < end) {
        while (r < ranges.length && ranges[r][1] <= pos) r++;
        const rg = ranges[r];
        if (rg && rg[0] < end) {
          if (rg[0] > pos) { frag.append(document.createTextNode(text.slice(pos, rg[0]))); pos = rg[0]; }
          const stop = Math.min(rg[1], end);
          frag.append(h('mark', {}, text.slice(pos, stop)));
          pos = stop;
        } else {
          frag.append(document.createTextNode(text.slice(pos, end)));
          pos = end;
        }
      }
    };
    for (const [s, e, label] of separators) {
      pushText(s);
      frag.append(h('span', { class: 'page-sep' }, label.replace(/^--- | ---$/g, '')));
      pos = text[e] === '\n' ? e + 1 : e; // le séparateur est un bloc : pas de ligne vide après
    }
    pushText(text.length);
    pre.replaceChildren(frag);
    marks = [...pre.querySelectorAll('mark')];
    current = -1;
    count.textContent = t.length >= 2 ? `${ranges.length} occurrence(s)` : '';
    if (marks.length) go(0);
  }

  function go(n) {
    if (!marks.length) return;
    marks[current]?.classList.remove('current');
    current = (n + marks.length) % marks.length;
    marks[current].classList.add('current');
    marks[current].scrollIntoView({ block: 'center', behavior: 'smooth' });
    count.textContent = `${current + 1} / ${marks.length} occurrence(s)`;
  }

  input.addEventListener('input', debounce(() => render(input.value), 200));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(current + (e.shiftKey ? -1 : 1)); } });
  prevBtn.addEventListener('click', () => go(current - 1));
  nextBtn.addEventListener('click', () => go(current + 1));
  render('');

  const node = h('section', { class: 'panel wide' },
    h('div', { class: 'section-head' },
      h('h3', {}, 'Texte extrait'),
      h('div', { class: 'inline' },
        copyButton(text, 'Copier le texte'),
        h('a', { class: 'button secondary small', href: `/api/documents/${doc.documentId}/text` }, 'Télécharger .txt'))),
    text ? h('div', { class: 'text-search' }, input, prevBtn, nextBtn, count) : null,
    text ? pre : h('p', { class: 'muted' }, 'Aucun texte extrait.'));

  return {
    node,
    search(term) {
      input.value = term;
      render(term);
      node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
  };
}

/* -------------------------------------------------------------- Images -- */

function imagesSection(doc) {
  const images = doc.images || [];
  return h('section', { class: 'panel wide' },
    h('h3', {}, `Images (${images.length})`),
    images.length
      ? h('div', { class: 'gallery' }, images.map((im, i) => {
          const url = `/api/documents/${doc.documentId}/images/${im.imageId}`;
          const label = describe(im, i, images.length);
          const thumb = h('img', { src: `${url}?size=thumb`, alt: label, loading: 'lazy' });
          const fig = h('figure', {},
            h('button', { type: 'button', class: 'thumb', title: 'Agrandir', onclick: () => openViewer(images, i, doc.documentId) }, thumb),
            h('figcaption', {},
              h('span', {}, [im.page ? `p. ${im.page}` : null, im.width ? `${im.width}×${im.height}` : null, im.origin === 'original' ? 'original' : 'extraite'].filter(Boolean).join(' · ')),
              h('a', { href: `${url}?download=1`, download: '', title: 'Télécharger' }, '⬇')));
          thumb.addEventListener('error', () => fig.replaceChildren(h('div', { class: 'missing' }, 'Fichier image manquant sur le disque')));
          return fig;
        }))
      : h('p', { class: 'muted' }, 'Aucune image extraite de ce document.'));
}
