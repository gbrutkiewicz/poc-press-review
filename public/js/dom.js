// Utilitaires DOM. Règle de sécurité : les données (texte extrait, OCR, noms de
// fichiers…) ne passent JAMAIS par innerHTML — uniquement textContent / nœuds.

/** Crée un élément : h('a', { href: '#', class: 'x', onclick: fn }, 'texte', autreNoeud) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

export function fmtSize(bytes) {
  if (bytes == null) return '—';
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} Ko` : `${(bytes / 1048576).toFixed(1)} Mo`;
}

export const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)} %`);

export function debounce(fn, ms = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function flash(msg, kind = 'ok') {
  const el = $('#flash');
  el.textContent = msg;
  el.className = kind;
  el.hidden = false;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => (el.hidden = true), kind === 'err' ? 10000 : 5000);
}

/** Copie dans le presse-papiers (fallback execCommand si l'API est indisponible). */
export async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  if (button) {
    const label = button.textContent;
    button.textContent = 'Copié ✓';
    setTimeout(() => (button.textContent = label), 1500);
  }
}

/** Bouton « Copier » associé à une valeur. */
export const copyButton = (value, label = 'Copier', title = 'Copier dans le presse-papiers') =>
  h('button', { type: 'button', class: 'copy', title, onclick: (e) => { e.preventDefault(); e.stopPropagation(); copyText(value, e.currentTarget); } }, label);

export function storageGet(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } }
export function storageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

/** Normalisation identique au serveur : minuscules, sans accents. */
export const normalize = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export const KIND_ICON = { pdf: '📕', docx: '📘', image: '🖼️' };
export const CATS = [['sources', 'Sources'], ['regions', 'Régions'], ['themes', 'Thèmes'], ['products', 'Produits']];
