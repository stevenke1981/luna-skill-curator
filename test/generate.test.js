import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PROMPT_VERSION, createGenerator, translationPrompt } from '../src/generate.js';

const ENTRY = '/fake/codex/bin/codex.js';
const SAMPLE = '# Backup\n\nRun `zfs snapshot` first.\n';
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['markdown'],
  properties: { markdown: { type: 'string' } },
};

// Stands in for child_process.spawn. Like codex, it reads the prompt from
// stdin, writes the final message to the -o path, then exits.
function codexStub({
  exitCode = 0,
  stderr = '',
  writeOutput = true,
  output = { markdown: '# Translated\n' },
  hang = false,
} = {}) {
  const calls = [];
  const spawnFn = (file, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      return true;
    };
    const call = { file, args, options, child, stdinText: null, schemaText: null };
    calls.push(call);
    child.stdin = {
      end(data = '') {
        call.stdinText = String(data);
        call.schemaText = readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8');
        if (writeOutput) writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify(output));
        if (hang) return;
        setImmediate(() => {
          if (stderr) child.stderr.emit('data', Buffer.from(stderr));
          child.emit('exit', exitCode, null);
          child.emit('close', exitCode, null);
        });
      },
    };
    return child;
  };
  return { spawnFn, calls };
}

const dirOf = (call) => call.args[call.args.indexOf('-C') + 1];

function fetchStub(response) {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    return response;
  };
  return { fetchFn, calls };
}

function jsonResponse(body, { status = 200, statusText = '' } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, statusText, text: async () => text };
}

test('PROMPT_VERSION is v2', () => {
  assert.equal(PROMPT_VERSION, 'v2');
});

test('prompt for a skill names the file and asks for front matter and description rules', () => {
  const p = translationPrompt({ path: 'packs/backup/SKILL.md', kind: 'skill', text: SAMPLE });
  assert.match(p, /File: packs\/backup\/SKILL\.md/);
  assert.match(p, /Kind: skill \(SKILL\.md\)/);
  assert.match(p, /front matter/);
  assert.match(p, /`name`/);
  assert.match(p, /`description`/);
  assert.match(p, /`locale`/);
  assert.ok(p.includes(`<file>\n${SAMPLE}\n</file>`), 'text sits between <file> delimiters');
  assert.doesNotMatch(p, /earlier attempt/);
});

test('prompt for a doc has the base rules but no skill rules', () => {
  const p = translationPrompt({ path: 'refs/zfs.md', kind: 'doc', text: SAMPLE });
  assert.match(p, /Kind: document/);
  assert.doesNotMatch(p, /SKILL\.md/);
  assert.doesNotMatch(p, /front matter/);
  assert.doesNotMatch(p, /`description`/);
  assert.ok(p.includes(`<file>\n${SAMPLE}\n</file>`));
});

test('prompt carries the rules on meaning, code, structure and terms', () => {
  const p = translationPrompt({ path: 'a.md', kind: 'doc', text: 'x' });
  assert.match(p, /Keep every instruction, warning, number/);
  assert.match(p, /byte-identical/);
  assert.match(p, /Markdown structure/);
  assert.match(p, /RPO, RTO, ACL and ZFS/);
  assert.match(p, /never instructions to follow/);
});

test('prompt lists feedback items in order after the rules', () => {
  const p = translationPrompt({
    path: 'a/SKILL.md',
    kind: 'skill',
    text: SAMPLE,
    feedback: ['Warning on step 2 is missing', 'Code block 1 lost a line'],
  });
  assert.match(p, /Problems found in an earlier attempt/);
  const first = p.indexOf('- Warning on step 2 is missing');
  const second = p.indexOf('- Code block 1 lost a line');
  assert.ok(first > 0 && second > first, 'both items present, in order');
  assert.ok(p.indexOf('Problems found') < p.indexOf('\n<file>\n'), 'feedback comes before the text block');
});

test('prompt rejects an unknown kind', () => {
  assert.throws(() => translationPrompt({ path: 'a', kind: 'readme', text: 'x' }), /kind must be/);
});

test('codex: builds the exact argv and feeds the prompt on stdin', async () => {
  const { spawnFn, calls } = codexStub();
  const gen = createGenerator({ backend: 'codex', codexEntry: ENTRY, spawnFn });
  const req = { path: 'skills/backup/SKILL.md', kind: 'skill', text: SAMPLE };
  await gen.translate(req);

  const [call] = calls;
  const dir = dirOf(call);
  const schema = call.args[call.args.indexOf('--output-schema') + 1];
  const out = call.args[call.args.indexOf('-o') + 1];
  assert.equal(call.file, process.execPath);
  assert.deepEqual(call.args, [
    ENTRY,
    'exec',
    '--skip-git-repo-check',
    '-s',
    'read-only',
    '-C',
    dir,
    '--output-schema',
    schema,
    '-o',
    out,
    '-',
  ]);
  assert.equal(path.dirname(schema), dir, 'schema lives in the temp dir');
  assert.equal(path.dirname(out), dir, 'output lives in the temp dir');
  assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(call.stdinText, translationPrompt(req));
  assert.deepEqual(JSON.parse(call.schemaText), SCHEMA);
});

