import { api, post, CONFIG } from './api.js';
import { CATS, KIND_ICON, fmtDate, flash, h, pct, storageGet, storageSet } from './dom.js';

/** Écran « À valider » : une carte par document en attente. */
export async function renderPending(root, { onChange }) {
  const list = h('div', { class: 'cards' }, h('p', { class: 'muted' }, 'Chargement…'));
  const count = h('span', { class: 'muted' });
  root.replaceChildren(h('h2', {}, 'En attente de validation ', count), list);

  const docs = await api('/api/validations/pending');
  const update = () => {
    const n = list.querySelectorAll('.card').length;
    count.textContent = `(${n})`;
    if (!n) list.replaceChildren(h('p', { class: 'muted empty' }, 'Aucun document en attente. Déposez des fichiers dans ', h('code', {}, CONFIG.inputDir), ' puis lancez un scan.'));
  };
  list.replaceChildren(...docs.map((d) => card(d, () => { update(); onChange(); })));
  update();
}

function card(doc, onValidated) {
  const t = doc.tagging;
  const threshold = CONFIG.reviewThreshold;
  const ocr = doc.ocr?.used ? ` · OCR ${pct(doc.ocr.confidence)}` : '';
  const reasons = [...(t?.reviewReasons || []), ...(doc.warnings || [])];

  const fieldsets = CATS.map(([cat, label]) => {
    const proposed = new Map((t?.tags[cat] || []).map((x) => [x.value, x]));
    const checked = new Set(doc.preselected?.[cat] || []);
    return h('fieldset', { dataset: { cat } }, h('legend', {}, label),
      (CONFIG.lists[cat] || []).map((value) => {
        const p = proposed.get(value);
        return h('label', { class: `tag${p ? ' proposed' : ''}` },
          h('input', { type: 'checkbox', value, checked: checked.has(value) }),
          value,
          p && h('span', { class: `score${p.confidence < threshold ? ' low' : ''}`, title: `${p.origin}${p.matches.length ? ' : ' + p.matches.join(', ') : ''}` }, pct(p.confidence)));
      }));
  });

  const by = h('input', { class: 'by', type: 'text', placeholder: 'Validé par (nom)', maxlength: 100, value: storageGet('validatedBy') });
  const notes = h('input', { class: 'notes', type: 'text', placeholder: 'Notes (optionnel)', maxlength: 2000 });
  const error = h('div', { class: 'error', role: 'alert' });

  const node = h('article', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', {},
        h('h3', {}, h('a', { href: `#/documents/${doc.documentId}`, title: 'Voir la fiche complète' }, `${KIND_ICON[doc.kind] || ''} ${doc.filename}`)),
        h('div', { class: 'meta muted' }, `${doc.kind.toUpperCase()}${doc.pageCount ? ` · ${doc.pageCount} p.` : ''} · ${doc.textLength} car. · ${doc.imageCount} image(s)${ocr} · ${fmtDate(doc.createdAt)}`)),
      h('div', { class: `conf ${t && t.confidence >= threshold ? 'high' : 'low'}` }, t ? `Confiance ${pct(t.confidence)}` : '')),
    doc.reopened && h('div', { class: 'reopened' }, `↩️ Remis en attente par ${doc.reopened.by} le ${fmtDate(doc.reopened.at)} — ${doc.reopened.reason}. Les derniers tags validés sont pré-cochés.`),
    reasons.length ? h('div', { class: 'reasons' }, `⚠️ ${reasons.join(' · ')}`) : null,
    h('p', { class: 'preview' }, doc.textPreview || '(aucun texte extrait)'),
    h('div', { class: 'tags' }, fieldsets),
    h('div', { class: 'actions' }, by, notes,
      h('button', { type: 'button', class: 'validate', onclick: async (ev) => {
        const btn = ev.currentTarget;
        const tags = {};
        for (const fs of node.querySelectorAll('fieldset')) tags[fs.dataset.cat] = [...fs.querySelectorAll('input:checked')].map((c) => c.value);
        btn.disabled = true;
        error.textContent = '';
        try {
          storageSet('validatedBy', by.value);
          await post('/api/validations/save', { documentId: doc.documentId, tags, validatedBy: by.value, notes: notes.value });
          flash(`✅ ${doc.filename} validé`);
          node.remove();
          onValidated();
        } catch (err) {
          error.textContent = err.message;
          btn.disabled = false;
        }
      } }, '✅ Valider')),
    error);
  return node;
}
