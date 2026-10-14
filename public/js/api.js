export async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error([body.error || `HTTP ${res.status}`, ...(body.details || [])].join('\n'));
  return body;
}

export const post = (url, data) => api(url, { method: 'POST', body: JSON.stringify(data ?? {}) });

/** Configuration (listes fermées, seuil) chargée une fois au démarrage. */
export const CONFIG = { lists: {}, reviewThreshold: 0.6, inputDir: 'data/input' };

export async function loadConfig() {
  Object.assign(CONFIG, await api('/api/config/tags'));
}
