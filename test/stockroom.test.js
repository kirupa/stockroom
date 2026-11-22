import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { build } from '../src/build.js';
import { Counter } from '../src/counter.js';

const SAMPLE = new URL('../examples/crumb-and-co/', import.meta.url).pathname;
const BIN = new URL('../bin/stockroom.js', import.meta.url).pathname;

function copySample() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockroom-'));
  fs.cpSync(SAMPLE, dir, { recursive: true, filter: (src) => !src.includes('.stockroom') });
  return dir;
}

test('build catalogs every shelf and swaps the index in', () => {
  const root = copySample();
  const result = build(root);
  assert.ok(fs.existsSync(result.dbPath));
  assert.equal(fs.readdirSync(path.dirname(result.dbPath)).filter((f) => f.includes('.tmp-')).length, 0);
  assert.ok(result.counts.files > 25);
  assert.equal(result.counts.examples, 4);
  assert.equal(result.counts.skipped, 1);
});

test('the tools answer the questions a factory asks', () => {
  const root = copySample();
  build(root);
  const counter = new Counter({ root });

  const typo = counter.call('search_source', { query: 'recieve' });
  assert.match(typo.text, /site\/menu\.html:17/);

  const token = counter.call('find_symbol', { name: '--primary' }).data.groups[0];
  assert.equal(token.defsTotal, 2);
  assert.deepEqual(token.defs.map((d) => d.value), ['#c2410c', '#fb923c']);

  const soldOut = counter.call('find_symbol', { name: 'sold-out' }).data.groups.find((g) => g.name === '.sold-out');
  assert.equal(soldOut.defsTotal, 0);
  assert.equal(soldOut.uses[0].path, 'site/js/cart.js');

  const color = counter.call('find_symbol', { name: '#C2410C' }).data;
  assert.equal(color.tokens[0].name, '--primary');

  const refs = counter.call('follow_references', { path: 'site/menu.html' }).data.refs;
  assert.equal(refs.find((r) => r.raw === '/images/scone.svg').status, 'missing');
  assert.equal(refs.find((r) => r.kind === 'include').target, 'site/includes/header.html');

  const users = counter.call('who_references', { path: 'site/includes/header.html' }).data.refs;
  assert.deepEqual(users.map((r) => r.path), ['site/about.html', 'site/index.html', 'site/menu.html']);

  const section = counter.call('read_source', { path: 'guidance/arrows.md', section: 'Callout arrows' }).data;
  assert.equal(section.section, 'Arrows > Callout arrows');
  assert.match(section.lines.join('\n'), /middle of its caption/);
  assert.equal(section.sha256.length, 64);

  const rules = counter.call('find_rules', { for: 'slides', topic: 'punch' }).data.rules;
  assert.equal(rules[0].trail, 'Slide decks > Punch slides');
  const webRules = counter.call('find_rules', { for: 'web' }).data.rules;
  assert.ok(webRules.every((r) => !r.path.includes('slides.md')));

  const examples = counter.call('find_examples', { for: 'illustration', verdict: 'rejected' }).data.examples;
  assert.equal(examples.length, 1);
  assert.match(examples[0].note, /corner of its caption/);

  const listing = counter.call('list_source', { path: 'site/js' }).data;
  assert.equal(listing.skipped[0].reason, 'looks like it contains a secret');
  counter.close();
});

