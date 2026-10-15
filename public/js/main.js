import { api, loadConfig, post, CONFIG } from './api.js';
import { $, flash, h } from './dom.js';
import { renderPending } from './pending.js';
import { renderValidated } from './validated.js';
import { renderDocument } from './document.js';
import { renderErrors } from './errors.js';
import { renderFiles } from './files.js';
import { initUpload } from './upload.js';

/**
 * Routeur par hash :
 *   #/a-valider (défaut) · #/valides?filtres · #/documents/{id} · #/fichiers · #/erreurs
 */
const view = $('#view');
const tabs = { pending: $('#tab-pending'), validated: $('#tab-validated'), files: $('#tab-files'), errors: $('#tab-errors') };

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/a-valider';
  const [path, qs = ''] = raw.split('?');
  return { path, params: new URLSearchParams(qs) };
}

async function refreshStats() {
  try {
    const { stats, ollama } = await api('/api/health');
    $('#count-pending').textContent = stats.pending;
    $('#count-validated').textContent = stats.validated;
    $('#count-errors').textContent = stats.error;
    tabs.errors.hidden = stats.error === 0 && !location.hash.startsWith('#/erreurs');
    $('#stats').textContent = `${stats.images} image(s) · Ollama : ${ollama}`;
    const input = await api('/api/input');
    const todo = input.items.filter((i) => i.status === 'new').length;
    $('#count-files').textContent = todo ? `${todo} à scanner` : input.items.length;
    $('#count-files').classList.toggle('alert', todo > 0);
  } catch { /* serveur arrêté */ }
}

function setTab(active) {
  for (const [name, el] of Object.entries(tabs)) {
    el.setAttribute('aria-selected', String(name === active));
    el.classList.toggle('active', name === active);
  }
}

let renderSeq = 0;
async function route() {
  const seq = ++renderSeq;
  const { path, params } = parseHash();
  const ctx = { onChange: refreshStats };
  const doc = path.match(/^\/documents\/([^/]+)$/);
  try {
    if (doc) {
      setTab(null);
      await renderDocument(view, decodeURIComponent(doc[1]), ctx);
    } else if (path === '/valides') {
      setTab('validated');
      await renderValidated(view, params);
    } else if (path === '/fichiers') {
      setTab('files');
      await renderFiles(view, ctx);
    } else if (path === '/erreurs') {
      setTab('errors');
      await renderErrors(view, ctx);
    } else {
      if (path !== '/a-valider') history.replaceState(null, '', '#/a-valider');
      setTab('pending');
      await renderPending(view, ctx);
    }
  } catch (err) {
    if (seq === renderSeq) view.replaceChildren(h('p', { class: 'error' }, err.message));
  }
  refreshStats();
  if (!doc) window.scrollTo({ top: 0 });
}

/* ------------------------------------------------- barre d'outils (scan) -- */

async function withBusy(btn, fn) {
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Scan en cours…';
  try { await fn(); } catch (err) { flash(err.message, 'err'); } finally { btn.disabled = false; btn.textContent = label; }
}

$('#scan-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const filePath = $('#scan-path').value.trim();
  if (!filePath) return;
  withBusy($('#scan-form button'), async () => {
    const r = await post('/api/scan', { filePath });
    flash(r.duplicate ? `♻️ Déjà scanné (${r.documentId})` : `📄 Scanné : ${r.extraction.textLength} car., ${r.extraction.imageCount} image(s)`);
    location.hash === '#/a-valider' ? route() : (location.hash = '#/a-valider');
  });
});

$('#scan-input').addEventListener('click', (e) =>
  withBusy(e.currentTarget, async () => {
    const r = await post('/api/scan/input', {});
    const ok = r.results.filter((x) => x.ok && !x.duplicate).length;
    const dup = r.results.filter((x) => x.duplicate).length;
    const ko = r.results.filter((x) => !x.ok);
    flash(`${ok} nouveau(x), ${dup} déjà scanné(s), ${ko.length} erreur(s)${ko.length ? '\n' + ko.map((x) => `${x.file} : ${x.error}`).join('\n') : ''}`, ko.length ? 'err' : 'ok');
    location.hash === '#/a-valider' ? route() : (location.hash = '#/a-valider');
  }),
);

window.addEventListener('hashchange', route);

(async () => {
  try {
    await loadConfig();
    $('#input-dir').textContent = CONFIG.inputDir;
    initUpload({
      onChange: ({ partial, anyScanned }) => {
        const { path } = parseHash();
        // fin d'un lot : on rafraîchit la vue si elle affiche les fichiers ou les documents à valider
        if (path === '/fichiers' || (!partial && anyScanned && path === '/a-valider')) route();
        else refreshStats();
      },
    });
    await route();
  } catch (err) {
    flash(`Serveur injoignable : ${err.message}`, 'err');
  }
})();
