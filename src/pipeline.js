// The curation run: read packs, translate their Markdown into English with the generator, let
// Luna review each result (and retry once with its findings), then sort the skills into
// categories, look for overlapping skills, and write the English packs.
// The generator only writes; every judgement comes from Luna or a deterministic check.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readPack, writePack, zipPack } from './packs.js';
import {
  splitFrontMatter, joinFrontMatter, frontMatterField, setFrontMatterField, cjkRatio, chunkMarkdown, compareStructure,
} from './markdown.js';
import { PROMPT_VERSION } from './generate.js';

// A Markdown file with more Chinese than this is translated; below it, it is left as is.
const TRANSLATE_RATIO = 0.005;
// Luna's bar for accepting a translation without a second attempt.
export const THRESHOLDS = { faithful: 0.8, clear: 0.7, trigger: 0.7 };
// Text files whose Chinese is reported (not translated): code and data are left alone.
const TEXT_EXT = /\.(txt|json|ya?ml|toml|py|ps1|sh|cmd|bat|js|ts|c|h|s|asm|sv|v|csv|ini|cfg)$/i;
const MAX_OVERLAP_PAIRS = 40;
const OVERLAP_SIMILARITY = 0.2;
const OVERLAP_REPORTED = 0.6;
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'use', 'when', 'this', 'that', 'from', 'into', 'your', 'are', 'skill', 'skills',
  'agent', 'agents', 'using', 'used', 'such', 'its', 'any', 'all', 'can', 'not', 'how', 'what', 'which', 'or', 'of', 'to', 'in', 'on', 'a', 'an', 'is', 'it', 'as', 'by', 'be']);

/** The default categories Luna sorts skills into; --categories replaces them. */
export const CATEGORIES = [
  { value: 'software-engineering', description: 'building and changing application code, APIs, front ends, back ends' },
  { value: 'testing-and-quality', description: 'tests, reviews, verification, quality gates' },
  { value: 'devops-and-release', description: 'build systems, CI/CD, packaging, release, deployment' },
  { value: 'version-control', description: 'git, repositories, accounts, branching' },
  { value: 'storage-and-filesystems', description: 'disks, partitions, filesystems, backup, migration, NAS, archives' },
  { value: 'operating-systems', description: 'Windows, Linux or macOS administration and internals' },
  { value: 'hardware-and-eda', description: 'chip and board design, HDL, FPGA, circuits, EDA tools' },
  { value: 'low-level-and-assembly', description: 'assembly, disassembly, binaries, reverse engineering, CPU architecture' },
  { value: 'algorithms-and-systems', description: 'algorithms, data structures, concurrency, performance, distributed systems' },
  { value: 'file-formats', description: 'identifying and handling file formats, encodings, signatures' },
  { value: 'naming-and-conventions', description: 'naming, style, conventions, project structure' },
  { value: 'documentation-and-writing', description: 'technical writing, documentation, explanations' },
  { value: 'team-workflow', description: 'planning, roles, process, coordination of agents or people' },
  { value: 'media-and-creative', description: 'games, video, audio, music, graphics, design' },
  { value: 'other', description: 'nothing above fits' },
];

const baseName = (p) => p.split('/').pop();
const isSkillFile = (p) => baseName(p) === 'SKILL.md';
const sha = (s) => createHash('sha256').update(s).digest('hex');

/**
 * What happens to each file of a pack: translate (Markdown with Chinese), polish (an English
 * SKILL.md: same prompt, improves the wording and the description), or copy.
 * @returns {Array<{path:string, kind:'skill'|'doc'|null, action:'translate'|'polish'|'copy', chineseText:boolean}>}
 */
export function planPack(pack, { polish = true } = {}) {
  return pack.files.map((f) => {
    const isText = /\.md$/i.test(f.path) || TEXT_EXT.test(f.path);
    const text = isText ? f.data.toString('utf8') : '';
    const ratio = isText ? cjkRatio(text) : 0;
    if (/\.md$/i.test(f.path)) {
      const kind = isSkillFile(f.path) ? 'skill' : 'doc';
      if (ratio > TRANSLATE_RATIO) return { path: f.path, kind, action: 'translate', chineseText: true };
      if (kind === 'skill' && polish) return { path: f.path, kind, action: 'polish', chineseText: false };
      return { path: f.path, kind: null, action: 'copy', chineseText: false };
    }
    return { path: f.path, kind: null, action: 'copy', chineseText: ratio > TRANSLATE_RATIO };
  });
}

