// The clerk. Reads every shelf, catalogs it into a fresh SQLite file, and swaps
// that file in all at once so nobody ever reads a half-built index.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  BINARY_EXTENSIONS, LANGUAGES, TOOL_VERSION, combine, defaultDbPath, loadConfig, sha256, statFingerprint, walk,
} from './walk.js';
import { extract } from './extract.js';

const SCHEMA = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

export function build(root, { dbPath } = {}) {
  const started = performance.now();
  root = path.resolve(root);
  dbPath = path.resolve(dbPath ?? defaultDbPath(root));
  // The database never catalogs itself, even when it lives inside the root.
  const walkOptions = { exclude: dbPath };
  const config = loadConfig(root);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const tmp = `${dbPath}.tmp-${process.pid}`;
  fs.rmSync(tmp, { force: true });

  try {
    return buildInto(root, config, dbPath, tmp, walkOptions, started);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function buildInto(root, config, dbPath, tmp, walkOptions, started) {
  const db = new DatabaseSync(tmp);
  db.exec(SCHEMA);
  db.exec('BEGIN');

  const insertFile = db.prepare(`INSERT INTO files (path, shelf, kind, lang, applies_to, bytes, lines, sha256, summary, body)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertText = db.prepare('INSERT INTO file_text (rowid, body) VALUES (?, ?)');
  const insertSection = db.prepare(`INSERT INTO sections (file_id, heading, trail, level, start_line, end_line)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const insertSymbol = db.prepare(`INSERT INTO symbols (file_id, name, kind, role, line, scope, value)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insertRef = db.prepare('INSERT INTO refs (from_id, line, kind, raw, target, status) VALUES (?, ?, ?, ?, ?, ?)');
  const insertExample = db.prepare('INSERT INTO examples (file_id, topic, verdict, note, note_path) VALUES (?, ?, ?, ?, ?)');
  const insertSkipped = db.prepare('INSERT INTO skipped (path, reason, sha256) VALUES (?, ?, ?)');

  const stat = statFingerprint(root, config, walkOptions);
  const entries = [...walk(root, config, walkOptions)];
  const allPaths = new Set(entries.map((e) => e.rel));
  const fingerprintRows = [];
  const skipped = new Map();
  const pendingRefs = [];
  const exampleFiles = [];
  const ids = new Map();

  for (const entry of entries) {
    const buf = fs.readFileSync(entry.abs);
    const hash = sha256(buf);
    fingerprintRows.push(`${entry.rel}\0${hash}\n`);

    const ext = path.extname(entry.rel).toLowerCase();
    const lang = LANGUAGES[ext] ?? null;
    const binary = BINARY_EXTENSIONS.has(ext) || (!lang && buf.subarray(0, 8000).includes(0));
    const shelfFor = entry.shelf.for ?? [];

    if (binary) {
      const kind = entry.shelf.kind === 'example' ? 'example' : 'asset';
      const id = Number(insertFile.run(entry.rel, entry.shelf.path, kind, null, appliesTo(shelfFor), buf.length, null, hash, null, null).lastInsertRowid);
      ids.set(entry.rel, id);
      if (kind === 'example') exampleFiles.push({ entry, id, meta: {}, summary: null });
      continue;
    }
    if (buf.length > config.maxFileBytes) {
      skipped.set(entry.rel, { reason: `larger than ${Math.round(config.maxFileBytes / 1024)} KB`, hash });
      continue;
    }
    const text = buf.toString('utf8');
    if (config.secrets.some((re) => re.test(text))) {
      skipped.set(entry.rel, { reason: 'looks like it contains a secret', hash });
      continue;
    }

    const found = extract(lang ?? 'text', text);
    const kind = shelfKind(entry.shelf.kind, lang);
    const forList = toList(found.meta.for ?? found.meta.applies_to) ?? shelfFor;
    const lines = text.length ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
    const id = Number(insertFile.run(
      entry.rel, entry.shelf.path, kind, lang ?? 'text', appliesTo(forList), buf.length, lines, hash, found.summary, text,
    ).lastInsertRowid);
    ids.set(entry.rel, id);
    insertText.run(id, text);

    for (const s of found.sections) insertSection.run(id, s.heading, s.trail, s.level, s.start_line, s.end_line);
    for (const s of found.symbols) insertSymbol.run(id, s.name, s.kind, s.role, s.line, s.scope, s.value);
    for (const r of found.refs) pendingRefs.push({ id, from: entry.rel, shelf: entry.shelf.path, ...r });
    if (kind === 'example') exampleFiles.push({ entry, id, meta: found.meta, summary: found.summary });
  }

  for (const [rel, { reason, hash }] of skipped) insertSkipped.run(rel, reason, hash);

  for (const r of pendingRefs) {
    const { target, status } = resolveRef(root, r, allPaths, ids, skipped);
    if (status) insertRef.run(r.id, r.line, r.kind, r.raw, target, status);
  }

  catalogExamples(root, config, exampleFiles, insertExample);

  // A call to fetch() or console.log() isn't interesting. Keep function uses
  // only for functions that are defined somewhere on the shelves.
  db.exec(`DELETE FROM symbols WHERE kind = 'function' AND role = 'use'
    AND name NOT IN (SELECT name FROM symbols WHERE kind = 'function' AND role = 'def')`);

  const meta = {
    tool_version: TOOL_VERSION,
    name: config.name ?? path.basename(root),
    built_at: new Date().toISOString(),
    fingerprint: combine(fingerprintRows, config.text),
    stat_fingerprint: stat.fingerprint,
    config_sha256: sha256(config.text),
    files_seen: String(entries.length),
  };
  const insertMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(meta)) insertMeta.run(k, v);
  db.exec('COMMIT');

  const buildMs = performance.now() - started;
  db.prepare("INSERT INTO meta (key, value) VALUES ('build_ms', ?)").run(buildMs.toFixed(1));
  const counts = Object.fromEntries(['files', 'sections', 'symbols', 'refs', 'examples', 'skipped']
    .map((t) => [t, db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n]));
  db.close();

  // A rename on the same disk happens all at once, so readers see the old
  // index or the new one, never half of one.
  fs.renameSync(tmp, dbPath);
  return { dbPath, buildMs, bytes: fs.statSync(dbPath).size, counts, fingerprint: meta.fingerprint };
}

function shelfKind(kind, lang) {
  if (kind === 'auto') return lang === 'md' ? 'guidance' : 'code';
  return kind;
}

function toList(value) {
  if (value == null) return null;
  return Array.isArray(value) ? value : String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

function appliesTo(list) {
  return list && list.length ? `,${list.map((s) => s.toLowerCase()).join(',')},` : '';
}

export function resolveRef(root, ref, allPaths, ids, skipped) {
  let raw = ref.raw.replace(/&amp;/g, '&');
  // Skip things that aren't files: in-page anchors, data URIs, and template
  // placeholders like ${url}, {{ url }}, <%= url %>, and %PUBLIC_URL%.
  if (/^(mailto|tel|javascript|data|blob|about):/i.test(raw) || /^(#|%23)/i.test(raw)
    || /\$\{|\{\{|<%|%[A-Z_]+%/.test(raw)) {
    return { status: null };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return { target: raw, status: 'external' };
  raw = raw.split('#')[0].split('?')[0];
  if (!raw) return { status: null };
  if (ref.kind === 'import' && !raw.startsWith('.') && !raw.startsWith('/')) return { target: raw, status: 'package' };
  try { raw = decodeURIComponent(raw); } catch { /* keep the raw text */ }

  const base = raw.startsWith('/') ? (ref.shelf === '.' ? '' : ref.shelf) : path.posix.dirname(ref.from);
  let target = path.posix.normalize(path.posix.join(base || '.', raw.replace(/^\/+/, ''))).replace(/^\.\//, '');
  if (raw.endsWith('/') || (!allPaths.has(target) && allPaths.has(`${target}/index.html`))) {
    if (allPaths.has(`${target}/index.html`) || ref.kind !== 'link') target = path.posix.join(target, 'index.html');
    else if (folders(allPaths).has(target)) return { target: `${target}/`, status: 'ok' };
  }
  if (ref.kind === 'import' && !allPaths.has(target)) {
    for (const ext of ['.js', '.mjs', '.ts', '/index.js']) {
      if (allPaths.has(target + ext)) { target += ext; break; }
    }
  }
  if (skipped.has(target)) return { target, status: 'skipped' };
  if (ids.has(target)) return { target, status: 'ok' };
  if (!target.startsWith('..') && fs.existsSync(path.join(root, target))) return { target, status: 'outside' };
  return { target, status: 'missing' };
}

const folderCache = new WeakMap();
function folders(allPaths) {
  if (!folderCache.has(allPaths)) {
    const set = new Set();
    for (const p of allPaths) {
      let dir = path.posix.dirname(p);
      while (dir !== '.' && !set.has(dir)) {
        set.add(dir);
        dir = path.posix.dirname(dir);
      }
    }
    folderCache.set(allPaths, set);
  }
  return folderCache.get(allPaths);
}

function catalogExamples(root, config, files, insertExample) {
  const byPath = new Map(files.map((f) => [f.entry.rel, f]));
  const sidecars = new Set();
  for (const f of files) {
    if (!f.entry.rel.endsWith('.md')) continue;
    const stem = f.entry.rel.slice(0, -3);
    for (const other of byPath.keys()) {
      if (other !== f.entry.rel && other.startsWith(`${stem}.`)) {
        sidecars.add(f.entry.rel);
        byPath.get(other).sidecar = f;
      }
    }
  }
  for (const f of files) {
    if (sidecars.has(f.entry.rel)) continue;
    const shelfPath = f.entry.shelf.path === '.' ? '' : `${f.entry.shelf.path}/`;
    const parts = f.entry.rel.slice(shelfPath.length).split('/');
    const meta = { ...f.meta, ...(f.sidecar?.meta ?? {}) };
    const verdict = (meta.verdict ?? parts.find((p) => /^(approved|rejected)$/i.test(p)) ?? 'approved').toLowerCase();
    const topic = (meta.topic ?? (parts.length > 1 ? parts[0] : 'general')).toLowerCase();
    let note = meta.note ?? null;
    if (f.sidecar) {
      const body = fs.readFileSync(path.join(root, f.sidecar.entry.rel), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
      note = [note, body].filter(Boolean).join(' ');
    }
    insertExample.run(f.id, topic, verdict, note ?? f.summary, f.sidecar?.entry.rel ?? null);
  }
}
