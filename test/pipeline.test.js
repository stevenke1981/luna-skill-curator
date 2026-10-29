import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planPack, curate, overlapCandidates, expandSources } from '../src/pipeline.js';
import { readPack, zipPack } from '../src/packs.js';
import { createGenerator } from '../src/generate.js';
import { reportMarkdown, catalogMarkdown, writeReports } from '../src/report.js';

const tmp = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-'));
  tmp.push(dir);
  return dir;
}
afterEach(() => {
  while (tmp.length) fs.rmSync(tmp.pop(), { recursive: true, force: true });
});

const SKILL_ZH = '---\nname: disk-backup\ndescription: 規劃備份與還原\nlocale: zh-TW\n---\n\n# 備份\n\n1. 先盤點資料。\n2. 執行：\n\n```sh\nrsync -a src/ dst/  # 複製\n```\n\n參考 [指南](references/guide.md)。\n';
const SKILL_EN = '---\nname: disk-health\ndescription: Check disks\n---\n\n# Health\n\nRun `smartctl -a /dev/sda`.\n';
const DOC_ZH = '# 指南\n\n請先閱讀說明。\n\n## 步驟\n\n確認備份完成。\n';
const files = {
  'pack/disk-backup/SKILL.md': SKILL_ZH,
  'pack/disk-backup/references/guide.md': DOC_ZH,
  'pack/disk-health/SKILL.md': SKILL_EN,
  'pack/README.md': '# Pack\n\nEnglish only.\n',
  'pack/tool.py': 'print("備份")\n',
  'pack/logo.bin': Buffer.from([0, 1, 2, 255]),
};

function writePackDir(root) {
  for (const [p, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), content);
  }
  return root;
}

// Stands in for the model: Chinese becomes English words, the rest stays byte for byte.
const DICT = [['規劃備份與還原', 'Plan backups and restores'], ['備份', 'Backup'], ['先盤點資料', 'Take stock of the data first'], ['執行', 'Run'],
  ['複製', 'copy'], ['參考', 'See the'], ['指南', 'guide'], ['請先閱讀說明', 'Read the notes first'], ['步驟', 'Steps'], ['確認備份完成', 'Check that the backup finished']];
function toEnglish(text) {
  let s = text;
  for (const [zh, en] of [...DICT].sort((a, b) => b[0].length - a[0].length)) s = s.split(zh).join(en);
  return s.replace(/。/g, '.').replace(/：/g, ':').replace(/zh-TW/g, 'zh-TW');
}

function fakeLuna({ faithfulFor = () => 0.95 } = {}) {
  const calls = { review: [], pick: 0, overlap: 0 };
  return {
    calls,
    async review({ original, translation, kind, categories }) {
      calls.review.push({ kind, categories: categories?.length ?? 0 });
      return {
        faithful: faithfulFor(translation, calls.review.length), clear: 0.9, trigger: kind === 'skill' ? 0.9 : null,
        category: categories ? 'storage-and-filesystems' : null, categoryConfidence: categories ? 0.8 : null, cost: 0.0002, tokens: { input: 2000, cached: 0 },
      };
    },
    async pick() {
      calls.pick++;
      return { choice: 'b', confidence: 0.7, cost: 0.0002 };
    },
    async overlap() {
      calls.overlap++;
      return { probability: 0.9, cost: 0.0001 };
    },
    totals: () => ({ calls: calls.review.length + calls.pick + calls.overlap, cost: 0.001, inputTokens: 1000, cachedTokens: 0 }),
  };
}

function mockGenerator(fn = ({ text }) => toEnglish(text)) {
  const seen = [];
  const gen = createGenerator({ backend: 'mock', mock: async (args) => { seen.push(args); return fn(args); } });
  return { gen, seen };
}

test('planPack: Chinese Markdown is translated, English SKILL.md polished, the rest copied', () => {
  const pack = readPack(writePackDir(tempDir()));
  const plan = Object.fromEntries(planPack(pack).map((p) => [p.path, [p.action, p.kind, p.chineseText]]));
  assert.deepEqual(plan['pack/disk-backup/SKILL.md'], ['translate', 'skill', true]);
  assert.deepEqual(plan['pack/disk-backup/references/guide.md'], ['translate', 'doc', true]);
  assert.deepEqual(plan['pack/disk-health/SKILL.md'], ['polish', 'skill', false]);
  assert.deepEqual(plan['pack/README.md'], ['copy', null, false]);
  assert.deepEqual(plan['pack/tool.py'], ['copy', null, true]);
  assert.deepEqual(plan['pack/logo.bin'], ['copy', null, false]);
  assert.equal(planPack(pack, { polish: false }).find((p) => p.path === 'pack/disk-health/SKILL.md').action, 'copy');
});

