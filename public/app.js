// UI minimale de validation — aucune dépendance, aucune ressource externe.
const $ = (sel, root = document) => root.querySelector(sel);
const CATS = [['sources', 'Sources'], ['regions', 'Régions'], ['themes', 'Thèmes'], ['products', 'Produits']];
let LISTS = {};
let THRESHOLD = 0.6;

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error([body.error || `HTTP ${res.status}`, ...(body.details || [])].join('\n'));
  return body;
}

function flash(msg, kind = 'ok') {
  const el = $('#flash');
  el.textContent = msg;
  el.className = kind;
  el.hidden = false;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => (el.hidden = true), kind === 'err' ? 10000 : 5000);
}

async function refreshStats() {
  try {
    const h = await api('/api/health');
    $('#stats').textContent = `${h.stats.pending} en attente · ${h.stats.validated} validé(s) · ${h.stats.error} en erreur · ${h.stats.images} image(s) · Ollama : ${h.ollama}`;
  } catch { /* serveur arrêté */ }
}

function renderCard(doc) {
  const node = $('#card-tpl').content.firstElementChild.cloneNode(true);
  const t = doc.tagging;
  $('.filename', node).textContent = doc.filename;
  const ocr = doc.ocr && doc.ocr.used ? ` · OCR ${Math.round((doc.ocr.confidence || 0) * 100)}%` : '';
  $('.meta', node).textContent = `${doc.kind.toUpperCase()}${doc.pageCount ? ` · ${doc.pageCount} p.` : ''} · ${doc.textLength} car. · ${doc.imageCount} image(s)${ocr} · ${new Date(doc.createdAt).toLocaleString('fr-FR')}`;
  const conf = $('.conf', node);
  conf.textContent = t ? `Confiance ${Math.round(t.confidence * 100)}%` : '';
  conf.classList.add(t && t.confidence >= THRESHOLD ? 'high' : 'low');
  const reasons = [...(t?.reviewReasons || []), ...(doc.warnings || [])];
  $('.reasons', node).textContent = reasons.length ? `⚠️ ${reasons.join(' · ')}` : '';
  $('.preview', node).textContent = doc.textPreview || '(aucun texte extrait)';

  // Texte complet + vignettes chargés à l'ouverture
  $('details', node).addEventListener('toggle', async (e) => {
    if (!e.target.open || e.target.dataset.loaded) return;
    e.target.dataset.loaded = '1';
    const full = await api(`/api/documents/${doc.documentId}`);
    $('pre', node).textContent = full.extractedText;
    for (const img of full.images || []) {
      const a = document.createElement('a');
      a.href = `/api/documents/${doc.documentId}/images/${img.imageId}`;
      a.target = '_blank';
      const i = document.createElement('img');
      i.src = a.href;
      i.alt = `image${img.page ? ` page ${img.page}` : ''}`;
      i.loading = 'lazy';
      a.append(i);
      $('.thumbs', node).append(a);
    }
  });

  // Tags : toutes les valeurs des listes fermées, propositions pré-cochées
  const tagsEl = $('.tags', node);
  for (const [cat, label] of CATS) {
    const proposed = new Map((t?.tags[cat] || []).map((x) => [x.value, x]));
    const fs = document.createElement('fieldset');
    fs.dataset.cat = cat;
    fs.innerHTML = `<legend></legend>`;
    $('legend', fs).textContent = label;
    for (const value of LISTS[cat] || []) {
      const p = proposed.get(value);
      const l = document.createElement('label');
      l.className = `tag${p ? ' proposed' : ''}`;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = value;
      // Pré-coché : meilleure proposition de la catégorie, ou toute proposition ≥ 50 %
      const top = (t?.tags[cat] || [])[0];
      cb.checked = !!p && (p === top || p.confidence >= 0.5);
      l.append(cb, document.createTextNode(value));
      if (p) {
        const s = document.createElement('span');
        s.className = `score${p.confidence < THRESHOLD ? ' low' : ''}`;
        s.textContent = `${Math.round(p.confidence * 100)}%`;
        s.title = `${p.origin}${p.matches.length ? ' : ' + p.matches.join(', ') : ''}`;
        l.append(s);
      }
      fs.append(l);
    }
    tagsEl.append(fs);
  }

  const by = $('.by', node);
  by.value = localStorageGet('validatedBy');
  $('.validate', node).addEventListener('click', async (ev) => {
    const tags = {};
    for (const fs of node.querySelectorAll('fieldset')) {
      tags[fs.dataset.cat] = [...fs.querySelectorAll('input:checked')].map((c) => c.value);
    }
    ev.target.disabled = true;
    $('.error', node).textContent = '';
    try {
      localStorageSet('validatedBy', by.value);
      await api('/api/validations/save', {
        method: 'POST',
        body: JSON.stringify({ documentId: doc.documentId, tags, validatedBy: by.value, notes: $('.notes', node).value }),
      });
      flash(`✅ ${doc.filename} validé`);
      node.remove();
      updateCount();
      refreshStats();
    } catch (err) {
      $('.error', node).textContent = err.message;
      ev.target.disabled = false;
    }
  });
  return node;
}

function updateCount() {
  const n = document.querySelectorAll('#pending .card').length;
  $('#count').textContent = `(${n})`;
  if (!n) $('#pending').innerHTML = '<p class="muted">Aucun document en attente. Déposez des fichiers dans data/input puis lancez un scan.</p>';
}

async function loadPending() {
  const docs = await api('/api/validations/pending');
  const root = $('#pending');
  root.innerHTML = '';
  for (const d of docs) root.append(renderCard(d));
  updateCount();
  refreshStats();
}

function localStorageGet(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

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
    const r = await api('/api/scan', { method: 'POST', body: JSON.stringify({ filePath }) });
    flash(r.duplicate ? `♻️ Déjà scanné (${r.documentId})` : `📄 Scanné : ${r.extraction.textLength} car., ${r.extraction.imageCount} image(s)`);
    await loadPending();
  });
});

$('#scan-input').addEventListener('click', (e) =>
  withBusy(e.currentTarget, async () => {
    const r = await api('/api/scan/input', { method: 'POST', body: '{}' });
    const ok = r.results.filter((x) => x.ok && !x.duplicate).length;
    const dup = r.results.filter((x) => x.duplicate).length;
    const ko = r.results.filter((x) => !x.ok);
    flash(`${ok} nouveau(x), ${dup} déjà scanné(s), ${ko.length} erreur(s)${ko.length ? '\n' + ko.map((x) => `${x.file} : ${x.error}`).join('\n') : ''}`, ko.length ? 'err' : 'ok');
    await loadPending();
  }),
);

(async () => {
  try {
    const cfg = await api('/api/config/tags');
    LISTS = cfg.lists;
    THRESHOLD = cfg.reviewThreshold;
    $('#input-dir').textContent = cfg.inputDir;
    await loadPending();
  } catch (err) {
    flash(`Serveur injoignable : ${err.message}`, 'err');
  }
})();
