// Rebuilds the index whenever something on a shelf changes.

import fs from 'node:fs';
import path from 'node:path';
import { build } from './build.js';
import { defaultDbPath, loadConfig } from './walk.js';

export function watchAndBuild(root, { dbPath, onBuild = () => {}, onError = () => {}, debounceMs = 300 } = {}) {
  root = path.resolve(root);
  dbPath = path.resolve(dbPath ?? defaultDbPath(root));
  onBuild(build(root, { dbPath }));

  let timer = null;
  const watcher = fs.watch(root, { recursive: true }, (_event, name) => {
    if (!name) return;
    const file = name.toString();
    const abs = path.join(root, file);
    if (abs.startsWith(dbPath)) return;
    const ignore = new Set(loadConfig(root).ignore);
    if (file.split(path.sep).some((part) => ignore.has(part))) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        onBuild(build(root, { dbPath }));
      } catch (err) {
        onError(err);
      }
    }, debounceMs);
  });
  return {
    close() {
      clearTimeout(timer);
      watcher.close();
    },
  };
}
