import { h } from './dom.js';

/**
 * Visionneuse plein écran : image originale, précédente/suivante,
 * Échap pour fermer, ← → pour naviguer, focus restauré à la fermeture.
 */
export function openViewer(images, index, documentId) {
  const opener = document.activeElement;
  let i = index;

  const img = h('img', { alt: '' });
  const caption = h('div', { class: 'viewer-caption' });
  const download = h('a', { class: 'button secondary', download: '' }, 'Télécharger');
  const prev = h('button', { type: 'button', class: 'nav prev', 'aria-label': 'Image précédente', onclick: () => show(i - 1) }, '‹');
  const next = h('button', { type: 'button', class: 'nav next', 'aria-label': 'Image suivante', onclick: () => show(i + 1) }, '›');
  const close = h('button', { type: 'button', class: 'close', 'aria-label': 'Fermer', onclick: () => destroy() }, '✕');

  const overlay = h('div', { class: 'viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Visionneuse d’images',
    onclick: (e) => { if (e.target === overlay) destroy(); } },
    close, prev, h('figure', {}, img, h('figcaption', {}, caption, download)), next);

  function show(n) {
    i = (n + images.length) % images.length;
    const im = images[i];
    const url = `/api/documents/${documentId}/images/${im.imageId}`;
    img.src = url;
    img.alt = describe(im, i, images.length);
    caption.textContent = describe(im, i, images.length);
    download.href = `${url}?download=1`;
    prev.hidden = next.hidden = images.length < 2;
  }

  function onKey(e) {
    if (e.key === 'Escape') destroy();
    else if (e.key === 'ArrowLeft') show(i - 1);
    else if (e.key === 'ArrowRight') show(i + 1);
    else if (e.key === 'Tab') {
      // piège à focus : on reste dans la visionneuse
      const items = [...overlay.querySelectorAll('button:not([hidden]), a')];
      const idx = items.indexOf(document.activeElement);
      e.preventDefault();
      items[(idx + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus();
    }
  }

  function destroy() {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('hashchange', destroy);
    overlay.remove();
    document.body.classList.remove('no-scroll');
    opener?.focus?.();
  }

  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', destroy);
  document.body.classList.add('no-scroll');
  document.body.append(overlay);
  show(i);
  close.focus();
}

export function describe(im, i, n) {
  return [
    `Image ${i + 1}/${n}`,
    im.page ? `page ${im.page}` : null,
    im.width && im.height ? `${im.width}×${im.height}px` : null,
    im.origin === 'original' ? 'fichier d’origine' : 'extraite du document',
  ].filter(Boolean).join(' · ');
}