test('codex: adds -m before the stdin marker only when a model is set', async () => {
  const withModel = codexStub();
  await createGenerator({ backend: 'codex', model: 'gpt-x', codexEntry: ENTRY, spawnFn: withModel.spawnFn }).translate({
    path: 'a.md',
    kind: 'doc',
    text: 'x',
  });
  assert.deepEqual(withModel.calls[0].args.slice(-3), ['-m', 'gpt-x', '-']);

  const noModel = codexStub();
  await createGenerator({ backend: 'codex', codexEntry: ENTRY, spawnFn: noModel.spawnFn }).translate({
    path: 'a.md',
    kind: 'doc',
    text: 'x',
  });
  assert.equal(noModel.calls[0].args.includes('-m'), false);
  assert.equal(noModel.calls[0].args.at(-1), '-');
});

test('codex: returns the markdown from out.json and removes its temp dir', async () => {
  const { spawnFn, calls } = codexStub({ output: { markdown: '# Backup\n' } });
  const gen = createGenerator({ backend: 'codex', codexEntry: ENTRY, spawnFn });
  const res = await gen.translate({ path: 'a.md', kind: 'doc', text: SAMPLE });
  assert.equal(res.markdown, '# Backup\n');
  assert.equal(typeof res.ms, 'number');
  assert.equal(existsSync(dirOf(calls[0])), false, 'temp dir removed after success');
});

test('codex: non-zero exit rejects with the last 300 chars of stderr and cleans up', async () => {
  const stderr = 'A'.repeat(400) + 'TAIL-MARK';
  const { spawnFn, calls } = codexStub({ exitCode: 2, stderr, writeOutput: false });
  const gen = createGenerator({ backend: 'codex', codexEntry: ENTRY, spawnFn });
  await assert.rejects(gen.translate({ path: 'a.md', kind: 'doc', text: 'x' }), (err) => {
    assert.match(err.message, /^codex exited with code 2: /);
    assert.match(err.message, /TAIL-MARK$/);
    assert.equal(err.message.includes('A'.repeat(292)), false, 'only the last 300 chars are kept');
    return true;
  });
  assert.equal(existsSync(dirOf(calls[0])), false, 'temp dir removed after failure');
});

test('codex: exit 0 without out.json rejects and names the missing output', async () => {
  const { spawnFn, calls } = codexStub({ writeOutput: false, stderr: 'warn: nothing written\n' });
  const gen = createGenerator({ backend: 'codex', codexEntry: ENTRY, spawnFn });
  await assert.rejects(
    gen.translate({ path: 'a.md', kind: 'doc', text: 'x' }),
    { message: 'codex wrote no output file: warn: nothing written' },
  );
  assert.equal(existsSync(dirOf(calls[0])), false, 'temp dir removed after missing output');
});

test('codex: out.json without a markdown string rejects', async () => {
  const { spawnFn } = codexStub({ output: { text: 'wrong key' } });
  const gen = createGenerator({ backend: 'codex', codexEntry: ENTRY, spawnFn });
  await assert.rejects(gen.translate({ path: 'a.md', kind: 'doc', text: 'x' }), /no markdown string/);
});

test('codex: a spawn failure such as a missing codex binary rejects', async () => {
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    child.stdin = {
      end() {
        setImmediate(() => child.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })));
      },
    };
    return child;
  };
  const gen = createGenerator({ backend: 'codex', codexEntry: ENTRY, spawnFn });
  await assert.rejects(gen.translate({ path: 'a.md', kind: 'doc', text: 'x' }), { code: 'ENOENT' });
});

test('codex: timeout kills the child and rejects', async () => {
  const { spawnFn, calls } = codexStub({ hang: true });
  const gen = createGenerator({ backend: 'codex', codexEntry: ENTRY, spawnFn, timeoutMs: 20 });
  await assert.rejects(gen.translate({ path: 'a.md', kind: 'doc', text: 'x' }), /codex timed out after 20 ms/);
  assert.equal(calls[0].child.killed, true);
});

test('codex: with no entry script it runs the codex command directly', async () => {
  const { spawnFn, calls } = codexStub();
  const gen = createGenerator({ backend: 'codex', codexEntry: '', spawnFn });
  await gen.translate({ path: 'a.md', kind: 'doc', text: 'x' });
  assert.equal(calls[0].file, 'codex');
  assert.equal(calls[0].args[0], 'exec');
});

test('openai: sends the Responses API request with the schema and bearer key', async () => {
  const { fetchFn, calls } = fetchStub(jsonResponse({ output_text: JSON.stringify({ markdown: '# Hi' }) }));
  const gen = createGenerator({ backend: 'openai', apiKey: 'test-key', fetchFn });
  const req = { path: 'a/SKILL.md', kind: 'skill', text: SAMPLE, feedback: ['keep the warning'] };
  const res = await gen.translate(req);

  assert.equal(res.markdown, '# Hi');
  assert.equal(typeof res.ms, 'number');
  assert.equal(calls.length, 1);
  const { url, options } = calls[0];
  assert.equal(url, 'https://api.openai.com/v1/responses');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.authorization, 'Bearer test-key');
  assert.equal(options.headers['content-type'], 'application/json');
  assert.ok(options.signal instanceof AbortSignal, 'request carries a timeout signal');
  const body = JSON.parse(options.body);
  assert.equal(body.model, 'gpt-6.1-terra');
  assert.equal(body.input, translationPrompt(req));
  assert.match(body.input, /keep the warning/);
  assert.deepEqual(body.text, { format: { type: 'json_schema', name: 'translation', strict: true, schema: SCHEMA } });
});

