import path from 'node:path';
import fs from 'node:fs';
import { createApp } from './app.js';
import { config, rel } from './config/env.js';
import { shutdownOcr } from './services/ocr.js';
import { scanFile } from './services/scanner.js';
import { closeDb, getDb, stats } from './services/storage.js';
import { isOllamaAvailable } from './services/tagging.js';
import { log } from './utils/logger.js';

const app = createApp();

/* -------------------------------------------------------------- watcher -- */

async function startWatcher(): Promise<{ close: () => Promise<void> } | null> {
  if (!config.watch) return null;
  try {
    const { default: chokidar } = await import('chokidar');
    const queue: string[] = [];
    let busy = false;
    const drain = async () => {
      if (busy) return;
      busy = true;
      while (queue.length) {
        const file = queue.shift()!;
        try {
          await scanFile(file);
        } catch (err) {
          log.error(`Watcher : ${path.basename(file)}`, err);
        }
      }
      busy = false;
    };
    const watcher = chokidar.watch(config.inputDir, {
      ignoreInitial: true,
      depth: 0,
      ignored: (p: string) => path.basename(p).startsWith('.'),
      awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
    });
    watcher.on('add', (file: string) => {
      log.info(`👀 Nouveau fichier : ${path.basename(file)}`);
      queue.push(file);
      void drain();
    });
    return watcher;
  } catch {
    log.warn('chokidar non installé : surveillance désactivée');
    return null;
  }
}

/* ---------------------------------------------------------------- start -- */

async function main() {
  fs.mkdirSync(config.inputDir, { recursive: true });
  getDb(); // migrations auto

  const server = app.listen(config.port, config.host, () => {
    const host = config.host === '127.0.0.1' || config.host === '0.0.0.0' ? 'localhost' : config.host;
    log.info(`🚀 Agent running on http://${host}:${config.port}`);
  });
  server.on('error', (err) => {
    log.error(`Impossible d'écouter sur ${config.host}:${config.port}`, err);
    process.exit(1);
  });

  const watcher = await startWatcher();
  log.info(watcher ? `📁 Watching: ${rel(config.inputDir)}` : `📁 Input: ${rel(config.inputDir)} (surveillance désactivée)`);
  log.info(`💾 Database: ${rel(config.dbPath)}`);
  const s = stats();
  log.info(`📊 ${s.pending} en attente, ${s.validated} validé(s), ${s.error} en erreur`);
  if (config.ollama.mode !== 'off') {
    void isOllamaAvailable().then((ok) =>
      log.info(ok ? `🤖 Ollama disponible (${config.ollama.model})` : '🤖 Ollama absent → tagging par mots-clés uniquement'),
    );
  }

  const shutdown = async () => {
    log.info('Arrêt…');
    server.close();
    await watcher?.close();
    await shutdownOcr();
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log.error('Démarrage impossible', err);
  process.exit(1);
});
