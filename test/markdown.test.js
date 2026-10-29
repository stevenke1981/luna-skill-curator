import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkMarkdown,
  cjkCount,
  cjkRatio,
  compareStructure,
  frontMatterField,
  joinFrontMatter,
  markdownStructure,
  setFrontMatterField,
  splitFrontMatter,
} from '../src/markdown.js';

test('splitFrontMatter strips a BOM and accepts CRLF', () => {
  const text = '﻿---\r\nname: storage\r\ndescription: "a: b"\r\n---\r\n\r\n# Title\r\nbody\r\n';
  const { frontMatter, body } = splitFrontMatter(text);
  assert.equal(frontMatter, 'name: storage\ndescription: "a: b"');
  assert.equal(body, '# Title\r\nbody\r\n');
});

test('splitFrontMatter returns null front matter when there is none', () => {
  assert.deepEqual(splitFrontMatter('﻿# Just a doc\n'), { frontMatter: null, body: '# Just a doc\n' });
  // An opening fence without a closing one is not front matter.
  assert.deepEqual(splitFrontMatter('---\nname: x\n'), { frontMatter: null, body: '---\nname: x\n' });
});

test('joinFrontMatter and splitFrontMatter agree on the layout', () => {
  const text = joinFrontMatter('name: a\ndescription: b', '# A\n\ntext\n');
  assert.equal(text, '---\nname: a\ndescription: b\n---\n\n# A\n\ntext\n');
  assert.deepEqual(splitFrontMatter(text), { frontMatter: 'name: a\ndescription: b', body: '# A\n\ntext\n' });
  assert.equal(joinFrontMatter(null, 'body'), 'body');
});

test('frontMatterField reads plain, quoted and block values', () => {
  const fm = [
    'name: storage-check',
    "single: 'it''s fine'",
    'double: "say \\"hi\\" \\\\ ok"',
    'plain: value # a comment',
    'folded: >-',
    '  first line',
    '  second line',
    'literal: |',
    '  one',
    '  two',
    'multi: a plain value',
    '  that continues here',
    'names: other',
    'after: last',
  ].join('\n');
  assert.equal(frontMatterField(fm, 'name'), 'storage-check');
  assert.equal(frontMatterField(fm, 'single'), "it's fine");
  assert.equal(frontMatterField(fm, 'double'), 'say "hi" \\ ok');
  assert.equal(frontMatterField(fm, 'plain'), 'value');
  assert.equal(frontMatterField(fm, 'folded'), 'first line second line');
  assert.equal(frontMatterField(fm, 'literal'), 'one two');
  assert.equal(frontMatterField(fm, 'multi'), 'a plain value that continues here');
  assert.equal(frontMatterField(fm, 'after'), 'last');
  // "name" must not match "names", and a missing key reads as empty.
  assert.equal(frontMatterField('names: other', 'name'), '');
  assert.equal(frontMatterField(fm, 'missing'), '');
  assert.equal(frontMatterField(null, 'name'), '');
});

test('setFrontMatterField replaces, quotes and appends', () => {
  let fm = 'name: old\ndescription: |\n  line one\n  line two\nversion: 1';
  fm = setFrontMatterField(fm, 'description', 'Use when: you need "backups" # now');
  assert.equal(fm, 'name: old\ndescription: "Use when: you need \\"backups\\" # now"\nversion: 1');
  assert.equal(frontMatterField(fm, 'description'), 'Use when: you need "backups" # now');

  assert.equal(setFrontMatterField(fm, 'locale', 'en'), `${fm}\nlocale: en`);
  assert.equal(setFrontMatterField('', 'name', 'x'), 'name: x');
  assert.equal(setFrontMatterField('name: a', 'name', 'plain words'), 'name: plain words');
});

test('setFrontMatterField quotes values that would read back differently', () => {
  const tricky = [
    '[draft] item', '- list-like', '# hash', 'a\\b', 'line one\nline two', 'true', '42', '', ' padded ', 'it\'s',
  ];
  for (const value of tricky) {
    const fm = setFrontMatterField('name: x', 'field', value);
    assert.equal(frontMatterField(fm, 'field'), value, JSON.stringify(value));
  }
  assert.equal(setFrontMatterField('', 'field', 'a\\b'), 'field: a\\b');
});

test('cjkCount and cjkRatio count ideographs and CJK punctuation', () => {
  assert.equal(cjkCount('你好，world'), 3);
  assert.equal(cjkCount('plain ascii'), 0);
  assert.equal(cjkCount('、。「」'), 4);
  assert.equal(cjkRatio(''), 0);
  assert.equal(cjkRatio('   '), 0);
  assert.equal(cjkRatio('中 a'), 0.5);
});

