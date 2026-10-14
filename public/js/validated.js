import { api, CONFIG } from './api.js';
import { CATS, KIND_ICON, copyButton, debounce, fmtDate, fmtSize, h, pct } from './dom.js';

const PAGE_SIZE = 25;
const FILTER_KEYS = ['q', 'tag', 'validatedBy', 'from', 'to', 'page'];

/** Dernière query string de la liste (pour le lien « Retour » de la fiche). */
export let lastListQuery = '';

/** Écran « Validés » : recherche, filtres, pagination. État reflété dans l'URL (#/valides?…). */
export function renderValidated(root, params) {
  const state = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) || '']));

  const q = h('input', { type: 'search', placeholder: 'Rechercher (nom, texte, notes)…', value: state.q, 'aria-label': 'Recherche' });
  const tag = h('select', { 'aria-label': 'Filtrer par tag' },
    h('option', { value: '' }, 'Tous les tags'),
    CATS.map(([cat, label]) => h('optgroup', { label }, (CONFIG.lists[cat] || []).map((v) => h('option', { value: `${cat}:${v}`, selected: state.tag === `${cat}:${v}` }, v)))));
  const by = h('select', { 'aria-label': 'Filtrer par validateur' }, h('option', { value: '' }, 'Tous les validateurs'));
  const from = h('input', { type: 'date', value: state.from, 'aria-label': 'Validé à partir du' });
  const to = h('input', { type: 'date', value: state.to, 'aria-label': "Validé jusqu'au" });
  const reset = h('button', { type: 'button', class: 'secondary' }, 'Réinitialiser');
  const exportCsv = h('a', { class: 'button secondary', href: '/api/export?format=csv' }, 'Exporter la sélection (CSV)');

  const summary = h('p', { class: 'muted summary', 'aria-live': 'polite' });
  const results = h('div', { class: 'rows' });
  const pager = h('nav', { class: 'pager', 'aria-label': 'Pagination' });

  root.replaceChildren(
    h('h2', {}, 'Documents validés'),
    h('form', { class: 'filters', onsubmit: (e) => e.preventDefault() }, q, tag, by, h('label', { class: 'date' }, 'du ', from), h('label', { class: 'date' }, 'au ', to), reset, exportCsv),
    summary,
    results,
    pager,
  );

  /** Paramètres API à partir de l'état. */
  const apiParams = () => {
    const p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.tag) {
      const i = state.tag.indexOf(':');
      p.set('category', state.tag.slice(0, i));
      p.set('tag', state.tag.slice(i + 1));
    }
    if (state.validatedBy) p.set('validatedBy', state.validatedBy);
    if (state.from) p.set('from', state.from);
    if (state.to) p.set('to', state.to);
    return p;
  };

  const syncUrl = () => {
    const p = new URLSearchParams();
    for (const k of FILTER_KEYS) if (state[k] && !(k === 'page' && state[k] === '1')) p.set(k, state[k]);
    lastListQuery = p.toString();
    // replaceState : pas d'entrée d'historique par frappe, pas de re-rendu (hashchange non déclenché)
    history.replaceState(null, '', `#/valides${lastListQuery ? '?' + lastListQuery : ''}`);
  };

  let seq = 0;
  let validatorsLoaded = false;
  async function load() {
    syncUrl();
    const mine = ++seq;
    const page = Math.max(1, Number(state.page) || 1);
    const p = apiParams();
    exportCsv.href = `/api/export?format=csv${p.toString() ? '&' + p : ''}`;
    p.set('limit', PAGE_SIZE);
    p.set('offset', (page - 1) * PAGE_SIZE);
    results.setAttribute('aria-busy', 'true');
    let data;
    try {
      data = await api(`/api/validated?${p}`);
    } catch (err) {
      results.replaceChildren(h('p', { class: 'error' }, err.message));
      return;
    } finally {
      results.removeAttribute('aria-busy');
    }
    if (mine !== seq) return; // une requête plus récente est partie entre-temps

    // validateurs (liste remplie une fois, valeur courante conservée)
    if (!validatorsLoaded) {
      validatorsLoaded = true;
      const known = new Set([...by.options].map((o) => o.value));
      for (const v of data.validators) if (!known.has(v)) by.append(h('option', { value: v, selected: v === state.validatedBy }, v));
    }

    const filtered = FILTER_KEYS.some((k) => k !== 'page' && state[k]);
    const first = data.total ? data.offset + 1 : 0;
    summary.textContent = data.total
      ? `${data.total} document(s) validé(s)${filtered ? ' correspondant aux filtres' : ''} — ${first}–${data.offset + data.items.length}`
      : '';
    results.replaceChildren(
      ...(data.items.length
        ? [header(), ...data.items.map(row)]
        : [h('p', { class: 'muted empty' }, filtered ? 'Aucun résultat pour ces filtres.' : 'Aucun document validé pour le moment.')]),
    );

    const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
    const go = (n) => { state.page = String(n); load(); window.scrollTo({ top: 0 }); };
    pager.replaceChildren(
      ...(pages > 1
        ? [
            h('button', { type: 'button', class: 'secondary', disabled: page <= 1, onclick: () => go(page - 1) }, '← Précédent'),
            h('span', { class: 'muted' }, `Page ${page} / ${pages}`),
            h('button', { type: 'button', class: 'secondary', disabled: page >= pages, onclick: () => go(page + 1) }, 'Suivant →'),
          ]
        : []),
    );
  }

  const onFilter = () => {
    state.q = q.value.trim();
    state.tag = tag.value;
    state.validatedBy = by.value;
    state.from = from.value;
    state.to = to.value;
    state.page = '1';
    load();
  };
  q.addEventListener('input', debounce(onFilter, 300));
  for (const el of [tag, by, from, to]) el.addEventListener('change', onFilter);
  reset.addEventListener('click', () => {
    q.value = tag.value = by.value = from.value = to.value = '';
    onFilter();
  });

  if (state.validatedBy) by.append(h('option', { value: state.validatedBy, selected: true }, state.validatedBy));
  return load();
}

