// Walks the Context Environment, shelf by shelf, and fingerprints what it finds.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const TOOL_VERSION = '0.1.0';

export const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp', '.tif', '.tiff',
  '.mp4', '.webm', '.mov', '.mp3', '.wav', '.ogg', '.m4a',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pdf', '.zip', '.gz', '.pptx', '.key', '.docx', '.xlsx', '.psd', '.ai', '.sketch', '.fig',
]);

export const LANGUAGES = {
  '.html': 'html', '.htm': 'html', '.shtml': 'html',
  '.css': 'css',
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js', '.ts': 'js', '.tsx': 'js',
  '.md': 'md', '.markdown': 'md',
  '.svg': 'svg',
  '.json': 'json',
  '.txt': 'text', '.xml': 'text', '.yml': 'text', '.yaml': 'text', '.py': 'text',
};

export const DEFAULT_CONFIG = {
  name: null,
  shelves: [{ path: '.', kind: 'auto' }],
  ignore: ['.git', 'node_modules', '.stockroom', '.DS_Store'],
  maxFileBytes: 256 * 1024,
  secretPatterns: [
    '-----BEGIN [A-Z ]*PRIVATE KEY-----',
    'AKIA[0-9A-Z]{16}',
    'gh[pousr]_[A-Za-z0-9]{30,}',
    'xox[baprs]-[A-Za-z0-9-]{10,}',
    '(?:api[_-]?key|secret|password|access[_-]?token)\\s*[:=]\\s*[\'"][^\'"\\s]{16,}[\'"]',
  ],
};

export function loadConfig(root) {
  const file = path.join(root, 'stockroom.json');
  let text = '';
  let user = {};
  if (fs.existsSync(file)) {
    text = fs.readFileSync(file, 'utf8');
    user = JSON.parse(text);
  }
  const config = { ...DEFAULT_CONFIG, ...user };
  config.ignore = [...new Set([...DEFAULT_CONFIG.ignore, ...(user.ignore || [])])];
  config.shelves = config.shelves.map((shelf) => ({
    kind: 'auto',
    for: [],
    ...shelf,
    path: toPosix(path.normalize(shelf.path)).replace(/\/$/, '') || '.',
  }));
  config.secrets = config.secretPatterns.map((p) => new RegExp(p, 'i'));
  config.text = text;
  return config;
}

export function toPosix(p) {
  return p.split(path.sep).join('/');
}

export function defaultDbPath(root) {
  return path.join(root, '.stockroom', 'context.db');
}

// Yields every file on every shelf, in a stable order. A file that sits on two
// shelves belongs to the first one listed.
export function* walk(root, config, { exclude = null } = {}) {
  const seen = new Set();
  const ignore = new Set(config.ignore);
  for (const shelf of config.shelves) {
    const start = path.join(root, shelf.path);
    if (!fs.existsSync(start)) continue;
    const stack = [start];
    while (stack.length) {
      const dir = stack.pop();
      const entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => !ignore.has(e.name))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      const dirs = [];
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          dirs.push(abs);
        } else if (entry.isFile()) {
          const rel = toPosix(path.relative(root, abs));
          if (seen.has(rel) || rel === 'stockroom.json') continue;
          if (exclude && abs.startsWith(exclude)) continue;
          seen.add(rel);
          yield { rel, abs, shelf };
        }
      }
      stack.push(...dirs.reverse());
    }
  }
}

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Cheap fingerprint from sizes and modification times. If this matches what the
// index recorded, nothing on the shelves has changed.
export function statFingerprint(root, config, options) {
  const hash = crypto.createHash('sha256');
  hash.update(config.text);
  const rows = [];
  for (const { rel, abs } of walk(root, config, options)) {
    const st = fs.statSync(abs);
    rows.push(`${rel}\0${st.size}\0${Math.floor(st.mtimeMs)}\n`);
  }
  rows.sort();
  for (const row of rows) hash.update(row);
  return { fingerprint: hash.digest('hex'), files: rows.length };
}

// Exact fingerprint from file contents. Slower, but immune to a checkout that
// touches modification times without changing anything.
export function contentFingerprint(root, config, options) {
  const rows = [];
  for (const { rel, abs } of walk(root, config, options)) {
    rows.push(`${rel}\0${sha256(fs.readFileSync(abs))}\n`);
  }
  return combine(rows, config.text);
}

export function combine(rows, configText) {
  const hash = crypto.createHash('sha256');
  hash.update(configText);
  for (const row of [...rows].sort()) hash.update(row);
  return hash.digest('hex');
}
