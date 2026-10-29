// REPORT.md (what happened to every file, what needs a person) and CATALOG.md (the skills by
// category, in English), from the data curate() returns.
import fs from 'node:fs';
import path from 'node:path';

const fmt = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

function count(files, pred) {
  return files.filter(pred).length;
}

/** The run summary as Markdown. */
export function reportMarkdown(r) {
  const f = r.files;
  const lines = [
    '# Skill curation report', '',
    `- Run: ${r.startedAt} → ${r.finishedAt}`,
    `- Packs: ${r.sources.join(', ')}`,
    `- Prompt ${r.promptVersion}; Luna accepts at faithful ≥ ${r.thresholds.faithful}, clear ≥ ${r.thresholds.clear}, trigger ≥ ${r.thresholds.trigger} (SKILL.md)`,
    `- Luna: ${r.luna.calls} calls, ${r.luna.inputTokens} input tokens (${r.luna.cachedTokens} cached), at most $${r.luna.cost.toFixed(4)}`,
    '',
    '## Summary', '',
    '| Files | Translated | Polished | Accepted | Needs review | Failed | Second attempt | Not run (--limit) |',
    '|---|---|---|---|---|---|---|---|',
    `| ${f.length} | ${count(f, (x) => x.action === 'translate')} | ${count(f, (x) => x.action === 'polish')} | ${count(f, (x) => x.status === 'accepted')} `
      + `| ${count(f, (x) => x.status === 'needs-review')} | ${count(f, (x) => x.status === 'failed')} | ${count(f, (x) => x.attempts === 2)} | ${r.skipped.length} |`,
    '',
    '## By pack', '',
    '| Pack | Files | Accepted | Needs review | Failed | Avg faithful | Avg clear |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const pack of r.sources) {
    const mine = f.filter((x) => x.pack === pack);
    const avg = (k) => {
      const v = mine.map((x) => x[k]).filter(Number.isFinite);
      return v.length ? fmt(v.reduce((a, b) => a + b, 0) / v.length) : '—';
    };
    lines.push(`| ${pack} | ${mine.length} | ${count(mine, (x) => x.status === 'accepted')} | ${count(mine, (x) => x.status === 'needs-review')} `
      + `| ${count(mine, (x) => x.status === 'failed')} | ${avg('faithful')} | ${avg('clear')} |`);
  }
  const attention = f.filter((x) => x.status !== 'accepted');
  lines.push('', '## Needs a person', '');
  if (attention.length === 0) lines.push('Nothing: every processed file passed the checks and Luna\'s review.');
  else {
    lines.push('| File | Status | Faithful | Clear | Trigger | Why |', '|---|---|---|---|---|---|');
    for (const x of attention) {
      const why = x.status === 'failed' ? x.error : [...(x.problems ?? []), ...(x.truncated ? ['reviewed in part (long file)'] : [])].join('; ') || 'below Luna\'s bar';
      lines.push(`| ${cell(`${x.pack}/${x.path}`)} | ${x.status} | ${fmt(x.faithful)} | ${fmt(x.clear)} | ${fmt(x.trigger)} | ${cell(why)} |`);
    }
  }
  lines.push('', '## Overlapping skills', '');
  if (r.overlaps.length === 0) lines.push(`None found (${r.overlapPairsChecked} similar-looking pairs checked by Luna).`);
  else {
    lines.push(`Luna judged these pairs to cover the same job (${r.overlapPairsChecked} similar-looking pairs checked):`, '',
      '| Skill | Skill | Probability |', '|---|---|---|');
    for (const o of r.overlaps) lines.push(`| ${cell(o.a)} | ${cell(o.b)} | ${fmt(o.probability)} |`);
  }
  if (r.untranslated.length > 0) {
    lines.push('', '## Left in Chinese', '', `${r.untranslated.length} non-Markdown files (code, data, config) contain Chinese and were copied unchanged:`, '');
    for (const u of r.untranslated.slice(0, 50)) lines.push(`- ${u}`);
    if (r.untranslated.length > 50) lines.push(`- … and ${r.untranslated.length - 50} more (see report.json)`);
  }
  if (r.skipped.length > 0) lines.push('', `## Not run`, '', `${r.skipped.length} files were left for a later run (--limit); run again to continue.`);
  return `${lines.join('\n')}\n`;
}

/** The skills by Luna's category, with their English descriptions. */
export function catalogMarkdown(r) {
  const groups = new Map();
  for (const s of r.skills) {
    const k = s.category ?? 'uncategorized';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const lines = ['# Skill catalog', '', `${r.skills.length} skills from ${r.sources.length} packs, sorted into categories by Luna.`, ''];
  for (const [k, list] of [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    lines.push(`## ${k} (${list.length})`, '');
    for (const s of list.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`- **${s.name}** (${s.pack}) — ${s.description || '(no description)'}${s.status !== 'accepted' ? ` _[${s.status}]_` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function writeReports(out, report) {
  fs.writeFileSync(path.join(out, 'REPORT.md'), reportMarkdown(report));
  fs.writeFileSync(path.join(out, 'CATALOG.md'), catalogMarkdown(report));
}
