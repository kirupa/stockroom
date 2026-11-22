// The counter. Agents never wander the shelves. They ask one of these questions
// and get back a small, precise answer, or an honest "I don't have that."

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TOOL_VERSION, defaultDbPath, loadConfig, sha256, statFingerprint, walk } from './walk.js';

const MAX_READ_LINES = 200;

const FOR_PROP = {
  type: 'string',
  description: 'Only include material for this kind of work, like "web", "slides", or "illustration".',
};

export const TOOLS = [
  {
    name: 'search_source',
    description: 'Find the files and lines that contain some text. Case-insensitive, and typos are fine to search for. Returns file:line hits, with the guidance section each hit sits in.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The text to look for, like an error message, a class name, or a phrase.' },
        for: FOR_PROP,
        kind: { type: 'string', enum: ['code', 'guidance', 'example'], description: 'Only search one kind of file.' },
        path: { type: 'string', description: 'Only search inside this folder.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      required: ['query'],
    },
  },
  {
    name: 'find_symbol',
    description: 'Find where a name is defined and where it is used: a CSS class (.card), an id (#menu), a design token (--primary), a JavaScript function (addToCart), or a hex color (#c2410c). Token definitions include their value in every theme.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name to look up. Without a prefix, classes, ids, tokens, and functions are all tried.' },
        kind: { type: 'string', enum: ['class', 'id', 'token', 'function', 'color'] },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 30 },
      },
      required: ['name'],
    },
  },
  {
    name: 'read_source',
    description: `Read part of one file with line numbers, or one section of a guidance file by its heading. Returns at most ${MAX_READ_LINES} lines and the file's sha256, which an edit should carry so it can be refused if the file changed.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        start: { type: 'integer', minimum: 1, description: 'First line to read.' },
        end: { type: 'integer', minimum: 1, description: 'Last line to read.' },
        section: { type: 'string', description: 'A heading in a Markdown file, like "Callout arrows". Reads just that section.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_source',
    description: 'List what is in a folder, with a one-line summary of every file, so you can skim without opening anything.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The folder to list. Leave empty for the top level.' },
        for: FOR_PROP,
      },
    },
  },
  {
    name: 'follow_references',
    description: 'List everything one file pulls in (stylesheets, scripts, includes, images, links, imports), and whether each one exists.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'who_references',
    description: 'List every file that pulls in this file. Use it before changing or renaming anything shared.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'find_rules',
    description: 'List the guidance sections (rules) that apply to a kind of work, optionally about one topic. Returns headings and line ranges. Read the ones you need with read_source.',
    inputSchema: {
      type: 'object',
      properties: {
        for: FOR_PROP,
        topic: { type: 'string', description: 'Words to look for in the rules, like "arrows" or "punch slide".' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 40 },
      },
    },
  },
  {
    name: 'find_examples',
    description: 'List approved and rejected examples for a kind of work, with the reason each one was approved or rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        for: FOR_PROP,
        verdict: { type: 'string', enum: ['approved', 'rejected'] },
        topic: { type: 'string', description: 'Words to look for in the example notes.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
    },
  },
];

export class StockroomError extends Error {}

export class Counter {
  constructor({ root = '.', dbPath, maxCalls = 40, maxResultChars = 16000, checkFreshness = true, freshnessIntervalMs = 1000, rebuild = null } = {}) {
    this.rebuild = rebuild;
    this.root = path.resolve(root);
    this.dbPath = path.resolve(dbPath ?? defaultDbPath(this.root));
    this.walkOptions = { exclude: this.dbPath };
    this.maxCalls = maxCalls;
    this.maxResultChars = maxResultChars;
    this.checkFreshness = checkFreshness;
    this.freshnessIntervalMs = rebuild ? 0 : freshnessIntervalMs;
    this.calls = 0;
    this.freshUntil = 0;
    this.trustedStat = null;
    this.open();
  }

  // The database is opened for each call and closed right after, so a rebuild
  // can always swap in a new file (Windows won't replace a file that's open).
  open() {
    if (!fs.existsSync(this.dbPath)) {
      throw new StockroomError(`There's no index at ${this.dbPath} yet. Run "stockroom build" first.`);
    }
    this.dbStat = fs.statSync(this.dbPath);
    this.connect();
    try {
      this.meta = Object.fromEntries(this.db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));
    } finally {
      this.disconnect();
    }
    this.bodies = new Map();
    this.trustedStat = this.meta.stat_fingerprint;
    if (this.meta.tool_version !== TOOL_VERSION) {
      throw new StockroomError(`The index was built by stockroom ${this.meta.tool_version}, and this is ${TOOL_VERSION}. Rebuild it.`);
    }
  }

  connect() {
    if (!this.db) this.db = new DatabaseSync(this.dbPath, { readOnly: true });
  }

  disconnect() {
    this.db?.close();
    this.db = null;
  }

  close() {
    this.disconnect();
  }

  // A rebuild swaps in a new file. Notice that and start reading the new one.
  reopenIfSwapped() {
    if (!fs.existsSync(this.dbPath)) throw new StockroomError(`The index at ${this.dbPath} is gone. Run "stockroom build".`);
    const st = fs.statSync(this.dbPath);
    if (st.ino !== this.dbStat.ino || st.mtimeMs !== this.dbStat.mtimeMs || st.size !== this.dbStat.size) {
      this.disconnect();
      this.open();
      this.freshUntil = 0;
    }
  }

  // Compares the shelves with what the index recorded. Returns every file that
  // was added, changed, or removed since the last build.
  changes() {
    const config = loadConfig(this.root);
    const out = [];
    if (sha256(config.text) !== this.meta.config_sha256) out.push({ path: 'stockroom.json', change: 'changed' });
    const known = new Map(this.db.prepare('SELECT path, sha256 FROM files UNION ALL SELECT path, sha256 FROM skipped').all().map((r) => [r.path, r.sha256]));
    for (const { rel, abs } of walk(this.root, config, this.walkOptions)) {
      const hash = sha256(fs.readFileSync(abs));
      if (!known.has(rel)) out.push({ path: rel, change: 'added' });
      else if (known.get(rel) !== hash) out.push({ path: rel, change: 'changed' });
      known.delete(rel);
    }
    for (const rel of known.keys()) out.push({ path: rel, change: 'removed' });
    return out;
  }

  ensureFresh() {
    if (!this.checkFreshness) return;
    const now = Date.now();
    if (now < this.freshUntil) return;
    const stat = statFingerprint(this.root, loadConfig(this.root), this.walkOptions).fingerprint;
    if (stat !== this.trustedStat) {
      let changed = this.changes();
      if (changed.length && this.rebuild) {
        // This process is its own clerk, so rebuild now instead of refusing.
        this.disconnect();
        this.rebuild();
        this.open();
        this.connect();
        changed = this.changes();
      }
      if (changed.length) {
        const list = changed.slice(0, 5).map((c) => `${c.path} (${c.change})`).join(', ');
        throw new StockroomError(
          `The index is out of date. ${changed.length} file${changed.length === 1 ? ' has' : 's have'} changed since it was built: ${list}${changed.length > 5 ? ', ...' : ''}. Run "stockroom build" (or keep "stockroom watch" running) and ask again.`,
        );
      }
      this.trustedStat = stat;
    }
    this.freshUntil = now + this.freshnessIntervalMs;
  }

  // Runs one tool and returns { text, data, isError }.
  call(name, args = {}) {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return { isError: true, text: `There's no tool called ${name}. Try one of: ${TOOLS.map((t) => t.name).join(', ')}.` };
    this.calls++;
    if (this.calls > this.maxCalls) {
      return {
        isError: false,
        text: `Time's up: this session has used all ${this.maxCalls} of its lookups. Answer with what you have, and say what you couldn't check.`,
      };
    }
    try {
      this.reopenIfSwapped();
      this.connect();
      this.ensureFresh();
      const data = this[name](args ?? {});
      let text = FORMAT[name](data);
      if (text.length > this.maxResultChars) {
        text = `${text.slice(0, this.maxResultChars)}\n[Cut at ${this.maxResultChars} characters. Ask a narrower question.]`;
      }
      return { isError: false, text, data };
    } catch (err) {
      if (err instanceof StockroomError) return { isError: true, text: err.message };
      throw err;
    } finally {
      this.disconnect();
    }
  }

  // ------------------------------------------------------------------ tools

  search_source({ query, for: forWork, kind, path: folder, limit = 20 }) {
    const q = String(query ?? '');
    if (!q.trim()) throw new StockroomError('search_source needs a query.');
    const started = performance.now();
    const { where, params } = filters({ forWork, kind, folder });
    const candidates = q.length >= 3
      ? this.db.prepare(`SELECT f.id, f.path, f.lang FROM file_text JOIN files f ON f.id = file_text.rowid
          WHERE file_text MATCH ? ${where} ORDER BY f.path`).all(`"${q.replace(/"/g, '""')}"`, ...params)
      : this.db.prepare(`SELECT f.id, f.path, f.lang FROM files f
          WHERE f.body IS NOT NULL AND instr(lower(f.body), lower(?)) > 0 ${where} ORDER BY f.path`).all(q, ...params);
    const narrowMs = performance.now() - started;

    const needle = q.toLowerCase();
    const hits = [];
    let total = 0;
    for (const f of candidates) {
      const lines = this.lines(f.id);
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].toLowerCase().includes(needle)) continue;
        total++;
        if (hits.length < limit) {
          hits.push({ path: f.path, line: i + 1, text: clipLine(lines[i]), section: f.lang === 'md' ? this.sectionAt(f.id, i + 1) : null });
        }
      }
    }
    const searchable = this.db.prepare('SELECT count(*) AS n FROM files WHERE body IS NOT NULL').get().n;
    return { query: q, searchable, candidates: candidates.length, total, hits, narrowMs, ms: performance.now() - started };
  }

  find_symbol({ name, kind, limit = 30 }) {
    let n = String(name ?? '').trim();
    if (!n) throw new StockroomError('find_symbol needs a name.');
    if (/^#[0-9a-f]{3,8}$/i.test(n)) n = n.toLowerCase();
    const names = /^(\.|#|--)/.test(n) ? [n] : [n, `.${n}`, `#${n}`, `--${n}`];
    const rows = this.db.prepare(`SELECT s.*, f.path FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE s.name IN (${names.map(() => '?').join(',')}) ${kind ? 'AND s.kind = ?' : ''}
      ORDER BY f.path, s.line`).all(...names, ...(kind ? [kind] : []));
    const shape = (r) => ({
      path: r.path, line: r.line, name: r.name, kind: r.kind, scope: r.scope, value: r.value,
      text: clipLine(this.lines(r.file_id)[r.line - 1] ?? ''),
    });
    const groups = [...new Set(rows.map((r) => r.name))].map((matched) => {
      const mine = rows.filter((r) => r.name === matched);
      const defs = mine.filter((r) => r.role === 'def');
      const uses = mine.filter((r) => r.role === 'use');
      return {
        name: matched,
        kind: mine[0].kind,
        defs: defs.slice(0, limit).map(shape),
        uses: uses.slice(0, limit).map(shape),
        defsTotal: defs.length,
        usesTotal: uses.length,
      };
    });
    // A hex color is usually the value of a token. Say which one, so the
    // caller can use the token instead of the raw color.
    const tokens = /^#[0-9a-f]{3,8}$/.test(n)
      ? this.db.prepare(`SELECT s.name, s.scope, s.line, f.path FROM symbols s JOIN files f ON f.id = s.file_id
          WHERE s.kind = 'token' AND s.role = 'def' AND lower(s.value) = ? ORDER BY f.path, s.line`).all(n)
      : [];
    return { name: n, groups, tokens };
  }

  read_source({ path: p, start, end, section }) {
    const file = this.file(p);
    if (file.body == null) {
      return { path: file.path, asset: true, bytes: file.bytes, sha256: file.sha256, kind: file.kind };
    }
    const lines = this.lines(file.id);
    let trail = null;
    if (section) {
      const sections = this.db.prepare('SELECT * FROM sections WHERE file_id = ? ORDER BY start_line').all(file.id);
      const want = section.toLowerCase();
      const s = sections.find((x) => x.heading.toLowerCase() === want)
        ?? sections.find((x) => x.trail.toLowerCase().includes(want));
      if (!s) {
        throw new StockroomError(`${file.path} has no section called "${section}". Its sections are: ${sections.map((x) => x.heading).join(', ') || 'none'}.`);
      }
      start = s.start_line;
      end = s.end_line;
      trail = s.trail;
    }
    const first = Math.max(1, Math.trunc(Number(start)) || 1);
    if (first > lines.length) throw new StockroomError(`${file.path} only has ${lines.length} lines.`);
    let last = Math.max(first, Math.min(lines.length, Math.trunc(Number(end)) || lines.length));
    let truncated = false;
    if (last - first + 1 > MAX_READ_LINES) {
      last = first + MAX_READ_LINES - 1;
      truncated = true;
    }
    return {
      path: file.path,
      sha256: file.sha256,
      totalLines: lines.length,
      start: first,
      end: last,
      section: trail,
      truncated,
      lines: lines.slice(first - 1, last),
    };
  }

  list_source({ path: folder = '', for: forWork }) {
    const prefix = normalizeFolder(folder);
    const { where, params } = filters({ forWork, folder: prefix });
    const rows = this.db.prepare(`SELECT f.path, f.kind, f.lang, f.bytes, f.summary FROM files f WHERE 1 = 1 ${where} ORDER BY f.path`).all(...params);
    const exact = this.db.prepare('SELECT path FROM files WHERE path = ?').get(prefix);
    if (!rows.length && exact) throw new StockroomError(`${prefix} is a file, not a folder. Use read_source to read it.`);
    const start = prefix ? prefix.length + 1 : 0;
    const folders = new Map();
    const files = [];
    for (const r of rows) {
      const rest = r.path.slice(start);
      const slash = rest.indexOf('/');
      if (slash < 0) files.push({ ...r, name: rest });
      else folders.set(rest.slice(0, slash), (folders.get(rest.slice(0, slash)) ?? 0) + 1);
    }
    const skipped = this.db.prepare('SELECT path, reason FROM skipped WHERE ? = \'\' OR substr(path, 1, ?) = ? ORDER BY path')
      .all(prefix, prefix.length + 1, `${prefix}/`)
      .filter((s) => !s.path.slice(start).includes('/'));
    if (!rows.length && !skipped.length) throw new StockroomError(`There's nothing in the index under "${prefix || '/'}".`);
    return { path: prefix, folders: [...folders].map(([name, count]) => ({ name, count })), files, skipped };
  }

  follow_references({ path: p }) {
    const file = this.file(p);
    const refs = this.db.prepare('SELECT line, kind, raw, target, status FROM refs WHERE from_id = ? ORDER BY line').all(file.id);
    return { path: file.path, refs };
  }

  who_references({ path: p }) {
    const target = normalizeFolder(p);
    const known = this.db.prepare('SELECT path FROM files WHERE path = ? UNION SELECT path FROM skipped WHERE path = ?').get(target, target);
    const refs = this.db.prepare(`SELECT f.path, r.line, r.kind, r.status FROM refs r JOIN files f ON f.id = r.from_id
      WHERE r.target = ? ORDER BY f.path, r.line`).all(target);
    if (!known && !refs.length) throw this.notFound(target);
    return { path: target, exists: Boolean(known), refs };
  }

  find_rules({ for: forWork, topic, limit = 40 }) {
    const { where, params } = filters({ forWork });
    const rows = this.db.prepare(`SELECT s.*, f.path FROM sections s JOIN files f ON f.id = s.file_id
      WHERE f.kind = 'guidance' ${where} ORDER BY f.path, s.start_line`).all(...params);
    const words = String(topic ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    let results = rows.map((s, i) => {
      const next = rows[i + 1];
      const ownEnd = next && next.file_id === s.file_id ? Math.min(s.end_line, next.start_line - 1) : s.end_line;
      return { ...s, ownEnd };
    });
    if (words.length) {
      results = results.map((s) => {
        const heading = s.trail.toLowerCase();
        const text = this.lines(s.file_id).slice(s.start_line, s.ownEnd).join('\n').toLowerCase();
        const score = words.reduce((sum, w) => sum + (heading.includes(w) ? 2 : 0) + (text.includes(w) ? 1 : 0), 0);
        return { ...s, score };
      }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.start_line - b.start_line);
    }
    return {
      for: forWork ?? null,
      topic: topic ?? null,
      total: results.length,
      rules: results.slice(0, limit).map((s) => ({
        path: s.path, heading: s.heading, trail: s.trail, start: s.start_line, end: s.end_line, level: s.level,
      })),
    };
  }

  find_examples({ for: forWork, verdict, topic, limit = 20 }) {
    forWork = forWork ? String(forWork).toLowerCase() : null;
    verdict = verdict ? String(verdict).toLowerCase() : null;
    const rows = this.db.prepare(`SELECT e.topic, e.verdict, e.note, e.note_path, f.path, f.summary FROM examples e
      JOIN files f ON f.id = e.file_id
      WHERE (? IS NULL OR e.topic = ?) AND (? IS NULL OR e.verdict = ?)
      ORDER BY e.topic, e.verdict, f.path`).all(forWork ?? null, forWork ?? null, verdict ?? null, verdict ?? null);
    const words = String(topic ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const matching = words.length
      ? rows.filter((r) => words.some((w) => `${r.path} ${r.note ?? ''} ${r.summary ?? ''}`.toLowerCase().includes(w)))
      : rows;
    return { for: forWork ?? null, total: matching.length, examples: matching.slice(0, limit) };
  }

  // ---------------------------------------------------------- CLI-only views

  status() {
    return this.connected(() => this.statusNow());
  }

  report() {
    return this.connected(() => this.reportNow());
  }

  connected(fn) {
    this.reopenIfSwapped();
    this.connect();
    try {
      return fn();
    } finally {
      this.disconnect();
    }
  }

  statusNow() {
    const counts = Object.fromEntries(['files', 'sections', 'symbols', 'refs', 'examples', 'skipped']
      .map((t) => [t, this.db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n]));
    return { meta: this.meta, counts, bytes: fs.statSync(this.dbPath).size, changes: this.changes() };
  }

  reportNow() {
    const q = (sql, ...p) => this.db.prepare(sql).all(...p);
    const undefinedNames = (kind) => q(`SELECT s.name, count(*) AS uses, min(f.path || ':' || s.line) AS first
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE s.kind = ? AND s.role = 'use' AND f.kind = 'code'
        AND s.name NOT IN (SELECT name FROM symbols WHERE kind = ? AND role = 'def')
      GROUP BY s.name ORDER BY s.name`, kind, kind);
    return {
      // Examples are a record of past work, so their broken links don't count.
      missing: q(`SELECT f.path, r.line, r.kind, r.raw, r.target FROM refs r JOIN files f ON f.id = r.from_id
        WHERE r.status = 'missing' AND f.kind != 'example' ORDER BY f.path, r.line`),
      classes: undefinedNames('class'),
      ids: undefinedNames('id'),
      tokens: undefinedNames('token'),
      offPalette: q(`SELECT s.name, f.path, s.line FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE s.kind = 'color' AND f.kind = 'code' AND f.applies_to LIKE '%,illustration,%'
          AND s.name NOT IN (SELECT lower(value) FROM symbols WHERE kind = 'token' AND role = 'def' AND value IS NOT NULL)
        ORDER BY f.path, s.line`),
      skipped: q('SELECT path, reason FROM skipped ORDER BY path'),
    };
  }

  // ---------------------------------------------------------------- helpers

  file(p) {
    const rel = normalizeFolder(p);
    const file = this.db.prepare('SELECT * FROM files WHERE path = ?').get(rel);
    if (!file) throw this.notFound(rel);
    return file;
  }

  notFound(rel) {
    const skipped = this.db.prepare('SELECT reason FROM skipped WHERE path = ?').get(rel);
    if (skipped) return new StockroomError(`${rel} isn't in the index on purpose: it ${skipped.reason}. A person needs to look at it.`);
    const base = path.posix.basename(rel);
    const similar = this.db.prepare("SELECT path FROM files WHERE path LIKE ? ESCAPE '\\' LIMIT 5").all(`%${escapeLike(base)}`);
    const hint = similar.length ? ` Did you mean ${similar.map((s) => s.path).join(' or ')}?` : '';
    return new StockroomError(`${rel} isn't in the index.${hint}`);
  }

  lines(fileId) {
    if (!this.bodies.has(fileId)) {
      const row = this.db.prepare('SELECT body FROM files WHERE id = ?').get(fileId);
      const body = row?.body ?? '';
      const lines = body.split('\n');
      if (body.endsWith('\n')) lines.pop();
      this.bodies.set(fileId, lines);
    }
    return this.bodies.get(fileId);
  }

  sectionAt(fileId, line) {
    const s = this.db.prepare(`SELECT trail FROM sections WHERE file_id = ? AND start_line <= ? AND end_line >= ?
      ORDER BY level DESC LIMIT 1`).get(fileId, line, line);
    return s?.trail ?? null;
  }
}

function filters({ forWork, kind, folder }) {
  const parts = [];
  const params = [];
  if (forWork) {
    parts.push("(f.applies_to = '' OR f.applies_to LIKE ?)");
    params.push(`%,${String(forWork).toLowerCase()},%`);
  }
  if (kind) {
    parts.push('f.kind = ?');
    params.push(kind);
  }
  const prefix = folder ? normalizeFolder(folder) : '';
  if (prefix) {
    parts.push('substr(f.path, 1, ?) = ?');
    params.push(prefix.length + 1, `${prefix}/`);
  }
  return { where: parts.map((p) => `AND ${p}`).join(' '), params };
}

function normalizeFolder(p) {
  return path.posix.normalize(String(p ?? '').replace(/\\/g, '/')).replace(/^(\.\/|\/)+/, '').replace(/\/+$/, '').replace(/^\.$/, '');
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function clipLine(s, n = 160) {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const kb = (bytes) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

export const FORMAT = {
  search_source(d) {
    const head = `${plural(d.total, 'matching line')} in ${plural(new Set(d.hits.map((h) => h.path)).size, 'file')} `
      + `(the index narrowed ${d.searchable} files to ${plural(d.candidates, 'candidate')} in ${d.narrowMs.toFixed(1)} ms)`;
    const body = d.hits.map((h) => `${h.path}:${h.line}  ${h.section ? `[${h.section}] ` : ''}${h.text}`);
    if (d.total > d.hits.length) body.push(`...and ${d.total - d.hits.length} more. Narrow it with "path", "for", or "kind".`);
    return [head, ...body].join('\n');
  },
  find_symbol(d) {
    const out = [];
    if (!d.groups.length) out.push(`${d.name}: no definitions and no uses anywhere in the index.`);
    const row = (r) => `  ${r.path}:${r.line}  ${r.scope && r.kind === 'token' ? `[${r.scope}] ` : ''}${r.text}`;
    for (const g of d.groups) {
      if (out.length) out.push('');
      out.push(`${g.name} (${g.kind}): ${plural(g.defsTotal, 'definition')}, ${plural(g.usesTotal, 'use')}`);
      if (g.defs.length) out.push('defined:', ...g.defs.map(row));
      if (g.defsTotal > g.defs.length) out.push(`  ...and ${g.defsTotal - g.defs.length} more`);
      if (g.uses.length) out.push('used:', ...g.uses.map(row));
      if (g.usesTotal > g.uses.length) out.push(`  ...and ${g.usesTotal - g.uses.length} more`);
    }
    if (d.tokens.length) {
      out.push('', `${d.name} is the value of ${d.tokens.map((t) => `${t.name} [${t.scope}] at ${t.path}:${t.line}`).join(', ')}. Use the token instead of the raw color.`);
    } else if (/^#[0-9a-f]{3,8}$/.test(d.name)) {
      out.push('', `${d.name} isn't the value of any token, so it isn't in the palette.`);
    }
    return out.join('\n');
  },
  read_source(d) {
    if (d.asset) return `${d.path} is a binary file (${kb(d.bytes)}), so there's no text to read. sha256 ${d.sha256}`;
    const width = String(d.end).length;
    const head = `${d.path}  lines ${d.start}-${d.end} of ${d.totalLines}${d.section ? `  [${d.section}]` : ''}  sha256 ${d.sha256}`;
    const body = d.lines.map((l, i) => `${String(d.start + i).padStart(width)}| ${l}`);
    if (d.truncated) body.push(`[Stopped at ${MAX_READ_LINES} lines. Ask for the next range if you need it.]`);
    return [head, ...body].join('\n');
  },
  list_source(d) {
    const out = [`${d.path || '(top level)'}/  ${plural(d.folders.length, 'folder')}, ${plural(d.files.length, 'file')}`];
    for (const f of d.folders) out.push(`  ${f.name}/  ${plural(f.count, 'file')}`);
    for (const f of d.files) out.push(`  ${f.name}  ${f.kind}, ${kb(f.bytes)}${f.summary ? `  ${f.summary}` : ''}`);
    for (const s of d.skipped) out.push(`  ${s.path.split('/').pop()}  not indexed: ${s.reason}`);
    return out.join('\n');
  },
  follow_references(d) {
    if (!d.refs.length) return `${d.path} doesn't pull in any other files.`;
    const bad = d.refs.filter((r) => r.status === 'missing').length;
    const out = [`${d.path} pulls in ${plural(d.refs.length, 'thing')}${bad ? ` (${bad} missing)` : ''}:`];
    for (const r of d.refs) {
      const status = r.status === 'ok' ? '' : `  ${r.status.toUpperCase()}`;
      out.push(`  line ${r.line}  ${r.kind}  ${r.target ?? r.raw}${status}`);
    }
    return out.join('\n');
  },
  who_references(d) {
    const files = new Set(d.refs.map((r) => r.path)).size;
    if (!d.refs.length) return `Nothing in the index pulls in ${d.path}.`;
    const out = [`${d.path}${d.exists ? '' : ' (which does not exist)'} is pulled in by ${plural(files, 'file')}:`];
    for (const r of d.refs) out.push(`  ${r.path}:${r.line}  ${r.kind}`);
    return out.join('\n');
  },
  find_rules(d) {
    if (!d.rules.length) return `No rules found${d.for ? ` for ${d.for}` : ''}${d.topic ? ` about "${d.topic}"` : ''}.`;
    const out = [`${plural(d.total, 'rule section')}${d.for ? ` for ${d.for}` : ''}${d.topic ? ` about "${d.topic}"` : ''}:`];
    for (const r of d.rules) out.push(`  ${r.path}:${r.start}-${r.end}  ${r.trail}`);
    if (d.total > d.rules.length) out.push(`  ...and ${d.total - d.rules.length} more`);
    out.push('Read one with read_source and its path plus section.');
    return out.join('\n');
  },
  find_examples(d) {
    if (!d.examples.length) return `No examples found${d.for ? ` for ${d.for}` : ''}.`;
    const out = [`${plural(d.total, 'example')}${d.for ? ` for ${d.for}` : ''}:`];
    for (const e of d.examples) {
      out.push(`  ${e.verdict.toUpperCase()}  ${e.path}${e.summary && e.summary !== e.note ? `  (${e.summary})` : ''}`);
      if (e.note) out.push(`    why: ${e.note}`);
    }
    return out.join('\n');
  },
};
