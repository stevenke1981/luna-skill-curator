// Markdown helpers for translating skills: front matter, chunking for the generator, and a
// structure check for what a translation must keep (code, links, headings) and must not leave
// in Chinese.

const HEADING = /^#{1,6}(?=\s|$)/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const URL_RE = /https?:\/\/[^\s<>"'`()[\]]+/g;
const LINK_RE = /\[[^\]\n]*\]\(([^)\n]*)\)/g;
const INLINE_RE = /`([^`\n]+)`/g;
// CJK ideographs, CJK symbols and punctuation, and fullwidth forms.
const CJK_RANGES = [
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff], [0x20000, 0x2fa1f], // ideographs
  [0x3000, 0x303f], [0xff00, 0xffef], // punctuation, fullwidth forms
];
const MAX_ISSUE_LINE = 80;

const BOM = '﻿';

// Splits text into lines, each keeping its own line ending, so that lines.join('') === text.
function lineList(text) {
  return text === '' ? [] : text.split(/(?<=\n)/);
}

const stripEol = (raw) => raw.replace(/\r?\n?$/, '');

// Walks the lines once and tracks fenced code. Returns, per line, whether it belongs to a fence
// (delimiters included), and the fences found, with their lines.
function scanLines(lines) {
  const inFence = new Array(lines.length).fill(false);
  const fences = [];
  let open = null;
  lines.forEach((raw, i) => {
    const line = stripEol(raw);
    if (!open) {
      const m = FENCE_OPEN.exec(line);
      // A backtick fence's info string cannot contain a backtick; without this rule a line of
      // inline code such as ```x``` would open a fence.
      if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
        open = { char: m[1][0], len: m[1].length, info: m[2].trim(), lines: [] };
        inFence[i] = true;
      }
      return;
    }
    inFence[i] = true;
    const close = FENCE_CLOSE.exec(line);
    if (close && close[1][0] === open.char && close[1].length >= open.len) {
      fences.push({ info: open.info, lines: open.lines });
      open = null;
    } else {
      open.lines.push(line);
    }
  });
  // An unclosed fence runs to the end of the text, as it does when rendered.
  if (open) fences.push({ info: open.info, lines: open.lines });
  return { inFence, fences };
}

// ---- front matter ----

export function splitFrontMatter(text) {
  const s = text.startsWith(BOM) ? text.slice(1) : text;
  const open = /^---[ \t]*\r?\n/.exec(s);
  if (!open) return { frontMatter: null, body: s };
  const rest = s.slice(open[0].length);
  // The closing fence is a line of its own; the match is anchored to line starts.
  const close = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!close) return { frontMatter: null, body: s };
  const frontMatter = rest.slice(0, close.index).replace(/\r\n/g, '\n').replace(/\n$/, '');
  // Blank lines after the fence are dropped; joinFrontMatter adds its own separator.
  const body = rest.slice(close.index + close[0].length).replace(/^(?:[ \t]*\r?\n)+/, '');
  return { frontMatter, body };
}

export function joinFrontMatter(frontMatter, body) {
  if (frontMatter == null) return body;
  return `---\n${frontMatter}\n---\n\n${body}`;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const keyRe = (key) => new RegExp(`^${escapeRe(key)}[ \\t]*:(.*)$`);

// Indented lines (and blank lines between them) after a key line, without trailing blanks.
function continuation(lines, from) {
  const out = [];
  for (let i = from; i < lines.length; i++) {
    if (/^[ \t]/.test(lines[i]) || lines[i].trim() === '') out.push(lines[i]);
    else break;
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return out;
}

function parseDoubleQuoted(s) {
  const escapes = { n: '\n', t: '\t', r: '\r', '0': '\0', '"': '"', '\\': '\\', '/': '/', ' ': ' ' };
  let out = '';
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (c === '"') return out;
    if (c !== '\\' || i + 1 >= s.length) {
      out += c;
      continue;
    }
    const n = s[++i];
    const hex = s.slice(i + 1, i + 5);
    if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(hex)) {
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else {
      out += escapes[n] ?? n;
    }
  }
  return out; // unterminated: best effort
}

function parseSingleQuoted(s) {
  let out = '';
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (c !== "'") {
      out += c;
    } else if (s[i + 1] === "'") {
      out += "'";
      i++;
    } else {
      return out;
    }
  }
  return out;
}

// Reads one top-level field as a single line. Block scalars (| and >) are joined with spaces,
// and quoted or plain values may continue on indented lines.
export function frontMatterField(fm, key) {
  const lines = String(fm ?? '').split(/\r?\n/);
  const re = keyRe(key);
  const at = lines.findIndex((l) => re.test(l));
  if (at < 0) return '';
  const header = re.exec(lines[at])[1].trim();
  const cont = continuation(lines, at + 1);
  const words = cont.map((l) => l.trim()).filter(Boolean);

  if (/^[|>][-+0-9]*\s*(?:#.*)?$/.test(header)) return words.join(' ');
  const raw = [header, ...words].join(' ').trim();
  if (raw.startsWith('"')) return parseDoubleQuoted(raw);
  if (raw.startsWith("'")) return parseSingleQuoted(raw);
  return raw.replace(/(^|\s+)#.*$/, '').trim();
}

// Plain values are safe unless they start like a YAML indicator or carry a character that
// changes their meaning; anything else is double-quoted.
const RESERVED = /^(?:true|false|yes|no|on|off|null|~)$/i;
const NUMBERISH = /^[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i;

function quoteValue(v) {
  const needsQuotes =
    v === '' ||
    /[:#"'\n\r\t]/.test(v) ||
    /^[\s\-?:,[\]{}#&*!|>%@`]/.test(v) ||
    /\s$/.test(v) ||
    RESERVED.test(v) ||
    NUMBERISH.test(v);
  if (!needsQuotes) return v;
  const escaped = v
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

