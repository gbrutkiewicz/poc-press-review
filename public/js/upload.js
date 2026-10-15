import { CONFIG } from './api.js';
import { $, fmtSize, h, storageGet, storageSet } from './dom.js';

/**
 * Dépôt de fichiers dans data/input : bouton, glisser-déposer, collage d'une
 * capture (Cmd/Ctrl+V). Un fichier par requête (corps brut), 3 envois en
 * parallèle ; le scan reste séquentiel côté serveur.
 */
const PARALLEL = 3;
const jobs = [];
let active = 0;
let onScanned = () => {};

const panel = h('section', { class: 'uploads', hidden: true, 'aria-label': 'Envois de fichiers' });
const list = h('ul', { class: 'upload-list', 'aria-live': 'polite' });
const title = h('strong', {});
const toggle = h('button', { type: 'button', class: 'secondary small', 'aria-expanded': 'true' }, 'Replier');
const clear = h('button', { type: 'button', class: 'secondary small' }, 'Effacer la liste');
const overlay = h('div', { class: 'drop-overlay', hidden: true }, h('div', {}, 'Déposez vos fichiers ici'));

export function initUpload({ onChange }) {
  onScanned = onChange;
  const input = h('input', { type: 'file', multiple: true, hidden: true, accept: CONFIG.extensions.join(',') });
  input.addEventListener('change', () => {
    addFiles([...input.files]);
    input.value = '';
  });
  const auto = h('input', { type: 'checkbox', id: 'auto-scan', checked: storageGet('autoScan') !== '0' });
  auto.addEventListener('change', () => storageSet('autoScan', auto.checked ? '1' : '0'));

  $('#upload-slot').replaceWith(
    h('div', { class: 'upload-controls' },
      h('button', { type: 'button', onclick: () => input.click() }, '⬆ Déposer des fichiers'),
      h('label', { class: 'auto', for: 'auto-scan' }, auto, ' Scanner automatiquement'),
      input));

  toggle.addEventListener('click', () => {
    const open = list.hidden;
    list.hidden = !open;
    toggle.textContent = open ? 'Replier' : 'Déplier';
    toggle.setAttribute('aria-expanded', String(open));
  });
  clear.addEventListener('click', () => {
    for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].done) { jobs[i].row.remove(); jobs.splice(i, 1); }
    refreshPanel();
  });
  panel.append(h('div', { class: 'upload-head' }, title, h('span', { class: 'spacer' }), toggle, clear), list);
  $('#flash').after(panel);
  document.body.append(overlay);

  // Glisser-déposer n'importe où sur la page
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  document.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; overlay.hidden = false; });
  document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) overlay.hidden = true; });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    addFiles([...e.dataTransfer.files]);
  });

  // Coller une capture d'écran (le collage de texte dans les champs n'est pas affecté)
  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    addFiles(files.map((f, i) => new File([f], `capture-${stamp}${files.length > 1 ? `-${i + 1}` : ''}.${f.type === 'image/jpeg' ? 'jpg' : 'png'}`, { type: f.type })));
  });
}

function addFiles(files) {
  if (!files.length) return;
  panel.hidden = false;
  list.hidden = false;
  const autoScan = $('#auto-scan')?.checked !== false;
  for (const file of files) {
    const job = { file, autoScan, done: false, xhr: null };
    job.bar = h('progress', { max: 100, value: 0 });
    job.status = h('span', { class: 'upload-status' }, 'En attente');
    job.action = h('span', { class: 'upload-action' },
      h('button', { type: 'button', class: 'secondary small', onclick: () => cancel(job) }, 'Annuler'));
    job.row = h('li', {}, h('span', { class: 'upload-name', title: file.name }, file.name), h('span', { class: 'muted' }, fmtSize(file.size)), job.bar, job.status, job.action);
    list.append(job.row);
    jobs.push(job);

    // contrôles immédiats (le serveur refait tous les contrôles)
    const ext = (file.name.match(/\.[^.]+$/)?.[0] || '').toLowerCase();
    if (!CONFIG.extensions.includes(ext)) finish(job, 'err', `Format non supporté (${ext || 'sans extension'})`);
    else if (file.size > CONFIG.maxFileSizeMb * 1048576) finish(job, 'err', `Trop volumineux (max ${CONFIG.maxFileSizeMb} Mo)`);
    else if (!file.size) finish(job, 'err', 'Fichier vide');
  }
  refreshPanel();
  pump();
}

function pump() {
  while (active < PARALLEL) {
    const job = jobs.find((j) => !j.done && !j.xhr);
    if (!job) break;
    start(job);
  }
  refreshPanel();
}

function start(job) {
  active++;
  const xhr = new XMLHttpRequest();
  job.xhr = xhr;
  xhr.open('POST', `/api/upload?filename=${encodeURIComponent(job.file.name)}&scan=${job.autoScan ? 1 : 0}`);
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  xhr.responseType = 'json';
  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    const p = Math.round((e.loaded / e.total) * 100);
    job.bar.value = p;
    job.status.textContent = `Envoi ${p} %`;
  };
  xhr.upload.onload = () => {
    job.bar.value = 100;
    job.status.textContent = job.autoScan ? 'Scan en cours…' : 'Enregistrement…';
    job.action.replaceChildren(); // plus d'annulation possible une fois envoyé
  };
  xhr.onload = () => {
    const r = xhr.response || {};
    if (xhr.status >= 400 || !r.success) return finish(job, 'err', r.error || `Erreur HTTP ${xhr.status}`);
    const renamed = r.file.savedAs !== r.file.name ? ` (enregistré sous « ${r.file.savedAs} »)` : '';
    if (r.scanError) return finish(job, 'err', `Enregistré${renamed}, mais le scan a échoué : ${r.scanError.error}`, '#/erreurs', 'Voir les erreurs');
    if (!job.autoScan) return finish(job, 'ok', `Enregistré${renamed} — non scanné`, '#/fichiers', 'Voir les fichiers');
    if (r.duplicate) return finish(job, 'dup', `♻️ Déjà présent${renamed}`, r.documentId && `#/documents/${r.documentId}`, 'Voir le document');
    finish(job, 'ok', `✅ Scanné${renamed} — ${r.scan?.extraction?.textLength ?? 0} car.`, `#/documents/${r.documentId}`, 'Voir la fiche');
    job.scanned = true;
  };
  xhr.onerror = () => finish(job, 'err', 'Serveur injoignable');
  xhr.onabort = () => finish(job, 'err', 'Annulé');
  xhr.send(job.file);
}

function cancel(job) {
  if (job.xhr) job.xhr.abort();
  else finish(job, 'err', 'Annulé');
}

function finish(job, kind, message, href, linkLabel) {
  if (job.done) return;
  job.done = true;
  if (job.xhr) active--;
  job.row.className = kind;
  job.bar.hidden = true;
  job.status.textContent = message;
  job.action.replaceChildren(href ? h('a', { href }, linkLabel) : '');
  refreshPanel();
  pump();
  if (jobs.every((j) => j.done)) onScanned({ anyScanned: jobs.some((j) => j.scanned) });
  else onScanned({ partial: true });
}

function refreshPanel() {
  const total = jobs.length;
  const done = jobs.filter((j) => j.done).length;
  panel.hidden = total === 0;
  title.textContent = done === total ? `Envois terminés (${total})` : `Envois : ${done} / ${total} terminés`;
  clear.disabled = done === 0;
}
