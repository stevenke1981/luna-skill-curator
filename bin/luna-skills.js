#!/usr/bin/env node
// luna-skills: translate agent skill packs into clear English, reviewed and organized by Luna.
import fs from 'node:fs';
import path from 'node:path';
import { readPack } from '../src/packs.js';
import { createGenerator } from '../src/generate.js';
import { createLuna } from '../src/luna.js';
import { curate, planPack, expandSources, CATEGORIES } from '../src/pipeline.js';
import { writeReports } from '../src/report.js';

const HELP = `luna-skills: translate agent skill packs into clear English and organize them with Luna

Usage:
  luna-skills scan <source...>          What a run would do: packs, files to translate or polish, sizes (no network)
  luna-skills run <source...> [options] Translate, review with Luna, and write the English packs and reports
  luna-skills report [--out DIR]        Rewrite REPORT.md and CATALOG.md from DIR/report.json

A source is a pack .zip, a pack folder, or a folder of pack .zip files (e.g. E:\\install_skills).

Options for run:
  --out DIR            Output folder (default ./out): one folder per pack, REPORT.md, CATALOG.md, report.json
  --backend B          codex (default; your Codex login) or openai (OPENAI_API_KEY, billed per token)
  --model M            Generator model (codex: its default; openai: gpt-6.1-terra)
  --jobs N             Files translated at once (default 3)
  --limit N            Translate at most N files this run; run again to continue (results are cached)
  --only A,B           Only these packs (names without .zip)
  --zip                Also write <pack>-en.zip next to each folder
  --no-polish          Leave English SKILL.md files as they are (default: improve their wording too)
  --max-chars N        Longer files are translated in parts of about N characters (default 6000)
  --categories FILE    JSON list of {"value","description"} to sort skills into (default: built in)

Environment (also read from .env.local or .env here):
  OPENAI_API_KEY       Luna's key (required: Luna reviews every translation); also the openai backend's
  LUNA_DECISION_MODEL  (gpt-6-luna)  LUNA_DECISION_URL (https://api.openai.com/v1/decisions)`;

function loadEnv() {
  for (const f of ['.env.local', '.env']) {
    if (fs.existsSync(f)) {
      try {
        process.loadEnvFile(f);
      } catch {
        // An unreadable file is the user's to fix; the variables may come from elsewhere.
      }
    }
  }
}

function parseArgs(argv) {
  const opts = { sources: [] };
  const flags = new Set(['zip', 'no-polish', 'help']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      opts.sources.push(a);
      continue;
    }
    const key = a.slice(2);
    if (flags.has(key)) opts[key] = true;
    else if (i + 1 < argv.length) opts[key] = argv[++i];
    else throw new Error(`${a} needs a value`);
  }
  return opts;
}

const positive = (v, name, fallback) => {
  if (v == null) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a whole number of 1 or more`);
  return n;
};

function scan(opts) {
  if (opts.sources.length === 0) throw new Error('name at least one source (a pack .zip, folder, or folder of .zip packs)');
  let total = 0;
  for (const source of expandSources(opts.sources)) {
    const pack = readPack(source);
    const plan = planPack(pack, { polish: !opts['no-polish'] });
    const size = (p) => pack.files.find((f) => f.path === p.path).data.length;
    const translate = plan.filter((p) => p.action === 'translate');
    const polish = plan.filter((p) => p.action === 'polish');
    const chars = [...translate, ...polish].reduce((n, p) => n + size(p), 0);
    total += translate.length + polish.length;
    console.log(`${pack.name}: ${pack.files.length} files; translate ${translate.length}, polish ${polish.length} `
      + `(${Math.round(chars / 1024)} KB); ${plan.filter((p) => p.action === 'copy' && p.chineseText).length} non-Markdown files with Chinese stay as they are`);
  }
  console.log(`total: ${total} files for the generator, each reviewed by Luna (about one call each, two when a second attempt is needed)`);
}

async function run(opts) {
  if (opts.sources.length === 0) throw new Error('name at least one source (a pack .zip, folder, or folder of .zip packs)');
  const out = path.resolve(opts.out ?? 'out');
  const backend = opts.backend ?? 'codex';
  if (!['codex', 'openai'].includes(backend)) throw new Error('--backend must be codex or openai');
  const categories = opts.categories ? JSON.parse(fs.readFileSync(opts.categories, 'utf8')) : CATEGORIES;
  const luna = createLuna({
    apiKey: process.env.LUNA_API_KEY || process.env.OPENAI_API_KEY || '',
    ...(process.env.LUNA_DECISION_URL ? { url: process.env.LUNA_DECISION_URL } : {}),
    ...(process.env.LUNA_DECISION_MODEL ? { model: process.env.LUNA_DECISION_MODEL } : {}),
  });
  const generator = createGenerator({ backend, model: opts.model ?? '', apiKey: process.env.OPENAI_API_KEY || '' });
  fs.mkdirSync(out, { recursive: true });
  const report = await curate({
    sources: opts.sources, out, generator, luna, categories,
    jobs: positive(opts.jobs, 'jobs', 3), limit: positive(opts.limit, 'limit', Infinity), maxChars: positive(opts['max-chars'], 'max-chars', 6000),
    only: opts.only ? opts.only.split(',').map((s) => s.trim()).filter(Boolean) : [], zip: opts.zip === true, polish: !opts['no-polish'],
    log: (s) => console.log(s),
  });
  writeReports(out, report);
  const by = (s) => report.files.filter((f) => f.status === s).length;
  console.log(`done: ${by('accepted')} accepted, ${by('needs-review')} need review, ${by('failed')} failed, ${report.skipped.length} left for a later run; `
    + `${report.overlaps.length} overlapping pairs; Luna ${report.luna.calls} calls ≤ $${report.luna.cost.toFixed(4)}`);
  console.log(`see ${path.join(out, 'REPORT.md')} and ${path.join(out, 'CATALOG.md')}`);
}

function report(opts) {
  const out = path.resolve(opts.out ?? 'out');
  writeReports(out, JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8')));
  console.log(`wrote ${path.join(out, 'REPORT.md')} and ${path.join(out, 'CATALOG.md')}`);
}

async function main() {
  loadEnv();
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  switch (cmd) {
    case 'scan': return scan(opts);
    case 'run': return run(opts);
    case 'report': return report(opts);
    case undefined:
    case 'help':
    case '--help':
    case '-h': return console.log(HELP);
    default: throw new Error(`unknown command "${cmd}"; see luna-skills help`);
  }
}

main().catch((err) => {
  console.error(`luna-skills: ${err.message}`);
  process.exit(1);
});