const header = () =>
  h('div', { class: 'row head', 'aria-hidden': 'true' },
    h('span', {}, 'Document'), h('span', {}, 'Tags validés'), h('span', {}, 'Validation'), h('span', {}, 'Infos'));

function row(item) {
  const v = item.validation;
  const href = `#/documents/${item.documentId}`;
  return h('div', { class: 'row', onclick: (e) => { if (!e.target.closest('a,button')) location.hash = href; } },
    h('div', { class: 'cell doc' },
      h('a', { href, class: 'filename' }, `${KIND_ICON[item.kind] || ''} ${item.filename}`),
      h('div', { class: 'id' }, h('code', { title: item.documentId }, item.documentId.slice(0, 8)), copyButton(item.documentId, 'Copier l’id')),
      item.textPreview && h('div', { class: 'excerpt muted' }, item.textPreview.replace(/--- Page \d+[^\n]*---\n?/g, '').slice(0, 120) + '…')),
    h('div', { class: 'cell chips' },
      CATS.map(([cat]) => (v.validatedTags[cat] || []).map((t) => h('span', { class: `chip ${cat}`, title: cat }, t)))),
    h('div', { class: 'cell' },
      h('div', {}, h('strong', {}, v.validatedBy)),
      h('div', { class: 'muted' }, fmtDate(v.validatedAt)),
      v.notes && h('div', { class: 'muted notes', title: v.notes }, `« ${v.notes} »`)),
    h('div', { class: 'cell muted' },
      h('div', {}, `${item.kind.toUpperCase()}${item.pageCount ? ` · ${item.pageCount} p.` : ''} · ${fmtSize(item.fileSize)}`),
      h('div', {}, `${item.imageCount} image(s) · auto ${pct(item.autoConfidence)}`)));
}