test('curate translates, keeps the skill name, sets locale, copies the rest, writes reports and caches', async () => {
  const src = writePackDir(path.join(tempDir(), 'pack'));
  const out = tempDir();
  // The generator renames the skill; the pipeline puts the name back.
  const { gen, seen } = mockGenerator(({ text }) => toEnglish(text).replace('name: disk-backup', 'name: backup-planner'));
  const luna = fakeLuna();
  const report = await curate({ sources: [src], out, generator: gen, luna, jobs: 2 });
  assert.equal(seen.length, 3, JSON.stringify(report.files.map(({path, attempts, problems, faithful, clear, trigger}) => ({path, attempts, problems, faithful, clear, trigger}))));
  const skill = fs.readFileSync(path.join(out, 'pack', 'pack/disk-backup/SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: disk-backup\n/);
  assert.match(skill, /locale: en/);
  assert.match(skill, /rsync -a src\/ dst\/  # copy/);
  assert.deepEqual(fs.readFileSync(path.join(out, 'pack', 'pack/logo.bin')), Buffer.from([0, 1, 2, 255]));
  assert.equal(fs.readFileSync(path.join(out, 'pack', 'pack/tool.py'), 'utf8'), 'print("備份")\n');
  assert.deepEqual(report.files.map((f) => f.status), ['accepted', 'accepted', 'accepted']);
  assert.deepEqual(report.untranslated, ['pack/pack/tool.py']);
  assert.equal(report.skills.length, 2);
  assert.equal(report.skills.find((s) => s.name === 'disk-backup').category, 'storage-and-filesystems');
  // Only SKILL.md reviews carry the categories.
  assert.deepEqual(luna.calls.review.map((c) => c.categories > 0).sort(), [false, true, true]);
  writeReports(out, report);
  assert.match(fs.readFileSync(path.join(out, 'REPORT.md'), 'utf8'), /\| 3 \| 2 \| 1 \| 3 \| 0 \| 0 \| 0 \| 0 \|/);
  assert.match(fs.readFileSync(path.join(out, 'CATALOG.md'), 'utf8'), /## storage-and-filesystems \(2\)/);

  // A second run reuses every result.
  const again = mockGenerator();
  await curate({ sources: [src], out, generator: again.gen, luna: fakeLuna() });
  assert.equal(again.seen.length, 0);
});

test('curate: a translation Luna doubts gets a second attempt with the findings, and Luna picks', async () => {
  const src = writePackDir(path.join(tempDir(), 'pack'));
  const { gen, seen } = mockGenerator();
  // The first review of every file doubts it; the second passes.
  const reviews = new Map();
  const luna = fakeLuna({ faithfulFor: (t) => { const n = (reviews.get(t.slice(0, 40)) ?? 0) + 1; reviews.set(t.slice(0, 40), n); return n === 1 ? 0.3 : 0.9; } });
  const report = await curate({ sources: [src], out: tempDir(), generator: gen, luna, jobs: 1, only: ['pack'] });
  assert.ok(report.files.every((f) => f.attempts === 2 && f.status === 'accepted'));
  const retry = seen.find((s) => s.feedback.length > 0);
  assert.match(retry.feedback.join(' '), /may drop, add or change instructions/);
});

test('curate: a failing generator keeps the original; --limit leaves files for a later run', async () => {
  const src = writePackDir(path.join(tempDir(), 'pack'));
  const out = tempDir();
  const { gen } = mockGenerator(() => { throw new Error('codex exited 1'); });
  const report = await curate({ sources: [src], out, generator: gen, luna: fakeLuna(), limit: 1 });
  assert.equal(report.files.length, 1);
  assert.equal(report.files[0].status, 'failed');
  assert.match(report.files[0].error, /codex exited 1/);
  assert.equal(report.skipped.length, 2);
  assert.equal(fs.readFileSync(path.join(out, 'pack', report.files[0].path), 'utf8'), files[report.files[0].path]);
  assert.match(reportMarkdown(report), /## Needs a person[\s\S]*failed[\s\S]*codex exited 1/);
  assert.match(reportMarkdown(report), /2 files were left for a later run/);
});

test('curate: a long file goes in parts, and the parts are joined in order', async () => {
  const src = writePackDir(path.join(tempDir(), 'pack'));
  const long = `# 指南\n\n${Array.from({ length: 12 }, (_, i) => `## 步驟 ${i}\n\n確認備份完成。\n`).join('\n')}`;
  fs.writeFileSync(path.join(src, 'pack/disk-backup/references/guide.md'), long);
  const out = tempDir();
  const { gen, seen } = mockGenerator();
  await curate({ sources: [src], out, generator: gen, luna: fakeLuna(), maxChars: 60, polish: false });
  const parts = seen.filter((s) => s.path.includes('guide.md'));
  assert.ok(parts.length > 2);
  assert.match(parts[0].path, /\(part 1 of \d+\)$/);
  assert.equal(fs.readFileSync(path.join(out, 'pack', 'pack/disk-backup/references/guide.md'), 'utf8'), toEnglish(long));
});

test('expandSources reads a folder of zips; overlapCandidates pairs alike skills; the catalog groups them', () => {
  const dir = tempDir();
  zipPack(path.join(dir, 'b.zip'), [{ path: 'x/SKILL.md', data: Buffer.from(SKILL_EN) }]);
  zipPack(path.join(dir, 'a.zip'), [{ path: 'y/SKILL.md', data: Buffer.from(SKILL_EN) }]);
  assert.deepEqual(expandSources([dir]).map((p) => path.basename(p)), ['a.zip', 'b.zip']);
  const skills = [
    { pack: 'p', name: 'storage-backup', description: 'Plan backups, snapshots and restore drills for disks' },
    { pack: 'q', name: 'backup-planner', description: 'Plan backups and restore drills' },
    { pack: 'q', name: 'git-accounts', description: 'Switch git accounts per repository' },
  ];
  const pairs = overlapCandidates(skills);
  assert.equal(pairs.length, 1);
  assert.deepEqual([pairs[0].a.name, pairs[0].b.name], ['storage-backup', 'backup-planner']);
  const md = catalogMarkdown({ sources: ['p', 'q'], skills: skills.map((s, i) => ({ ...s, category: i < 2 ? 'storage' : 'vcs', status: 'accepted' })) });
  assert.match(md, /## storage \(2\)\n\n- \*\*backup-planner\*\* \(q\)/);
});