test('chunkMarkdown joins back to the body and never splits inside a fence', () => {
  const fence = '```bash\n# not a heading\n\nrsync -a src/ dst/\n```\n';
  const body = [
    '# One\n\nintro\n',
    fence,
    '\n## Two\n\n',
    '~~~\n# also not a heading\n~~~\n\n',
    '# Three\n\n' + 'word '.repeat(40) + '\n\n',
    '```\n' + 'x\n\n'.repeat(60) + '```\n',
  ].join('');
  for (const max of [1, 50, 200, 600, 6000]) {
    const chunks = chunkMarkdown(body, max);
    assert.equal(chunks.join(''), body, `join at ${max}`);
    for (const c of chunks) {
      const fences = c.split('\n').filter((l) => /^(`{3,}|~{3,})/.test(l)).length;
      assert.equal(fences % 2, 0, `fences balanced in a chunk at ${max}`);
    }
  }
  const small = chunkMarkdown(body, 50);
  assert.ok(small.some((c) => c.includes('# not a heading\n\nrsync -a src/ dst/\n```')), 'fence kept whole');
  assert.ok(small.some((c) => c.includes('# also not a heading')), 'tilde fence kept whole');
  assert.ok(small.some((c) => c.startsWith('## Two')), 'split at a heading');
});

test('chunkMarkdown splits a section larger than maxChars at blank lines', () => {
  const paragraphs = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${'lorem ipsum '.repeat(8)}`);
  const body = `# Big\n\n${paragraphs.join('\n\n')}\n`;
  const chunks = chunkMarkdown(body, 500);
  assert.equal(chunks.join(''), body);
  assert.ok(chunks.length > 1, 'split into several chunks');
  for (const c of chunks) {
    assert.ok(c.length <= 500, `chunk of ${c.length} chars`);
    assert.ok(c.endsWith('\n\n') || c.endsWith('\n'), 'chunk ends at a line end');
  }
});

test('chunkMarkdown keeps an oversized fence whole and handles empty input', () => {
  const big = '```\n' + 'line of code\n\n'.repeat(400) + '```\n';
  const body = `# Heavy\n\n${big}`;
  const chunks = chunkMarkdown(body, 300);
  assert.equal(chunks.join(''), body);
  assert.ok(chunks.some((c) => c.includes(big)), 'the fence is one chunk');
  assert.deepEqual(chunkMarkdown(''), []);
  assert.deepEqual(chunkMarkdown('short text'), ['short text']);
});

test('markdownStructure ignores headings inside fences and reads links and code', () => {
  const text = [
    '# Title',
    '```sh',
    '# comment in code',
    'curl https://example.com/api',
    '```',
    '## Section',
    'See [the guide](docs/guide.md) and https://example.com/docs.',
    'Run `make build` now.',
  ].join('\n');
  const s = markdownStructure(text);
  assert.equal(s.headings, 2);
  assert.equal(s.fences.length, 1);
  assert.equal(s.fences[0].info, 'sh');
  assert.deepEqual(s.fences[0].lines, ['# comment in code', 'curl https://example.com/api']);
  assert.deepEqual(s.urls, ['https://example.com/api', 'https://example.com/docs']);
  assert.deepEqual(s.linkTargets, ['docs/guide.md']);
  assert.deepEqual(s.inlineCode, ['make build']);
});

const ORIGINAL = [
  '---',
  'name: backup',
  '---',
  '',
  '# 備份工具',
  '',
  '先執行下面的指令，詳見 [說明](docs/guide.md) 與 https://example.com/backup 。',
  '',
  '```bash',
  '# 同步資料夾',
  'rsync -a src/ dst/',
  '```',
  '',
  '## 注意事項',
  '',
  '使用 `--dry-run` 先檢查。',
  '',
].join('\n');

const TRANSLATION = [
  '# Backup tool',
  '',
  'Run the command below. See [the guide](docs/guide.md) and https://example.com/backup.',
  '',
  '```bash',
  '# Sync the folder',
  'rsync -a src/ dst/',
  '```',
  '',
  '## Notes',
  '',
  'Check with `--dry-run` first.',
  '',
].join('\n');

test('compareStructure passes a faithful translation whose code comments were translated', () => {
  const result = compareStructure(ORIGINAL, TRANSLATION);
  assert.deepEqual(result, { ok: true, problems: [] });
});

test('compareStructure reports a lost code line', () => {
  const broken = TRANSLATION.replace('rsync -a src/ dst/\n', '');
  const result = compareStructure(ORIGINAL, broken);
  assert.equal(result.ok, false);
  assert.ok(result.problems.includes('code block 1 lost line: rsync -a src/ dst/'), result.problems.join(' | '));
});

test('compareStructure reports a lost URL and a lost link target', () => {
  const noUrl = TRANSLATION.replace('https://example.com/backup', 'the site');
  const urlResult = compareStructure(ORIGINAL, noUrl);
  assert.ok(urlResult.problems.some((p) => p.startsWith('URL lost: https://example.com/backup')), urlResult.problems.join(' | '));

  const noLink = TRANSLATION.replace('(docs/guide.md)', '(docs/manual.md)');
  const linkResult = compareStructure(ORIGINAL, noLink);
  assert.ok(linkResult.problems.includes('link target lost: docs/guide.md'), linkResult.problems.join(' | '));
});

test('compareStructure reports a lost heading and a lost inline code span', () => {
  const noHeading = TRANSLATION.replace('## Notes\n\n', '');
  const headingResult = compareStructure(ORIGINAL, noHeading);
  assert.ok(headingResult.problems.includes('heading count differs: original 2, translation 1'), headingResult.problems.join(' | '));

  const noCode = TRANSLATION.replace('`--dry-run`', 'the dry run flag');
  const codeResult = compareStructure(ORIGINAL, noCode);
  assert.ok(codeResult.problems.includes('inline code lost: --dry-run'), codeResult.problems.join(' | '));
});

test('compareStructure reports a missing code block and leftover Chinese', () => {
  const noFence = TRANSLATION.replace(/```bash[\s\S]*?```\n/, '');
  const fenceResult = compareStructure(ORIGINAL, noFence);
  assert.ok(fenceResult.problems.some((p) => p.startsWith('code block count differs')), fenceResult.problems.join(' | '));

  const leftover = TRANSLATION.replace('Check with', '先檢查，再 check with');
  const cjkResult = compareStructure(ORIGINAL, leftover);
  assert.equal(cjkResult.ok, false);
  assert.ok(cjkResult.problems.some((p) => /still contains Chinese/.test(p)), cjkResult.problems.join(' | '));
});
