const ts = () => new Date().toISOString().slice(11, 19);

export const log = {
  info: (msg: string) => console.log(`[${ts()}] ${msg}`),
  warn: (msg: string) => console.warn(`[${ts()}] ⚠️  ${msg}`),
  error: (msg: string, err?: unknown) =>
    console.error(`[${ts()}] ❌ ${msg}${err ? ` — ${err instanceof Error ? err.message : String(err)}` : ''}`),
};