// Runs fn over items with at most `jobs` at a time, in order of start.
async function pool(items, jobs, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}

// A SKILL.md keeps its name whatever the generator did, and says it is now English.
function fixSkillFrontMatter(original, translated) {
  const src = splitFrontMatter(original);
  const out = splitFrontMatter(translated);
  if (src.frontMatter == null || out.frontMatter == null) return translated;
  let fm = out.frontMatter;
  const name = frontMatterField(src.frontMatter, 'name');
  if (name && frontMatterField(fm, 'name') !== name) fm = setFrontMatterField(fm, 'name', name);
  if (/^\s*locale:/m.test(fm)) fm = setFrontMatterField(fm, 'locale', 'en');
  return joinFrontMatter(fm, out.body);
}

// One generation of the whole file: in one call when it is short, else the front matter with
// the first part and then each further part on its own.
async function generateFile(generator, { path: file, kind, text }, feedback, maxChars) {
  if (text.length <= maxChars) return (await generator.translate({ path: file, kind, text, feedback })).markdown;
  const { frontMatter, body } = splitFrontMatter(text);
  const chunks = chunkMarkdown(body, maxChars);
  const parts = [];
  for (let i = 0; i < chunks.length; i++) {
    const first = i === 0;
    const piece = first && frontMatter != null ? joinFrontMatter(frontMatter, chunks[0]) : chunks[i];
    const { markdown } = await generator.translate({
      path: `${file} (part ${i + 1} of ${chunks.length})`, kind: first ? kind : 'doc', text: piece, feedback,
    });
    // Keep the parts apart as the original was: each but the last ends with a new line.
    parts.push(i < chunks.length - 1 && !markdown.endsWith('\n') ? `${markdown}\n` : markdown);
  }
  return parts.join('');
}

function passes(review, checks, kind) {
  const ok = (v, min) => Number.isFinite(v) && v >= min;
  return checks.ok && ok(review.faithful, THRESHOLDS.faithful) && ok(review.clear, THRESHOLDS.clear)
    && (kind !== 'skill' || ok(review.trigger, THRESHOLDS.trigger));
}

// What the second attempt must fix, from the checks and Luna's review of the first.
function feedbackFor(review, checks, kind) {
  const below = (v, min) => !Number.isFinite(v) || v < min;
  return [
    ...checks.problems,
    ...(below(review.faithful, THRESHOLDS.faithful)
      ? ['A reviewer judged that the translation may drop, add or change instructions, warnings, numbers or commands: compare it with the original line by line.'] : []),
    ...(below(review.clear, THRESHOLDS.clear) ? ['A reviewer found the English unclear or unnatural: rewrite awkward sentences plainly.'] : []),
    ...(kind === 'skill' && below(review.trigger, THRESHOLDS.trigger)
      ? ['The front matter description must say what the skill does and when an agent should use it, with concrete triggers.'] : []),
  ];
}

/**
 * Translates one file: an attempt, Luna's review, and when it falls short a second attempt with
 * the findings, Luna picking the better of the two.
 */
