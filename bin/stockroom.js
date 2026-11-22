#!/usr/bin/env node
// stockroom: a tiny context system. Run "stockroom help" for the commands.

import fs from 'node:fs';
import path from 'node:path';
import { build } from '../src/build.js';
import { Counter, TOOLS, StockroomError } from '../src/counter.js';
import { serve } from '../src/mcp.js';
import { watchAndBuild } from '../src/watch.js';
import { sha256, TOOL_VERSION } from '../src/walk.js';

const ALIASES = {
  search: 'search_source',
  symbol: 'find_symbol',
  read: 'read_source',
  ls: 'list_source',
  uses: 'follow_references',
  'used-by': 'who_references',
  rules: 'find_rules',
  examples: 'find_examples',
};

const POSITIONAL = {
  search_source: ['query'],
  find_symbol: ['name'],
  read_source: ['path', 'start', 'end'],
  list_source: ['path'],
  follow_references: ['path'],
  who_references: ['path'],
  find_rules: ['for', 'topic'],
  find_examples: ['for', 'verdict'],
};

const HELP = `stockroom ${TOOL_VERSION}: a tiny context system for agents

Building and keeping it current:
  stockroom build                 Catalog every shelf into .stockroom/context.db
  stockroom watch                 Rebuild whenever something on a shelf changes
  stockroom status                Show what's indexed and whether it's current
  stockroom report [--strict]     Broken references, undefined names, off-palette colors, blind spots
                                  (--strict exits with 1 when it finds a problem, for CI)
  stockroom verify <path> <sha>   Check that a file still matches the sha256 an edit was based on

Plugging in an agent:
  stockroom serve [--watch]       Run the MCP server over stdio (--watch also builds and rebuilds)

Asking questions yourself (the same tools the agents get):
  stockroom search <text>               search_source
  stockroom symbol <name>               find_symbol    (.card, #menu, --primary, addToCart)
  stockroom read <path> [start] [end]   read_source    (or section="Callout arrows")
  stockroom ls [folder]                 list_source
  stockroom uses <path>                 follow_references
  stockroom used-by <path>              who_references
  stockroom rules [for] [topic]         find_rules     (for = web, slides, illustration, ...)
  stockroom examples [for] [verdict]    find_examples

Options:
  --root=<dir>   The Context Environment to use (default: the current folder)
  --db=<file>    Where the index lives (default: <root>/.stockroom/context.db)
  --json         Print the raw result instead of text
  Any tool option can be passed as key=value, like: stockroom search "sold out" for=web limit=5
`;

function parse(argv) {
  const opts = { root: process.cwd(), db: null, json: false, watch: false, strict: false };
  const rest = [];
  for (const arg of argv) {
    if (arg === '--json') opts.json = true;
    else if (arg === '--watch') opts.watch = true;
    else if (arg === '--strict') opts.strict = true;
    else if (arg.startsWith('--root=')) opts.root = arg.slice(7);
    else if (arg.startsWith('--db=')) opts.db = arg.slice(5);
    else if (arg === '--help' || arg === '-h') rest.unshift('help');
    else rest.push(arg);
  }
  opts.root = path.resolve(opts.root);
  opts.db = opts.db ? path.resolve(opts.db) : undefined;
  return { opts, command: rest[0] ?? 'help', args: rest.slice(1) };
}

function toolArgs(tool, args) {
  const out = {};
  const positional = [];
  for (const a of args) {
    const kv = a.match(/^([a-z_]+)=(.*)$/s);
    if (kv && TOOLS.find((t) => t.name === tool).inputSchema.properties[kv[1]]) out[kv[1]] = kv[2];
    else positional.push(a);
  }
  const names = POSITIONAL[tool];
  if (tool === 'read_source' && positional[0]) {
    const range = positional[0].match(/^(.*?):(\d+)(?:-(\d+))?$/);
    if (range) positional.splice(0, 1, range[1], range[2], range[3] ?? range[2]);
  }
  positional.forEach((value, i) => {
    const name = names[Math.min(i, names.length - 1)];
    out[name] = i >= names.length ? `${out[name]} ${value}` : value;
  });
  for (const [k, v] of Object.entries(out)) {
    const type = TOOLS.find((t) => t.name === tool).inputSchema.properties[k]?.type;
    if (type === 'integer') out[k] = Number(v);
  }
  return out;
}

