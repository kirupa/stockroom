// Extractors read one file and pull out what the stockroom catalogs: names that
// are defined or used (symbols), links to other files (refs), sections of
// guidance, and a one-line summary. They are regular expressions, not full
// parsers. That keeps stockroom dependency-free, and it's accurate enough for
// "where is this defined?" and "what uses this?" questions.

const JS_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new',
  'await', 'async', 'with', 'super', 'import', 'export', 'delete', 'void', 'in',
  'of', 'do', 'else', 'try', 'case', 'throw', 'yield', 'class', 'constructor',
]);

export function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineAt(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

const blank = (s) => s.replace(/[^\n]/g, ' ');

export class Collector {
  constructor(text) {
    this.text = text;
    this.starts = lineStarts(text);
    this.symbols = [];
    this.refs = [];
    this.sections = [];
    this.summary = null;
    this.meta = {};
  }

  line(offset) {
    return lineAt(this.starts, offset);
  }

  sym(name, kind, role, offset, extra = {}) {
    this.symbols.push({
      name, kind, role, line: this.line(offset), scope: extra.scope ?? null, value: extra.value ?? null,
    });
  }

  ref(raw, kind, offset) {
    const clean = raw.trim();
    if (clean) this.refs.push({ raw: clean, kind, line: this.line(offset) });
  }
}

export function extract(lang, text) {
  const c = new Collector(text);
  if (lang === 'html') extractMarkup(c, text, false);
  else if (lang === 'svg') extractMarkup(c, text, true);
  else if (lang === 'css') { extractCss(c, text, 0, text.length); c.summary = leadingComment(text); }
  else if (lang === 'js') { extractJs(c, text, 0, text.length); c.summary = leadingComment(text); }
  else if (lang === 'md') extractMarkdown(c, text);
  else if (lang === 'json') c.summary = jsonSummary(text);
  else c.summary = firstLine(text);
  return c;
}

// ---------------------------------------------------------------- HTML + SVG

const ATTR = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const COLOR_ATTRS = new Set(['fill', 'stroke', 'stop-color', 'color', 'flood-color', 'lighting-color']);

function extractMarkup(c, text, isSvg) {
  const TAG = /<!--([\s\S]*?)-->|<(script|style)\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/\2\s*>|<([a-zA-Z][\w:-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
  for (const m of text.matchAll(TAG)) {
    if (m[1] !== undefined) {
      const inc = m[1].match(/^\s*#include\s+(?:virtual|file)\s*=\s*"([^"]+)"/);
      if (inc) c.ref(inc[1], 'include', m.index);
      continue;
    }
    if (m[2]) {
      const tag = m[2].toLowerCase();
      const attrs = parseAttrs(m[3], m.index + 1 + m[2].length);
      const contentStart = m.index + m[0].indexOf('>') + 1;
      const contentEnd = contentStart + m[4].length;
      if (tag === 'script') {
        const src = attrs.get('src');
        if (src) c.ref(src.value, 'script', src.offset);
        else if (m[4].trim()) extractJs(c, text, contentStart, contentEnd);
      } else {
        extractCss(c, text, contentStart, contentEnd);
      }
      tagAttributes(c, tag, attrs, isSvg);
      continue;
    }
    const tag = m[5].toLowerCase();
    const attrs = parseAttrs(m[6], m.index + 1 + m[5].length);
    tagAttributes(c, tag, attrs, isSvg);
  }

  if (isSvg) {
    const title = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const desc = text.match(/<desc[^>]*>([\s\S]*?)<\/desc>/i);
    c.summary = clip([title?.[1], desc?.[1]].filter(Boolean).map(decode).join(': '));
  } else {
    const title = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const desc = text.match(/<meta\s+[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["']/i)
      || text.match(/<meta\s+[^>]*content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']description["']/i);
    const h1 = text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    c.summary = clip([title?.[1] ?? h1?.[1], desc?.[1]].filter(Boolean).map(decode).join(' - '))
      || clip(firstLine(text.replace(/<[^>]+>/g, ' ')));
  }
}

function parseAttrs(source, base) {
  const attrs = new Map();
  for (const m of source.matchAll(ATTR)) {
    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    const valueOffset = base + m.index + m[0].length - value.length - (m[2] !== undefined || m[3] !== undefined ? 1 : 0);
    attrs.set(name, { value, offset: valueOffset });
  }
  return attrs;
}

function tagAttributes(c, tag, attrs, isSvg) {
  const get = (n) => attrs.get(n);

  const id = get('id');
  if (id && /^[\w-]+$/.test(id.value)) c.sym(`#${id.value}`, 'id', 'def', id.offset);

  const cls = get('class');
  if (cls) {
    for (const m of cls.value.matchAll(/[^\s]+/g)) {
      if (/^[A-Za-z_-][\w-]*$/.test(m[0])) c.sym(`.${m[0]}`, 'class', 'use', cls.offset + m.index);
    }
  }

  const style = get('style');
  if (style) declarations(c, style.value, style.offset, { scope: `<${tag} style>`, font: false, defs: true });

  for (const [name, attr] of attrs) {
    if (name.startsWith('on') && attr.value) callsIn(c, attr.value, attr.offset);
    if (isSvg && COLOR_ATTRS.has(name)) colorValue(c, attr.value, attr.offset);
  }

  const href = get('href') ?? get('xlink:href');
  const src = get('src');
  const rel = (get('rel')?.value || '').toLowerCase();

  if (tag === 'link' && href) {
    const kind = rel.includes('stylesheet') ? 'stylesheet'
      : /icon|image|apple-touch/.test(rel) ? 'image'
        : rel.includes('preload') || rel.includes('modulepreload') ? 'asset'
          : 'link';
    c.ref(href.value, kind, href.offset);
  } else if ((tag === 'a' || tag === 'area') && href) {
    c.ref(href.value, 'link', href.offset);
  } else if ((tag === 'use' || tag === 'image' || tag === 'feimage') && href && !href.value.startsWith('#')) {
    c.ref(href.value.split('#')[0], 'image', href.offset);
  }

  if (src && tag !== 'script') {
    const kind = tag === 'img' || tag === 'input' ? 'image' : tag === 'iframe' || tag === 'frame' ? 'page' : 'media';
    c.ref(src.value, kind, src.offset);
  }
  for (const n of ['srcset', 'imagesrcset']) {
    const set = get(n);
    if (set) {
      for (const part of set.value.split(',')) {
        const url = part.trim().split(/\s+/)[0];
        if (url) c.ref(url, 'image', set.offset + set.value.indexOf(url));
      }
    }
  }
  const poster = get('poster');
  if (poster) c.ref(poster.value, 'image', poster.offset);
  const data = get('data');
  if (tag === 'object' && data) c.ref(data.value, 'media', data.offset);
}

// ----------------------------------------------------------------------- CSS

export function extractCss(c, text, start, end) {
  const src = text.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, blank);

  for (const m of src.matchAll(/@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1/g)) {
    c.ref(m[2], 'stylesheet', start + m.index + m[0].indexOf(m[2]));
  }

  const stack = [];
  let seg = 0;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      const close = src.indexOf(ch, i + 1);
      i = close < 0 ? src.length : close + 1;
      continue;
    }
    if (ch === '{') {
      const prelude = src.slice(seg, i);
      const preludeStart = seg + (prelude.length - prelude.trimStart().length);
      const p = prelude.trim();
      let frame;
      if (p.startsWith('@')) {
        const leaf = /^@(font-face|page|property|counter-style)\b/i.test(p);
        frame = { type: leaf ? 'leaf' : 'group', at: p.toLowerCase(), start: i + 1, kids: [] };
        const prop = p.match(/^@property\s+(--[\w-]+)/i);
        if (prop) c.sym(prop[1], 'token', 'def', start + preludeStart + p.indexOf(prop[1]), { scope: '@property' });
      } else {
        frame = { type: 'rule', selector: p.replace(/\s+/g, ' '), start: i + 1, kids: [] };
        selectorDefs(c, p, start + preludeStart);
      }
      const parent = stack[stack.length - 1];
      if (parent) {
        parent.kids.push([i, src.length]);
        frame.slot = parent.kids.length - 1;
      }
      stack.push(frame);
      seg = i + 1;
      i++;
      continue;
    }
    if (ch === '}') {
      const frame = stack.pop();
      if (frame) {
        if (frame.type !== 'group') {
          let own = src.slice(frame.start, i);
          for (const [a, b] of frame.kids) {
            const from = a - frame.start;
            const to = Math.min(b, i) - frame.start + 1;
            own = own.slice(0, from) + blank(own.slice(from, to)) + own.slice(to);
          }
          declarations(c, own, start + frame.start, {
            scope: frame.selector ?? frame.at,
            font: frame.at?.startsWith('@font-face'),
            defs: true,
          });
        }
        const parent = stack[stack.length - 1];
        if (parent && frame.slot !== undefined) parent.kids[frame.slot][1] = i;
      }
      seg = i + 1;
      i++;
      continue;
    }
    if (ch === ';') seg = i + 1;
    i++;
  }
}

function selectorDefs(c, selector, offset) {
  const s = selector.replace(/\[[^\]]*\]/g, blank).replace(/(["'])(?:(?!\1).)*\1/g, blank);
  for (const m of s.matchAll(/(?<!\\)\.(-?[_a-zA-Z][\w-]*)/g)) {
    c.sym(`.${m[1]}`, 'class', 'def', offset + m.index);
  }
  for (const m of s.matchAll(/(?<![\\&])#(-?[_a-zA-Z][\w-]*)/g)) {
    c.sym(`#${m[1]}`, 'id', 'def', offset + m.index);
  }
}

function declarations(c, text, offset, { scope, font, defs }) {
  if (defs) {
    for (const m of text.matchAll(/(--[\w-]+)\s*:\s*([^;{}]*)/g)) {
      const value = m[2].replace(/\/\*.*?\*\//g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
      c.sym(m[1], 'token', 'def', offset + m.index, { scope, value });
    }
  }
  tokenUses(c, text, offset);
  for (const m of text.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
    if (!m[2].startsWith('#')) c.ref(m[2], font ? 'font' : 'image', offset + m.index + m[0].indexOf(m[2]));
  }
  for (const m of text.matchAll(/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g)) {
    c.sym(m[0].toLowerCase(), 'color', 'use', offset + m.index);
  }
}

function tokenUses(c, text, offset) {
  for (const m of text.matchAll(/var\(\s*(--[\w-]+)/g)) {
    c.sym(m[1], 'token', 'use', offset + m.index + m[0].indexOf('--'));
  }
}

function colorValue(c, value, offset) {
  const hex = value.trim().match(/^#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})$/);
  if (hex) c.sym(hex[0].toLowerCase(), 'color', 'use', offset);
  tokenUses(c, value, offset);
}

// ---------------------------------------------------------------- JavaScript

export function extractJs(c, text, start, end) {
  const src = text.slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:\\'"`\w])\/\/[^\n]*/g, (m, p) => p + blank(m.slice(p.length)));

  const defOffsets = new Set();
  const def = (name, at) => {
    if (JS_KEYWORDS.has(name)) return;
    defOffsets.add(at);
    c.sym(name, 'function', 'def', start + at);
  };
  for (const m of src.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)) def(m[1], m.index + m[0].indexOf(m[1]));
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g)) {
    def(m[1], m.index + m[0].indexOf(m[1]));
  }
  for (const m of src.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) def(m[1], m.index + m[0].indexOf(m[1]));
  for (const m of src.matchAll(/^[ \t]*(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^()\n]*\)\s*\{/gm)) {
    def(m[1], m.index + m[0].indexOf(m[1]));
  }
  callsIn(c, src, start, defOffsets);

  const strings = (args) => [...args.matchAll(/(['"`])([^'"`]+)\1/g)].map((s) => s[2]);
  for (const m of src.matchAll(/classList\.(?:add|remove|toggle|contains|replace)\(([^)]*)\)/g)) {
    for (const name of strings(m[1])) {
      if (/^[A-Za-z_-][\w-]*$/.test(name)) c.sym(`.${name}`, 'class', 'use', start + m.index);
    }
  }
  for (const m of src.matchAll(/(?:querySelector(?:All)?|closest|matches)\(\s*(['"`])([^'"`]+)\1/g)) {
    const sel = m[2].replace(/\[[^\]]*\]/g, ' ');
    for (const s of sel.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) c.sym(`.${s[1]}`, 'class', 'use', start + m.index);
    for (const s of sel.matchAll(/#(-?[_a-zA-Z][\w-]*)/g)) c.sym(`#${s[1]}`, 'id', 'use', start + m.index);
  }
  for (const m of src.matchAll(/getElementById\(\s*(['"`])([\w-]+)\1/g)) c.sym(`#${m[2]}`, 'id', 'use', start + m.index);
  for (const m of src.matchAll(/getElementsByClassName\(\s*(['"`])([\w-]+)\1/g)) c.sym(`.${m[2]}`, 'class', 'use', start + m.index);
  for (const m of src.matchAll(/\bclassName\s*=\s*(['"`])([^'"`]+)\1/g)) {
    for (const name of m[2].split(/\s+/)) if (/^[A-Za-z_-][\w-]*$/.test(name)) c.sym(`.${name}`, 'class', 'use', start + m.index);
  }
  const setters = new Set();
  for (const m of src.matchAll(/\.setProperty\(\s*(['"`])(--[\w-]+)\1/g)) {
    const at = m.index + m[0].indexOf(m[1]);
    setters.add(at);
    c.sym(m[2], 'token', 'def', start + at + 1, { scope: 'set by JavaScript' });
  }
  for (const m of src.matchAll(/(['"`])(--[\w-]+)\1/g)) {
    if (!setters.has(m.index)) c.sym(m[2], 'token', 'use', start + m.index + 1);
  }
  tokenUses(c, src, start);

  for (const m of src.matchAll(/\bimport\s+(?:[^'"`;]*?\bfrom\s*)?(['"])([^'"]+)\1/g)) c.ref(m[2], 'import', start + m.index);
  for (const m of src.matchAll(/\b(?:import|require)\(\s*(['"])([^'"]+)\1\s*\)/g)) c.ref(m[2], 'import', start + m.index);
  for (const m of src.matchAll(/\bfetch\(\s*(['"`])([^'"`$]+)\1/g)) c.ref(m[2], 'data', start + m.index);
}

function callsIn(c, src, start, skip = new Set()) {
  for (const m of src.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (JS_KEYWORDS.has(m[1]) || skip.has(m.index)) continue;
    c.sym(m[1], 'function', 'use', start + m.index);
  }
}

// ------------------------------------------------------------------ Markdown

export function frontMatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, bodyStart: 0 };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    } else {
      value = value.replace(/^['"]|['"]$/g, '');
    }
    meta[kv[1]] = value;
  }
  return { meta, bodyStart: m[0].length };
}

function extractMarkdown(c, text) {
  const { meta, bodyStart } = frontMatter(text);
  c.meta = meta;

  const lines = text.split('\n');
  const firstBodyLine = text.slice(0, bodyStart).split('\n').length;
  const open = [];
  let fence = null;
  let firstParagraph = null;
  for (let n = firstBodyLine; n <= lines.length; n++) {
    const line = lines[n - 1] ?? '';
    const f = line.match(/^\s*(```|~~~)/);
    if (f) {
      fence = fence === f[1] ? null : fence ?? f[1];
      continue;
    }
    if (fence) continue;
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      const level = h[1].length;
      while (open.length && open[open.length - 1].level >= level) open.pop().end_line = n - 1;
      const trail = [...open.map((s) => s.heading), h[2]].join(' > ');
      const section = { heading: h[2], trail, level, start_line: n, end_line: lines.length };
      c.sections.push(section);
      open.push(section);
    } else if (!firstParagraph && line.trim() && !/^(---|[-*]\s|\d+\.\s|>|!\[)/.test(line.trim())) {
      firstParagraph = line.trim();
    }
  }
  for (const s of c.sections) {
    while (s.end_line > s.start_line && !(lines[s.end_line - 1] ?? '').trim()) s.end_line--;
  }

  for (const m of text.matchAll(/(!?)\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    c.ref(m[2], m[1] ? 'image' : 'link', m.index);
  }
  for (const m of text.matchAll(/`(--[\w-]+)`/g)) c.sym(m[1], 'token', 'use', m.index + 1);
  for (const m of text.matchAll(/`\.([A-Za-z_-][\w-]*)`/g)) c.sym(`.${m[1]}`, 'class', 'use', m.index + 1);
  for (const m of text.matchAll(/`(#[0-9a-fA-F]{3,8})`/g)) c.sym(m[1].toLowerCase(), 'color', 'use', m.index + 1);
  tokenUses(c, text, 0);

  c.summary = clip(meta.summary || meta.note || firstParagraph || c.sections[0]?.heading || '');
}

// ------------------------------------------------------------------- helpers

function leadingComment(text) {
  const m = text.match(/^\s*(?:\/\*+([\s\S]*?)\*\/|((?:[ \t]*\/\/[^\n]*\n?)+))/);
  if (!m) return null;
  const body = (m[1] ?? m[2]).replace(/^\s*(\*|\/\/)\s?/gm, '').replace(/\s+/g, ' ').trim();
  return clip(body.split(/(?<=\.)\s/)[0]);
}

function jsonSummary(text) {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (typeof value.description === 'string') return clip(value.description);
      return clip(`JSON with ${Object.keys(value).slice(0, 8).join(', ')}`);
    }
    return Array.isArray(value) ? `JSON list of ${value.length} items` : 'JSON value';
  } catch {
    return 'JSON (could not parse)';
  }
}

function firstLine(text) {
  return clip((text.split('\n').find((l) => l.trim()) || '').trim());
}

function decode(s) {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function clip(s, n = 200) {
  if (!s) return s || null;
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