export async function curateFile(item, text, { generator, luna, categories, maxChars = 6000 }) {
  const started = Date.now();
  const attempt = async (feedback) => {
    let markdown = await generateFile(generator, { path: item.path, kind: item.kind, text }, feedback, maxChars);
    if (item.kind === 'skill') markdown = fixSkillFrontMatter(text, markdown);
    const checks = compareStructure(splitFrontMatter(text).body, splitFrontMatter(markdown).body);
    const review = await luna.review({ original: text, translation: markdown, kind: item.kind, categories: item.kind === 'skill' ? categories : undefined });
    return { markdown, checks, review, pass: passes(review, checks, item.kind) };
  };
  const first = await attempt([]);
  let chosen = first;
  let attempts = 1;
  if (!first.pass) {
    attempts = 2;
    const second = await attempt(feedbackFor(first.review, first.checks, item.kind));
    if (second.pass !== first.pass) chosen = second.pass ? second : first;
    else if (second.checks.ok !== first.checks.ok) chosen = second.checks.ok ? second : first;
    else chosen = (await luna.pick({ original: text, a: first.markdown, b: second.markdown })).choice === 'b' ? second : first;
    // A category from either review will do when the chosen one has none.
    if (!chosen.review.category) chosen.review = { ...chosen.review, category: first.review.category ?? second.review.category };
  }
  const r = chosen.review;
  return {
    path: item.path, kind: item.kind, action: item.action, status: chosen.pass ? 'accepted' : 'needs-review', attempts,
    faithful: r.faithful, clear: r.clear, trigger: r.trigger, category: r.category ?? null, categoryConfidence: r.categoryConfidence ?? null,
    problems: chosen.checks.problems, truncated: text.length > 24000 || chosen.markdown.length > 24000,
    markdown: chosen.markdown, ms: Date.now() - started,
  };
}

// Results kept between runs, so a stopped or failed run picks up where it was.
function createCache(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = (key) => path.join(dir, `${key}.json`);
  return {
    get(key) {
      try {
        return JSON.parse(fs.readFileSync(file(key), 'utf8'));
      } catch {
        return null;
      }
    },
    set(key, value) {
      fs.writeFileSync(file(key), JSON.stringify(value));
    },
  };
}

const words = (s) => new Set(String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w)));
function similarity(a, b) {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared === 0 ? 0 : shared / (a.size + b.size - shared);
}

/** Pairs of skills (by English name and description) that look alike, most alike first. */
export function overlapCandidates(skills, { min = OVERLAP_SIMILARITY, max = MAX_OVERLAP_PAIRS } = {}) {
  const bags = skills.map((s) => words(`${s.name.replace(/[-_.]/g, ' ')} ${s.description}`));
  const pairs = [];
  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) {
      const sim = similarity(bags[i], bags[j]);
      if (sim >= min) pairs.push({ a: skills[i], b: skills[j], similarity: sim });
    }
  }
  return pairs.sort((x, y) => y.similarity - x.similarity).slice(0, max);
}

// Packs named by the sources: a .zip, a pack folder, or a folder of .zip packs.
export function expandSources(sources) {
  return sources.flatMap((s) => {
    if (fs.statSync(s).isDirectory()) {
      const zips = fs.readdirSync(s).filter((f) => f.toLowerCase().endsWith('.zip')).sort();
      if (zips.length > 0) return zips.map((f) => path.join(s, f));
    }
    return [s];
  });
}

/**
 * The whole run.
 * @param {{sources:string[], out:string, generator:object, luna:object, jobs?:number, limit?:number,
 *   only?:string[], zip?:boolean, polish?:boolean, maxChars?:number, categories?:object[], log?:Function}} o
 * @returns {Promise<object>} the report data (also written to out/report.json)
 */