test('blind spots are named, not guessed', () => {
  const root = copySample();
  build(root);
  const counter = new Counter({ root });
  const secret = counter.call('read_source', { path: 'site/js/config.local.js' });
  assert.equal(secret.isError, true);
  assert.match(secret.text, /on purpose/);
  const typo = counter.call('read_source', { path: 'site/css/site.cs' });
  assert.match(typo.text, /isn't in the index/);
  counter.close();
});

test('a stale index refuses to answer until it is rebuilt', () => {
  const root = copySample();
  build(root);
  const counter = new Counter({ root, freshnessIntervalMs: 0 });
  const css = path.join(root, 'site/css/site.css');

  const now = new Date();
  fs.utimesSync(css, now, new Date(now.getTime() + 5000));
  assert.equal(counter.call('search_source', { query: 'card' }).isError, false, 'a touched but unchanged file is still current');

  fs.appendFileSync(css, '\n.sold-out { opacity: 0.6; }\n');
  const stale = counter.call('find_symbol', { name: '.sold-out' });
  assert.equal(stale.isError, true);
  assert.match(stale.text, /site\/css\/site\.css \(changed\)/);

  build(root);
  const fresh = counter.call('find_symbol', { name: '.sold-out' });
  assert.equal(fresh.isError, false);
  assert.equal(fresh.data.groups[0].defsTotal, 1);
  counter.close();
});

test('the session budget ends with a polite "time\'s up"', () => {
  const root = copySample();
  build(root);
  const counter = new Counter({ root, maxCalls: 2 });
  counter.call('list_source', {});
  counter.call('list_source', {});
  assert.match(counter.call('list_source', {}).text, /Time's up/);
  counter.close();
});

test('the MCP server lists and runs the tools', async () => {
  const root = copySample();
  build(root);
  const child = spawn(process.execPath, [BIN, 'serve', `--root=${root}`]);
  const lines = [];
  child.stdout.on('data', (chunk) => lines.push(...chunk.toString().split('\n').filter(Boolean)));
  const send = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/list' });
  send({ id: 3, method: 'tools/call', params: { name: 'find_rules', arguments: { for: 'illustration', topic: 'callout' } } });
  child.stdin.end();
  await new Promise((resolve) => child.on('close', resolve));

  const replies = Object.fromEntries(lines.map((l) => JSON.parse(l)).map((m) => [m.id, m]));
  assert.equal(replies[1].result.serverInfo.name, 'stockroom');
  assert.equal(replies[2].result.tools.length, 8);
  assert.match(replies[3].result.content[0].text, /Handwritten callouts/);
  assert.equal(Object.keys(replies).length, 3, 'notifications get no reply');
});

test('changing stockroom.json alone makes the index stale', () => {
  const root = copySample();
  build(root);
  const counter = new Counter({ root, freshnessIntervalMs: 0 });
  const file = path.join(root, 'stockroom.json');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"for": ["web"]', '"for": ["slides"]'));
  const result = counter.call('find_rules', { for: 'web' });
  assert.equal(result.isError, true);
  assert.match(result.text, /stockroom\.json \(changed\)/);
  counter.close();
});

test('an index stored inside the root never catalogs itself', () => {
  const root = copySample();
  const dbPath = path.join(root, 'index.db');
  build(root, { dbPath });
  build(root, { dbPath });
  const counter = new Counter({ root, dbPath, freshnessIntervalMs: 0 });
  const listing = counter.call('list_source', {});
  assert.equal(listing.isError, false, listing.text);
  assert.ok(!listing.text.includes('index.db'));
  counter.close();
});

test('read_source keeps odd ranges inside the file and the line limit', () => {
  const root = copySample();
  build(root);
  const counter = new Counter({ root });
  const read = counter.call('read_source', { path: 'site/css/site.css', start: 10, end: -5 }).data;
  assert.equal(read.start, 10);
  assert.equal(read.end, 10);
  assert.equal(counter.call('find_examples', { for: 'Illustration' }).data.total, 2);
  counter.close();
});

test('the MCP server survives malformed messages and negotiates its version', async () => {
  const root = copySample();
  build(root);
  const child = spawn(process.execPath, [BIN, 'serve', `--root=${root}`]);
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stdin.write('null\n[1,2]\n{"jsonrpc":"2.0","id":1,"method":"initialize","params":null}\n');
  child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}\n');
  child.stdin.end('{"jsonrpc":"2.0","id":3,"method":"ping"}\n');
  const code = await new Promise((resolve) => child.on('close', resolve));
  const replies = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(code, 0);
  assert.equal(replies.filter((r) => r.error?.code === -32600).length, 2);
  assert.equal(replies.find((r) => r.id === 2).result.protocolVersion, '2025-06-18');
  assert.deepEqual(replies.find((r) => r.id === 3).result, {});
});

test('report --strict fails on problems and passes when they are fixed', async () => {
  const root = copySample();
  build(root);
  const run = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'report', '--strict', `--root=${root}`]);
    child.on('close', resolve);
  });
  assert.equal(await run(), 1);
  const fix = (file, from, to) => {
    const p = path.join(root, file);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replaceAll(from, to));
  };
  fix('site/menu.html', '/images/scone.svg', '/images/cranberry-scone.svg');
  fix('site/css/site.css', '  src: url("../fonts/fraunces.woff2") format("woff2");\n', '');
  fix('site/js/cart.js', "'sold-out'", "'is-sold-out'");
  fix('figures/how-sourdough-rises.svg', '#3b82f6', '#c2410c');
  build(root);
  assert.equal(await run(), 0);
});

test('serve --watch builds a missing index and keeps it current', async () => {
  const root = copySample();
  const child = spawn(process.execPath, [BIN, 'serve', '--watch', `--root=${root}`]);
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  const ask = (id) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'find_symbol', arguments: { name: '.is-new' } } })}\n`);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(300);
  ask(1);
  await wait(300);
  fs.appendFileSync(path.join(root, 'site/css/site.css'), '\n.is-new { color: var(--ink); }\n');
  ask(2);
  await wait(500);
  child.stdin.end();
  await new Promise((r) => child.on('close', r));
  const replies = Object.fromEntries(out.trim().split('\n').map((l) => JSON.parse(l)).map((m) => [m.id, m.result.content[0].text]));
  assert.match(replies[1], /no definitions/);
  assert.match(replies[2], /\.is-new \(class\): 1 definition/);
});