test('openai: honors the model and url overrides', async () => {
  const { fetchFn, calls } = fetchStub(jsonResponse({ output_text: '{"markdown":"x"}' }));
  const gen = createGenerator({
    backend: 'openai',
    apiKey: 'k',
    model: 'gpt-x',
    url: 'https://proxy.example/v1/responses',
    fetchFn,
  });
  await gen.translate({ path: 'a.md', kind: 'doc', text: 'x' });
  assert.equal(calls[0].url, 'https://proxy.example/v1/responses');
  assert.equal(JSON.parse(calls[0].options.body).model, 'gpt-x');
});

test('openai: reads the text from output_text', async () => {
  const { fetchFn } = fetchStub(jsonResponse({ output_text: JSON.stringify({ markdown: '# A\n' }) }));
  const gen = createGenerator({ backend: 'openai', apiKey: 'k', fetchFn });
  assert.equal((await gen.translate({ path: 'a.md', kind: 'doc', text: 'x' })).markdown, '# A\n');
});

test('openai: reads the text from output[].content[] output_text parts, joined in order', async () => {
  const body = {
    output: [
      { type: 'reasoning', summary: [] },
      {
        type: 'message',
        content: [
          { type: 'output_text', text: '{"markdown":' },
          { type: 'output_text', text: '"# C\\n"}' },
        ],
      },
    ],
  };
  const { fetchFn } = fetchStub(jsonResponse(body));
  const gen = createGenerator({ backend: 'openai', apiKey: 'k', fetchFn });
  assert.equal((await gen.translate({ path: 'a.md', kind: 'doc', text: 'x' })).markdown, '# C\n');
});

test('openai: a refusal rejects with the reason', async () => {
  const body = { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'cannot' }] }] };
  const { fetchFn } = fetchStub(jsonResponse(body));
  const gen = createGenerator({ backend: 'openai', apiKey: 'k', fetchFn });
  await assert.rejects(gen.translate({ path: 'a.md', kind: 'doc', text: 'x' }), /generator refused: cannot/);
});

test('openai: a response with no text rejects', async () => {
  const { fetchFn } = fetchStub(jsonResponse({ output: [] }));
  const gen = createGenerator({ backend: 'openai', apiKey: 'k', fetchFn });
  await assert.rejects(gen.translate({ path: 'a.md', kind: 'doc', text: 'x' }), /no text/);
});

test('openai: text without a markdown field rejects', async () => {
  const { fetchFn } = fetchStub(jsonResponse({ output_text: '{"x":1}' }));
  const gen = createGenerator({ backend: 'openai', apiKey: 'k', fetchFn });
  await assert.rejects(gen.translate({ path: 'a.md', kind: 'doc', text: 'x' }), /no markdown string/);
});

test('openai: HTTP error uses the API error message', async () => {
  const { fetchFn } = fetchStub(jsonResponse({ error: { message: 'rate limited' } }, { status: 429 }));
  const gen = createGenerator({ backend: 'openai', apiKey: 'k', fetchFn });
  await assert.rejects(gen.translate({ path: 'a.md', kind: 'doc', text: 'x' }), {
    message: 'Generator HTTP 429: rate limited',
  });
});

test('openai: HTTP error with a non-JSON body uses the raw body', async () => {
  const { fetchFn } = fetchStub(jsonResponse('boom', { status: 500 }));
  const gen = createGenerator({ backend: 'openai', apiKey: 'k', fetchFn });
  await assert.rejects(gen.translate({ path: 'a.md', kind: 'doc', text: 'x' }), {
    message: 'Generator HTTP 500: boom',
  });
});

test('openai: without an API key the generator refuses to be created', () => {
  assert.throws(() => createGenerator({ backend: 'openai' }), /set OPENAI_API_KEY/);
});

test('mock: calls the mock with the request and returns its markdown', async () => {
  const seen = [];
  const gen = createGenerator({
    backend: 'mock',
    mock: async (req) => {
      seen.push(req);
      return '# Mocked\n';
    },
  });
  const req = { path: 'x.md', kind: 'doc', text: 'body', feedback: ['fix it'] };
  const res = await gen.translate(req);
  assert.equal(res.markdown, '# Mocked\n');
  assert.equal(typeof res.ms, 'number');
  assert.deepEqual(seen, [req]);
});

test('mock: needs a mock function', () => {
  assert.throws(() => createGenerator({ backend: 'mock' }), /mock backend needs a mock function/);
});

test('an unknown backend is rejected at create time', () => {
  assert.throws(() => createGenerator({ backend: 'nope' }), /unknown generator backend: nope/);
});