export async function curate(o) {
  const { out, generator, luna, jobs = 3, limit = Infinity, only = [], zip = false, polish = true, maxChars = 6000,
    categories = CATEGORIES, log = () => {} } = o;
  const started = new Date();
  const packs = expandSources(o.sources).map((s) => readPack(s)).filter((p) => only.length === 0 || only.includes(p.name));
  if (packs.length === 0) throw new Error('no packs to curate (check the sources and --only)');
  const cache = createCache(path.join(out, '.cache'));
  const plans = packs.map((pack) => ({ pack, plan: planPack(pack, { polish }) }));
  // SKILL.md files first: they matter most, and a --limit trial should show them.
  const work = plans.flatMap(({ pack, plan }) => plan.filter((p) => p.action !== 'copy').map((item) => ({ pack, item })))
    .sort((a, b) => (a.item.kind === 'skill' ? 0 : 1) - (b.item.kind === 'skill' ? 0 : 1));
  const todo = work.slice(0, limit);
  const skipped = work.slice(limit);
  log(`${packs.length} packs, ${work.length} files to translate or polish${skipped.length ? ` (${todo.length} this run, --limit)` : ''}`);

  let done = 0;
  const results = await pool(todo, jobs, async ({ pack, item }) => {
    const text = pack.files.find((f) => f.path === item.path).data.toString('utf8');
    const key = sha(`${PROMPT_VERSION}\n${item.kind}\n${pack.name}/${item.path}\n${text}`);
    let result = cache.get(key);
    const cached = result != null;
    if (!result) {
      try {
        result = await curateFile(item, text, { generator, luna, categories, maxChars });
        cache.set(key, result);
      } catch (err) {
        result = { path: item.path, kind: item.kind, action: item.action, status: 'failed', error: String(err?.message ?? err).slice(0, 300) };
      }
    }
    result = { ...result, pack: pack.name };
    done++;
    const scores = result.status === 'failed' ? result.error
      : `faithful ${fmt(result.faithful)}, clear ${fmt(result.clear)}${result.kind === 'skill' ? `, trigger ${fmt(result.trigger)}` : ''}`;
    log(`[${done}/${todo.length}] ${pack.name}/${item.path} ${result.status}${cached ? ' (cached)' : ''} (${scores})`);
    return result;
  });

  // The English packs: translated files replace the originals; failed ones keep the original.
  const byFile = new Map(results.map((r) => [`${r.pack}/${r.path}`, r]));
  const outPacks = [];
  for (const { pack } of plans) {
    const files = pack.files.map((f) => {
      const r = byFile.get(`${pack.name}/${f.path}`);
      return r?.markdown != null ? { path: f.path, data: Buffer.from(r.markdown, 'utf8') } : f;
    });
    const dir = path.join(out, pack.name);
    fs.rmSync(dir, { recursive: true, force: true });
    writePack(dir, files);
    if (zip) zipPack(path.join(out, `${pack.name}-en.zip`), files);
    outPacks.push({ pack, files });
  }

  // The skills in English, for the catalog and the overlap check.
  const skills = [];
  for (const { pack, files } of outPacks) {
    for (const f of files.filter((x) => isSkillFile(x.path))) {
      const fm = splitFrontMatter(f.data.toString('utf8')).frontMatter ?? '';
      const r = byFile.get(`${pack.name}/${f.path}`);
      skills.push({
        pack: pack.name, path: f.path, name: frontMatterField(fm, 'name') || f.path.split('/').at(-2) || f.path,
        description: frontMatterField(fm, 'description'), category: r?.category ?? null, categoryConfidence: r?.categoryConfidence ?? null,
        status: r?.status ?? 'not processed',
      });
    }
  }
  const candidates = overlapCandidates(skills);
  const overlaps = [];
  for (const c of candidates) {
    try {
      const { probability } = await luna.overlap({ a: c.a, b: c.b });
      if (probability >= OVERLAP_REPORTED) overlaps.push({ a: `${c.a.pack}/${c.a.name}`, b: `${c.b.pack}/${c.b.name}`, probability, similarity: c.similarity });
    } catch (err) {
      log(`overlap check failed for ${c.a.name} / ${c.b.name}: ${err.message}`);
    }
  }
  overlaps.sort((x, y) => y.probability - x.probability);

  const untranslated = plans.flatMap(({ pack, plan }) => plan.filter((p) => p.action === 'copy' && p.chineseText).map((p) => `${pack.name}/${p.path}`));
  const report = {
    startedAt: started.toISOString(), finishedAt: new Date().toISOString(), promptVersion: PROMPT_VERSION, thresholds: THRESHOLDS,
    sources: packs.map((p) => p.name), out,
    files: results.map(({ markdown, ...rest }) => rest),
    skipped: skipped.map(({ pack, item }) => `${pack.name}/${item.path}`),
    untranslated, skills, overlaps, overlapPairsChecked: candidates.length, luna: luna.totals(),
  };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
  return report;
}

const fmt = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');