// Replaces a top-level field (its continuation lines too) or appends it when missing.
export function setFrontMatterField(fm, key, value) {
  const lines = fm ? String(fm).split(/\r?\n/) : [];
  const line = `${key}: ${quoteValue(String(value))}`;
  const re = keyRe(key);
  const at = lines.findIndex((l) => re.test(l));
  if (at < 0) {
    lines.push(line);
    return lines.join('\n');
  }
  const nextIsIndented = (from) => {
    for (let j = from; j < lines.length; j++) {
      if (lines[j].trim() !== '') return /^[ \t]/.test(lines[j]);
    }
    return false;
  };
  let end = at + 1;
  while (end < lines.length && (/^[ \t]/.test(lines[end]) || (lines[end].trim() === '' && nextIsIndented(end)))) {
    end++;
  }
  lines.splice(at, end - at, line);
  return lines.join('\n');
}

// ---- CJK measures ----

export function cjkCount(text) {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (CJK_RANGES.some(([lo, hi]) => c >= lo && c <= hi)) n++;
  }
  return n;
}

export function cjkRatio(text) {
  let total = 0;
  for (const ch of text) {
    if (!/\s/.test(ch)) total++;
  }
  return total ? cjkCount(text) / total : 0;
}

// ---- chunking ----

// Splits one section (no heading inside it, apart from its first line) that is larger than
// max. Blocks end at a blank line outside fences; a block with a fence is never cut, and a
// fence-free block too long for max is cut at line ends.
function splitLarge(lines, flags, max) {
  const blocks = [];
  let block = [];
  lines.forEach((raw, i) => {
    block.push(i);
    if (!flags[i] && raw.trim() === '') {
      blocks.push(block);
      block = [];
    }
  });
  if (block.length) blocks.push(block);

  const pieces = [];
  for (const b of blocks) {
    const text = b.map((i) => lines[i]).join('');
    if (text.length <= max || b.some((i) => flags[i])) {
      pieces.push(text);
      continue;
    }
    let cur = '';
    for (const i of b) {
      if (cur && cur.length + lines[i].length > max) {
        pieces.push(cur);
        cur = '';
      }
      cur += lines[i];
    }
    if (cur) pieces.push(cur);
  }
  return pieces;
}

