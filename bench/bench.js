// Benchmark: loose files vs. the stockroom index, on the same tasks.
//
//   npm run bench                      # the Crumb & Co. sample
//   node bench/bench.js --runs=9       # more runs per measurement
//
// Tokens are counted with the o200k_base encoding (gpt-tokenizer). Other models
// count a little differently, but the comparison holds.

import fs from 'node:fs';
import path from 'node:path';
import { encode } from 'gpt-tokenizer/encoding/o200k_base';
import { build } from '../src/build.js';
import { Counter } from '../src/counter.js';
import { BINARY_EXTENSIONS } from '../src/walk.js';
import { TASKS } from './tasks.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const ROOT = path.resolve(args.root ?? new URL('../examples/crumb-and-co/', import.meta.url).pathname);
const RUNS = Number(args.runs ?? 5);
const SKIP = new Set(['.git', 'node_modules', '.stockroom']);

// ------------------------------------------------------------ loose world

function allFiles(dir = ROOT) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...allFiles(abs));
    else out.push(abs);
  }
  return out;
}

const LOOSE = {
  // Like `ls -p`: names only.
  ls(dir) {
    return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
      .filter((e) => !SKIP.has(e.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort().join('\n');
  },
  // Like `grep -rIin`: every line in every text file that contains the text.
  grep(text) {
    const needle = text.toLowerCase();
    const out = [];
    for (const abs of allFiles()) {
      const buf = fs.readFileSync(abs);
      if (BINARY_EXTENSIONS.has(path.extname(abs).toLowerCase()) || buf.subarray(0, 8000).includes(0)) continue;
      const lines = buf.toString('utf8').split('\n');
      lines.forEach((line, i) => {
        if (line.toLowerCase().includes(needle)) out.push(`${path.relative(ROOT, abs)}:${i + 1}:${line}`);
      });
    }
    return out.join('\n');
  },
  // Like `cat`: the whole file.
  cat(file) {
    return fs.readFileSync(path.join(ROOT, file), 'utf8');
  },
};

// ------------------------------------------------------------------ runner

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function runLoose(task) {
  return task.loose.map(([tool, arg]) => LOOSE[tool](arg)).join('\n');
}

function runIndex(task) {
  const counter = new Counter({ root: ROOT, maxCalls: Infinity });
  const text = task.index.map(([tool, a]) => {
    const r = counter.call(tool, a);
    if (r.isError) throw new Error(`${tool} failed: ${r.text}`);
    return r.text;
  }).join('\n');
  counter.close();
  return text;
}

function measure(fn, task) {
  let text = '';
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    text = fn(task);
    times.push(performance.now() - t);
  }
  const missing = task.evidence.filter((e) => !text.includes(e));
  return { bytes: Buffer.byteLength(text), tokens: encode(text).length, ms: median(times), missing };
}

const built = build(ROOT);
const rows = TASKS.map((task) => ({
  job: task.job,
  title: task.title,
  loose: { calls: task.loose.length, ...measure(runLoose, task) },
  index: { calls: task.index.length, ...measure(runIndex, task) },
}));

const sum = (world, key) => rows.reduce((n, r) => n + r[world][key], 0);
const totals = Object.fromEntries(['loose', 'index'].map((w) => [w, {
  calls: sum(w, 'calls'), bytes: sum(w, 'bytes'), tokens: sum(w, 'tokens'), ms: sum(w, 'ms'),
  found: rows.filter((r) => !r[w].missing.length).length,
}]));

const fmtMs = (ms) => (ms < 1 ? 'under 1 ms' : ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(1)} s`);
console.log(`Index: ${built.counts.files} files, ${(built.bytes / 1024).toFixed(0)} KB, built in ${built.buildMs.toFixed(0)} ms\n`);
console.log('| Job | Task | Loose: calls | Loose: tokens | Loose: time | Index: calls | Index: tokens | Index: time |');
console.log('|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  const flag = (w) => (r[w].missing.length ? ` (missed ${r[w].missing.join(', ')})` : '');
  console.log(`| ${r.job} | ${r.title} | ${r.loose.calls} | ${r.loose.tokens.toLocaleString()}${flag('loose')} | ${fmtMs(r.loose.ms)} | ${r.index.calls} | ${r.index.tokens.toLocaleString()}${flag('index')} | ${fmtMs(r.index.ms)} |`);
}
const t = totals;
console.log(`| **Total** | | **${t.loose.calls}** | **${t.loose.tokens.toLocaleString()}** | **${fmtMs(t.loose.ms)}** | **${t.index.calls}** | **${t.index.tokens.toLocaleString()}** | **${fmtMs(t.index.ms)}** |`);
console.log(`\nEvidence found: loose ${t.loose.found}/${rows.length}, index ${t.index.found}/${rows.length}`);
console.log(`Tokens: ${(100 * (1 - t.index.tokens / t.loose.tokens)).toFixed(0)}% fewer with the index`);
console.log(`Median of ${RUNS} runs per measurement, Node ${process.version}, ${process.platform} ${process.arch}`);

fs.writeFileSync(new URL('./results.json', import.meta.url), `${JSON.stringify({ root: path.basename(ROOT), runs: RUNS, node: process.version, index: built.counts, rows, totals }, null, 2)}\n`);
