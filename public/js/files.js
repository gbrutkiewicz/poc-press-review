import { api, post } from './api.js';
import { flash, fmtDate, fmtSize, h } from './dom.js';

const LABEL = {
  new: ['Non scanné', 'new'],
  queued: ['En file', 'queued'],
  scanning: ['Scan en cours', 'queued'],
  pending: ['À valider', 'pending'],
  validated: ['Validé', 'validated'],
  error: ['Erreur', 'error'],
  unsupported: ['Format non supporté', 'error'],
};

/** Onglet « Fichiers » : contenu de data/input et statut de scan de chaque fichier. */
export async function renderFiles(root, { onChange }) {
  const body = h('div', { class: 'rows files' }, h('p', { class: 'muted' }, 'Chargement…'));
  const summary = h('p', { class: 'muted summary' });
  const scanAll = h('button', { type: 'button', class: 'secondary' }, 'Scanner les fichiers non scannés');
  root.replaceChildren(h('div', { class: 'section-head' }, h('h2', {}, 'Fichiers déposés'), scanAll), summary, body);

  const load = async () => {
    const data = await api('/api/input');
    const todo = data.items.filter((i) => i.status === 'new').length;
    summary.textContent = `${data.items.length} fichier(s) dans ${data.inputDir}${todo ? ` — ${todo} non scanné(s)` : ''}`;
    scanAll.disabled = !todo;
    body.replaceChildren(...(data.items.length
      ? data.items.map((i) => {
          const [label, cls] = LABEL[i.status] || [i.status, ''];
          const scanBtn = (i.status === 'new' || i.status === 'error') && h('button', { type: 'button', class: 'secondary small', onclick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            btn.textContent = 'Scan en cours…';
            try {
              const r = await post('/api/scan', { filePath: i.name });
              flash(r.duplicate ? `♻️ ${i.name} : déjà scanné` : `📄 ${i.name} scanné`);
            } catch (err) {
              flash(`${i.name} : ${err.message}`, 'err');
            }
            onChange();
            load();
          } }, i.status === 'error' ? 'Rescanner' : 'Scanner');
          return h('div', { class: 'row file-row' },
            h('div', { class: 'cell' }, h('strong', { class: 'break' }, i.name), h('div', { class: 'muted small' }, `${fmtSize(i.size)} · ${fmtDate(i.modifiedAt)}`)),
            h('div', { class: 'cell' }, h('span', { class: `status ${cls}` }, label), i.error && h('div', { class: 'error small' }, i.error)),
            h('div', { class: 'cell actions-cell' }, i.documentId && h('a', { href: `#/documents/${i.documentId}` }, 'Voir la fiche'), scanBtn));
        })
      : [h('p', { class: 'muted empty' }, 'Aucun fichier. Utilisez « Déposer des fichiers » ou glissez-les sur la page.')]));
  };

  scanAll.addEventListener('click', async () => {
    scanAll.disabled = true;
    scanAll.textContent = 'Scan en cours…';
    try {
      const r = await post('/api/scan/input', {});
      const ko = r.results.filter((x) => !x.ok).length;
      flash(`${r.results.filter((x) => x.ok && !x.duplicate).length} scanné(s), ${ko} erreur(s)`, ko ? 'err' : 'ok');
    } catch (err) {
      flash(err.message, 'err');
    }
    scanAll.textContent = 'Scanner les fichiers non scannés';
    onChange();
    load();
  });
  await load();
}