// Splits body into chunks of at most maxChars where possible, and chunks.join('') === body.
// Splits fall only at headings outside fences (whole sections are packed together) or, for a
// section larger than maxChars, at blank lines and line ends outside fences.
export function chunkMarkdown(body, maxChars = 6000) {
  const lines = lineList(body);
  if (lines.length === 0) return [];
  const { inFence } = scanLines(lines);

  const starts = [0];
  lines.forEach((raw, i) => {
    if (i > 0 && !inFence[i] && HEADING.test(stripEol(raw))) starts.push(i);
  });

  const pieces = [];
  starts.forEach((from, s) => {
    const to = s + 1 < starts.length ? starts[s + 1] : lines.length;
    const sectionLines = lines.slice(from, to);
    const text = sectionLines.join('');
    if (text.length <= maxChars) pieces.push(text);
    else pieces.push(...splitLarge(sectionLines, inFence.slice(from, to), maxChars));
  });

  const chunks = [];
  let cur = '';
  for (const p of pieces) {
    if (cur && cur.length + p.length > maxChars) {
      chunks.push(cur);
      cur = '';
    }
    cur += p;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// ---- structure ----

const trimUrl = (u) => u.replace(/[.,;:!?*_~]+$/, '');
const hasCjk = (s) => cjkCount(s) > 0;

// Headings (outside fences), fenced code blocks, http(s) URLs, link targets and inline code
// spans (outside fences). URLs and link targets are taken from the whole text.
export function markdownStructure(text) {
  const lines = lineList(text);
  const { inFence, fences } = scanLines(lines);
  let headings = 0;
  const inline = [];
  lines.forEach((raw, i) => {
    if (inFence[i]) return;
    const line = stripEol(raw);
    if (HEADING.test(line)) headings++;
    for (const m of line.matchAll(INLINE_RE)) inline.push(m[1]);
  });
  return {
    headings,
    fences,
    urls: [...text.matchAll(URL_RE)].map((m) => trimUrl(m[0])),
    linkTargets: [...text.matchAll(LINK_RE)].map((m) => m[1].trim()),
    inlineCode: inline,
  };
}

const short = (s) => (s.length > MAX_ISSUE_LINE ? `${s.slice(0, MAX_ISSUE_LINE)}...` : s);

// Compares a translation with its original. Returns { ok, problems } where each problem is a
// short English sentence. Lines or spans that contain Chinese are skipped, since translating
// them is the point; comments inside code may change, code itself may not.
export function compareStructure(original, translation) {
  const a = markdownStructure(original);
  const b = markdownStructure(translation);
  const problems = [];

  if (a.headings !== b.headings) {
    problems.push(`heading count differs: original ${a.headings}, translation ${b.headings}`);
  }
  if (a.fences.length !== b.fences.length) {
    problems.push(`code block count differs: original ${a.fences.length}, translation ${b.fences.length}`);
  }
  a.fences.forEach((f, i) => {
    const g = b.fences[i];
    if (!g) return;
    const kept = new Set(g.lines.map((l) => l.trimEnd()));
    for (const line of f.lines) {
      if (!line.trim() || hasCjk(line)) continue;
      if (!kept.has(line.trimEnd())) problems.push(`code block ${i + 1} lost line: ${short(line.trim())}`);
    }
  });

  const urls = new Set(b.urls);
  for (const u of new Set(a.urls)) {
    if (!urls.has(u)) problems.push(`URL lost: ${short(u)}`);
  }
  const targets = new Set(b.linkTargets);
  for (const t of new Set(a.linkTargets)) {
    if (!targets.has(t)) problems.push(`link target lost: ${short(t)}`);
  }
  const spans = new Set(b.inlineCode);
  for (const c of new Set(a.inlineCode)) {
    if (!hasCjk(c) && !spans.has(c)) problems.push(`inline code lost: ${short(c)}`);
  }

  const ratio = cjkRatio(translation);
  if (ratio > 0.01) {
    problems.push(`translation still contains Chinese text (${(ratio * 100).toFixed(1)}% of characters)`);
  }
  return { ok: problems.length === 0, problems };
}