function printBuild(result) {
  const c = result.counts;
  console.log(`Built ${path.relative(process.cwd(), result.dbPath) || result.dbPath} in ${(result.buildMs / 1000).toFixed(2)} s (${(result.bytes / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`  ${c.files} files, ${c.sections} sections, ${c.symbols} names, ${c.refs} references, ${c.examples} examples, ${c.skipped} skipped`);
}

async function main() {
  const { opts, command, args } = parse(process.argv.slice(2));
  const counterOpts = { root: opts.root, dbPath: opts.db };

  if (command === 'help') {
    process.stdout.write(HELP);
    return;
  }

  if (command === 'build') {
    printBuild(build(opts.root, { dbPath: opts.db }));
    return;
  }

  if (command === 'watch') {
    watchAndBuild(opts.root, {
      dbPath: opts.db,
      onBuild: printBuild,
      onError: (err) => console.error(`Rebuild failed: ${err.message}`),
    });
    console.log(`Watching ${opts.root}. Press Ctrl+C to stop.`);
    return;
  }

  if (command === 'serve') {
    let watcher = null;
    if (opts.watch) {
      // stdout belongs to the MCP protocol, so build messages go to stderr.
      watcher = watchAndBuild(opts.root, {
        dbPath: opts.db,
        onBuild: (r) => console.error(`stockroom: indexed ${r.counts.files} files in ${r.buildMs.toFixed(0)} ms`),
        onError: (err) => console.error(`stockroom: rebuild failed: ${err.message}`),
      });
    }
    await serve({
      root: opts.root,
      dbPath: opts.db,
      maxCalls: Number(process.env.STOCKROOM_MAX_CALLS) || 40,
      rebuild: opts.watch ? () => build(opts.root, { dbPath: opts.db }) : null,
    });
    watcher?.close();
    return;
  }

  if (command === 'verify') {
    const [file, expected] = args;
    if (!file || !expected) throw new StockroomError('Usage: stockroom verify <path> <sha256>');
    const actual = sha256(fs.readFileSync(path.join(opts.root, file)));
    if (actual === expected) {
      console.log(`${file} hasn't changed. Safe to apply the edit.`);
    } else {
      console.log(`${file} has changed since the edit was written (now ${actual}). Refuse the edit and read it again.`);
      process.exitCode = 1;
    }
    return;
  }

  const counter = new Counter({ ...counterOpts, maxCalls: Infinity });

  if (command === 'status') {
    const s = counter.status();
    if (opts.json) return console.log(JSON.stringify(s, null, 2));
    console.log(`${s.meta.name}: built ${s.meta.built_at} in ${(Number(s.meta.build_ms) / 1000).toFixed(2)} s, ${(s.bytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  ${s.counts.files} files, ${s.counts.sections} sections, ${s.counts.symbols} names, ${s.counts.refs} references, ${s.counts.examples} examples, ${s.counts.skipped} skipped`);
    if (!s.changes.length) console.log('  Current: nothing has changed since the last build.');
    else {
      console.log(`  Out of date: ${s.changes.length} change(s) since the last build.`);
      for (const c of s.changes.slice(0, 20)) console.log(`    ${c.change}  ${c.path}`);
    }
    return;
  }

  if (command === 'report') {
    const r = counter.report();
    const problems = r.missing.length + r.classes.length + r.ids.length + r.tokens.length + r.offPalette.length;
    if (opts.strict && problems) process.exitCode = 1;
    if (opts.json) return console.log(JSON.stringify(r, null, 2));
    const section = (title, rows, fmt) => {
      console.log(`${title} (${rows.length})`);
      for (const row of rows) console.log(`  ${fmt(row)}`);
      console.log('');
    };
    section('Missing references', r.missing, (m) => `${m.path}:${m.line}  ${m.kind} ${m.raw}`);
    section('Classes used but never defined', r.classes, (m) => `${m.name}  ${m.uses} use(s), first at ${m.first}`);
    section('Ids used but never defined', r.ids, (m) => `${m.name}  ${m.uses} use(s), first at ${m.first}`);
    section('Tokens used but never defined', r.tokens, (m) => `${m.name}  ${m.uses} use(s), first at ${m.first}`);
    section('Colors in figures that are not in the palette', r.offPalette, (m) => `${m.name}  ${m.path}:${m.line}`);
    section('Not indexed on purpose', r.skipped, (m) => `${m.path}  ${m.reason}`);
    if (opts.strict) console.log(problems ? `${problems} problem(s) found.` : 'No problems found.');
    return;
  }

  const tool = ALIASES[command] ?? command;
  if (!POSITIONAL[tool]) throw new StockroomError(`Unknown command "${command}". Run "stockroom help".`);
  const result = counter.call(tool, toolArgs(tool, args));
  if (opts.json && result.data) console.log(JSON.stringify(result.data, null, 2));
  else console.log(result.text);
  if (result.isError) process.exitCode = 1;
  counter.close();
}

main().catch((err) => {
  console.error(err instanceof StockroomError ? err.message : err.stack);
  process.exitCode = 1;
});
