import { api, post } from './api.js';
import { KIND_ICON, fmtDate, flash, h } from './dom.js';

/** Écran « Erreurs » : documents dont l'extraction a échoué, avec rescan. */
export async function renderErrors(root, { onChange }) {
  const list = h('div', { class: 'cards' }, h('p', { class: 'muted' }, 'Chargement…'));
  root.replaceChildren(h('h2', {}, 'Documents en erreur'), list);
  const docs = await api('/api/documents?status=error');
  if (!docs.length) {
    list.replaceChildren(h('p', { class: 'muted empty' }, 'Aucun document en erreur.'));
    return;
  }
  list.replaceChildren(...docs.map((d) => {
    const err = h('div', { class: 'error', role: 'alert' });
    const node = h('article', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', {},
          h('h3', {}, h('a', { href: `#/documents/${d.documentId}` }, `${KIND_ICON[d.kind] || ''} ${d.filename}`)),
          h('div', { class: 'meta muted break' }, `${d.filePath} · ${fmtDate(d.createdAt)}`)),
        h('button', { type: 'button', class: 'secondary', onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          btn.textContent = 'Scan en cours…';
          try {
            const r = await post('/api/scan', { filePath: d.filePath });
            flash(`📄 ${d.filename} rescanné (${r.extraction?.textLength ?? 0} car.)`);
            node.remove();
            onChange();
          } catch (ex) {
            err.textContent = ex.message;
            btn.disabled = false;
            btn.textContent = 'Rescanner';
          }
        } }, 'Rescanner')),
      h('p', { class: 'error' }, d.error || 'Erreur inconnue'),
      err);
    return node;
  }));
}
