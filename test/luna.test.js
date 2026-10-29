import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createLuna } from '../src/luna.js';

const KEY = 'test-key';
const DEFAULT_URL = 'https://api.openai.com/v1/decisions';
const CATEGORIES = [
  { value: 'storage', description: 'files, databases and backups' },
  { value: 'git' },
];

// Each reply is a thunk that makes a fresh Response, or an Error to reject with.
// The last reply repeats when calls outnumber replies.
function fakeFetch(...replies) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const reply = replies[Math.min(calls.length, replies.length - 1)];
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (reply instanceof Error) throw reply;
    return reply();
  };
  return { fetchFn, calls };
}

const reply = (body, status = 200, headers = {}) => () => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', ...headers },
});

const okReply = (answers, input = 1000, cached = 0) => reply({
  answers,
  usage: { input_tokens: input, input_tokens_details: { cached_tokens: cached } },
});

const predAns = (name, probability) => ({ type: 'predicate', name, probability });
const choiceAns = (name, choice, confidence) => ({
  type: 'choice', name, choice, confidence, probabilities: [{ value: choice, probability: 0.9 }],
});
const refusal = (name) => (name ? { type: 'refusal', name } : { type: 'refusal' });

function noSleep() {
  const sleeps = [];
  return { sleeps, sleepFn: async (ms) => { sleeps.push(ms); } };
}

const expectedCost = (tokens) => tokens * 0.10 / 1e6;

describe('createLuna setup', () => {
  test('a missing key throws at create time', () => {
    const msg = /set OPENAI_API_KEY \(Luna reviews every translation\)/;
    assert.throws(() => createLuna({}), msg);
    assert.throws(() => createLuna({ apiKey: '' }), msg);
    assert.throws(() => createLuna(), msg);
  });

  test('a key alone is enough to create the client', () => {
    const luna = createLuna({ apiKey: KEY });
    assert.equal(typeof luna.review, 'function');
    assert.equal(typeof luna.pick, 'function');
    assert.equal(typeof luna.overlap, 'function');
    assert.equal(typeof luna.totals, 'function');
  });
});

describe('review request shape', () => {
  const skillBody = {
    original: '# 备份\n运行 rsync -a src/ dst/ 之前先停止服务。',
    translation: '# Backup\nStop the service before you run rsync -a src/ dst/.',
  };

  test('a skill is sent with the developer rubric, the JSON data and all four questions', async () => {
    const { fetchFn, calls } = fakeFetch(okReply([
      predAns('faithful', 0.9),
      predAns('clear', 0.8),
      predAns('trigger', 0.7),
      choiceAns('category', 'storage', 0.95),
    ]));
    const luna = createLuna({ apiKey: KEY, fetchFn, backoffMs: 1 });
    await luna.review({ ...skillBody, kind: 'skill', categories: CATEGORIES });

    assert.equal(calls.length, 1);
    const { url, init, body } = calls[0];
    assert.equal(url, DEFAULT_URL);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.authorization, `Bearer ${KEY}`);
    assert.equal(init.headers['content-type'], 'application/json');
    assert.ok(init.signal instanceof AbortSignal);

    assert.equal(body.model, 'gpt-6-luna');
    assert.equal(body.prompt_cache_key, 'luna-skill-curator/v1');

    const [developer, user] = body.input;
    assert.equal(developer.role, 'developer');
    assert.equal(developer.content[0].type, 'input_text');
    assert.match(developer.content[0].text, /skill curator/);
    assert.match(developer.content[0].text, /Faithful:/);

    assert.equal(user.role, 'user');
    assert.equal(user.content[0].type, 'input_json');
    assert.deepEqual(user.content[0].data, { kind: 'skill', ...skillBody });

    assert.deepEqual(body.questions.map((q) => q.name), ['faithful', 'clear', 'trigger', 'category']);
  });

  test('the predicate and choice questions carry the wording and type the contract asks for', async () => {
    const { fetchFn, calls } = fakeFetch(okReply([
      predAns('faithful', 0.9),
      predAns('clear', 0.8),
      predAns('trigger', 0.7),
      choiceAns('category', 'storage', 0.95),
    ]));
    await createLuna({ apiKey: KEY, fetchFn }).review({ ...skillBody, kind: 'skill', categories: CATEGORIES });

    const [faithful, clear, trigger, category] = calls[0].body.questions;
    assert.deepEqual(faithful, {
      type: 'predicate',
      name: 'faithful',
      instructions: 'Does the translation keep every instruction, warning, number, command, path and identifier of the original, without adding or changing any?',
    });
    assert.equal(clear.type, 'predicate');
    assert.equal(clear.instructions, 'Is the translation clear, natural English that an engineer can follow without the original?');
    assert.equal(trigger.type, 'predicate');
    assert.equal(trigger.instructions, 'Does the front matter description say clearly what the skill does and when an agent should use it?');
    assert.equal(category.type, 'choice');
    assert.deepEqual(category.choices, [
      { value: 'storage', description: 'files, databases and backups' },
      { value: 'git' },
    ]);
  });

  test('a doc asks no trigger question and, without categories, no category question', async () => {
    const { fetchFn, calls } = fakeFetch(okReply([predAns('faithful', 0.9), predAns('clear', 0.8)]));
    const r = await createLuna({ apiKey: KEY, fetchFn }).review({ ...skillBody, kind: 'doc' });

    assert.deepEqual(calls[0].body.questions.map((q) => q.name), ['faithful', 'clear']);
    assert.equal(calls[0].body.input[1].content[0].data.kind, 'doc');
    assert.equal(r.trigger, null);
    assert.equal(r.category, null);
    assert.equal(r.categoryConfidence, null);
  });

  test('an empty categories list asks no category question', async () => {
    const { fetchFn, calls } = fakeFetch(okReply([predAns('faithful', 0.9), predAns('clear', 0.8), predAns('trigger', 0.6)]));
    const r = await createLuna({ apiKey: KEY, fetchFn }).review({ ...skillBody, kind: 'skill', categories: [] });

    assert.deepEqual(calls[0].body.questions.map((q) => q.name), ['faithful', 'clear', 'trigger']);
    assert.equal(r.category, null);
  });

  test('a skill without categories asks trigger but not category', async () => {
    const { fetchFn, calls } = fakeFetch(okReply([predAns('faithful', 0.9), predAns('clear', 0.8), predAns('trigger', 0.6)]));
    const r = await createLuna({ apiKey: KEY, fetchFn }).review({ ...skillBody, kind: 'skill' });

    assert.deepEqual(calls[0].body.questions.map((q) => q.name), ['faithful', 'clear', 'trigger']);
    assert.equal(r.trigger, 0.6);
  });
});

describe('review result', () => {
  test('probabilities, the category with its confidence, cost and tokens are parsed', async () => {
    const { fetchFn } = fakeFetch(okReply([
      predAns('faithful', 0.85),
      predAns('clear', 0.9),
      predAns('trigger', 0.7),
      choiceAns('category', 'git', 0.6),
    ], 1000, 200));
    const r = await createLuna({ apiKey: KEY, fetchFn }).review({
      original: 'a', translation: 'b', kind: 'skill', categories: CATEGORIES,
    });

    assert.equal(r.faithful, 0.85);
    assert.equal(r.clear, 0.9);
    assert.equal(r.trigger, 0.7);
    assert.equal(r.category, 'git');
    assert.equal(r.categoryConfidence, 0.6);
    assert.ok(Math.abs(r.cost - expectedCost(1000)) < 1e-12);
    assert.deepEqual(r.tokens, { input: 1000, cached: 200 });
  });

  test('a response without usage gives null cost and tokens', async () => {
    const { fetchFn } = fakeFetch(reply({ answers: [predAns('faithful', 0.5), predAns('clear', 0.5)] }));
    const r = await createLuna({ apiKey: KEY, fetchFn }).review({ original: 'a', translation: 'b', kind: 'doc' });

    assert.equal(r.cost, null);
    assert.equal(r.tokens, null);
  });

  test('a probability outside 0 to 1 is clamped', async () => {
    const { fetchFn } = fakeFetch(okReply([predAns('faithful', 1.2), predAns('clear', -0.1)]));
    const r = await createLuna({ apiKey: KEY, fetchFn }).review({ original: 'a', translation: 'b', kind: 'doc' });

    assert.equal(r.faithful, 1);
    assert.equal(r.clear, 0);
  });

  test('a missing answer is an error, not a silent null', async () => {
    const { fetchFn } = fakeFetch(okReply([predAns('faithful', 0.9)]));
    await assert.rejects(
      createLuna({ apiKey: KEY, fetchFn }).review({ original: 'a', translation: 'b', kind: 'doc' }),
      /no answer for "clear"/,
    );
  });

  test('an unknown category value is an error', async () => {
    const { fetchFn } = fakeFetch(okReply([
      predAns('faithful', 0.9), predAns('clear', 0.9), predAns('trigger', 0.9), choiceAns('category', 'network', 0.9),
    ]));
    await assert.rejects(
      createLuna({ apiKey: KEY, fetchFn }).review({ original: 'a', translation: 'b', kind: 'skill', categories: CATEGORIES }),
      /unknown choice for "category": network/,
    );
  });
});

describe('review truncation', () => {
  const okAll = () => fakeFetch(okReply([predAns('faithful', 0.9), predAns('clear', 0.9)]));

  test('a text longer than 24000 chars is cut and the data says so', async () => {
    const { fetchFn, calls } = okAll();
    await createLuna({ apiKey: KEY, fetchFn }).review({
      original: 'x'.repeat(30000), translation: 'short text', kind: 'doc',
    });
    const data = calls[0].body.input[1].content[0].data;

    assert.equal(data.original.length, 24000);
    assert.equal(data.translation, 'short text');
    assert.equal(data.truncated, true);
  });

  test('a text of exactly 24000 chars is not cut and no flag is sent', async () => {
    const { fetchFn, calls } = okAll();
    await createLuna({ apiKey: KEY, fetchFn }).review({
      original: 'y'.repeat(24000), translation: 'z'.repeat(24000), kind: 'doc',
    });
    const data = calls[0].body.input[1].content[0].data;

    assert.equal(data.original.length, 24000);
    assert.equal(data.translation.length, 24000);
    assert.equal('truncated' in data, false);
  });

  test('a cut never leaves half of a surrogate pair', async () => {
    const { fetchFn, calls } = okAll();
    // The emoji occupies units 23999 and 24000, so the cut would fall between them.
    await createLuna({ apiKey: KEY, fetchFn }).review({
      original: `${'x'.repeat(23999)}\u{1F600}tail`, translation: 'ok', kind: 'doc',
    });
    const data = calls[0].body.input[1].content[0].data;

    assert.equal(data.original.length, 23999);
    assert.ok(data.original.endsWith('x'));
    assert.equal(data.truncated, true);
  });
});

describe('review refusals', () => {
  test('a refused question gives null and the other questions still parse', async () => {
    const { fetchFn } = fakeFetch(okReply([refusal('faithful'), predAns('clear', 0.8)]));
    const r = await createLuna({ apiKey: KEY, fetchFn }).review({ original: 'a', translation: 'b', kind: 'doc' });

    assert.equal(r.faithful, null);
    assert.equal(r.clear, 0.8);
  });

  test('a refusal without a name is matched by its position', async () => {
    const { fetchFn } = fakeFetch(okReply([refusal(), predAns('clear', 0.8)]));
    const r = await createLuna({ apiKey: KEY, fetchFn }).review({ original: 'a', translation: 'b', kind: 'doc' });

    assert.equal(r.faithful, null);
    assert.equal(r.clear, 0.8);
  });

  test('a refused category gives null category and confidence', async () => {
    const { fetchFn } = fakeFetch(okReply([
      predAns('faithful', 0.9), predAns('clear', 0.9), predAns('trigger', 0.9), refusal('category'),
    ]));
    const r = await createLuna({ apiKey: KEY, fetchFn }).review({
      original: 'a', translation: 'b', kind: 'skill', categories: CATEGORIES,
    });

    assert.equal(r.category, null);
    assert.equal(r.categoryConfidence, null);
  });
});

describe('retries and errors', () => {
  const okBody = () => okReply([predAns('faithful', 0.9), predAns('clear', 0.8)]);
  const review = (luna) => luna.review({ original: 'a', translation: 'b', kind: 'doc' });

  test('429 is retried after the backoff, then succeeds', async () => {
    const { fetchFn, calls } = fakeFetch(reply({ error: { message: 'slow down' } }, 429), okBody());
    const { sleeps, sleepFn } = noSleep();
    const r = await review(createLuna({ apiKey: KEY, fetchFn, backoffMs: 1, sleepFn }));

    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [1]);
    assert.equal(r.faithful, 0.9);
  });

  test('the backoff doubles: 503, network error, 502, then success waits 1, 2 and 4 units', async () => {
    const { fetchFn, calls } = fakeFetch(
      reply({ error: { message: 'busy' } }, 503),
      new TypeError('fetch failed'),
      reply({ error: { message: 'bad gateway' } }, 502),
      okBody(),
    );
    const { sleeps, sleepFn } = noSleep();
    const r = await review(createLuna({ apiKey: KEY, fetchFn, backoffMs: 1, sleepFn }));

    assert.equal(calls.length, 4);
    assert.deepEqual(sleeps, [1, 2, 4]);
    assert.equal(r.clear, 0.8);
  });

  test('the default backoff is 1 s, 2 s, 4 s', async () => {
    const { fetchFn } = fakeFetch(
      reply({ error: { message: 'busy' } }, 503),
      reply({ error: { message: 'busy' } }, 503),
      reply({ error: { message: 'busy' } }, 503),
      okBody(),
    );
    const { sleeps, sleepFn } = noSleep();
    await review(createLuna({ apiKey: KEY, fetchFn, sleepFn }));

    assert.deepEqual(sleeps, [1000, 2000, 4000]);
  });

  test('Retry-After is honored in seconds', async () => {
    const { fetchFn } = fakeFetch(reply({ error: { message: 'slow' } }, 429, { 'retry-after': '5' }), okBody());
    const { sleeps, sleepFn } = noSleep();
    await review(createLuna({ apiKey: KEY, fetchFn, backoffMs: 1, sleepFn }));

    assert.deepEqual(sleeps, [5000]);
  });

  test('Retry-After is capped at 30 s', async () => {
    const { fetchFn } = fakeFetch(
      reply({ error: { message: 'slow' } }, 429, { 'retry-after': '120' }),
      reply({ error: { message: 'slow' } }, 429, { 'retry-after': '0' }),
      okBody(),
    );
    const { sleeps, sleepFn } = noSleep();
    await review(createLuna({ apiKey: KEY, fetchFn, backoffMs: 1, sleepFn }));

    // A zero Retry-After is not a usable value, so the backoff applies.
    assert.deepEqual(sleeps, [30000, 2]);
  });

  test('retries run out and the last HTTP error is thrown', async () => {
    const { fetchFn, calls } = fakeFetch(reply({ error: { message: 'boom' } }, 500));
    const { sleeps, sleepFn } = noSleep();

    await assert.rejects(
      review(createLuna({ apiKey: KEY, fetchFn, backoffMs: 1, sleepFn })),
      { message: 'Luna HTTP 500: boom' },
    );
    assert.equal(calls.length, 4);
    assert.deepEqual(sleeps, [1, 2, 4]);
  });

  test('a network error that never clears is thrown after the retries', async () => {
    const { fetchFn, calls } = fakeFetch(new TypeError('fetch failed'));
    const { sleepFn } = noSleep();

    await assert.rejects(review(createLuna({ apiKey: KEY, fetchFn, backoffMs: 1, sleepFn })), /fetch failed/);
    assert.equal(calls.length, 4);
  });

  test('a 400 throws at once with the API message and is not retried', async () => {
    const { fetchFn, calls } = fakeFetch(reply({ error: { message: 'bad model' } }, 400));
    const { sleeps, sleepFn } = noSleep();

    await assert.rejects(review(createLuna({ apiKey: KEY, fetchFn, backoffMs: 1, sleepFn })), {
      message: 'Luna HTTP 400: bad model',
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(sleeps, []);
  });

  test('a 401 is not retried', async () => {
    const { fetchFn, calls } = fakeFetch(reply({ error: { message: 'bad key' } }, 401));
    await assert.rejects(review(createLuna({ apiKey: KEY, fetchFn })), { message: 'Luna HTTP 401: bad key' });
    assert.equal(calls.length, 1);
  });

  test('an error body that is not JSON still gives a message', async () => {
    const fetchFn = async () => new Response('<html>nope</html>', { status: 400 });
    await assert.rejects(review(createLuna({ apiKey: KEY, fetchFn })), { message: 'Luna HTTP 400: no error body' });
  });
});

describe('pick', () => {
  const pickInput = { original: '运行 make test', a: 'Run make test.', b: 'Execute tests.' };

  test('the request asks one choice question over the original and both translations', async () => {
    const { fetchFn, calls } = fakeFetch(okReply([choiceAns('better', 'a', 0.8)]));
    await createLuna({ apiKey: KEY, fetchFn }).pick(pickInput);

    const { body } = calls[0];
    assert.equal(body.prompt_cache_key, 'luna-skill-curator/v1');
    assert.deepEqual(body.input[1].content[0].data, pickInput);
    assert.equal(body.questions.length, 1);
    const [q] = body.questions;
    assert.equal(q.type, 'choice');
    assert.equal(q.name, 'better');
    assert.deepEqual(q.choices.map((c) => c.value), ['a', 'b']);
    assert.match(q.instructions, /faithfulness first/);
  });

  test('the chosen translation and its confidence are returned with the cost', async () => {
    const { fetchFn } = fakeFetch(okReply([choiceAns('better', 'b', 0.8)], 500));
    const r = await createLuna({ apiKey: KEY, fetchFn }).pick(pickInput);

    assert.equal(r.choice, 'b');
    assert.equal(r.confidence, 0.8);
    assert.ok(Math.abs(r.cost - expectedCost(500)) < 1e-12);
  });

  test('a missing confidence is null, not a guess', async () => {
    const { fetchFn } = fakeFetch(reply({
      answers: [{ type: 'choice', name: 'better', choice: 'a' }],
      usage: { input_tokens: 10 },
    }));
    const r = await createLuna({ apiKey: KEY, fetchFn }).pick(pickInput);

    assert.equal(r.choice, 'a');
    assert.equal(r.confidence, null);
  });

  test('a refusal gives a null choice', async () => {
    const { fetchFn } = fakeFetch(okReply([refusal('better')]));
    const r = await createLuna({ apiKey: KEY, fetchFn }).pick(pickInput);

    assert.equal(r.choice, null);
    assert.equal(r.confidence, null);
  });

  test('a choice other than a or b is an error', async () => {
    const { fetchFn } = fakeFetch(okReply([choiceAns('better', 'c', 0.9)]));
    await assert.rejects(createLuna({ apiKey: KEY, fetchFn }).pick(pickInput), /unknown choice for "better": c/);
  });

  test('long inputs are cut and flagged like review', async () => {
    const { fetchFn, calls } = fakeFetch(okReply([choiceAns('better', 'a', 0.5)]));
    await createLuna({ apiKey: KEY, fetchFn }).pick({ original: 'o'.repeat(25000), a: 'a', b: 'b' });
    const data = calls[0].body.input[1].content[0].data;

    assert.equal(data.original.length, 24000);
    assert.equal(data.truncated, true);
  });
});

describe('overlap', () => {
  const a = { name: 'git-rebase-helper', description: 'Squash and reorder commits.' };
  const b = { name: 'history-cleaner', description: 'Rewrites git history to tidy commits.' };

  test('the request carries both skills and one predicate question', async () => {
    const { fetchFn, calls } = fakeFetch(okReply([predAns('overlap', 0.7)]));
    await createLuna({ apiKey: KEY, fetchFn }).overlap({ a, b });

    const { body } = calls[0];
    assert.deepEqual(body.input[1].content[0].data, { a, b });
    assert.equal(body.questions.length, 1);
    assert.equal(body.questions[0].type, 'predicate');
    assert.equal(body.questions[0].name, 'overlap');
    assert.equal(body.questions[0].instructions, 'Do these two skills cover the same job, so that an agent could not tell which one to use?');
  });

  test('the probability is returned with the cost', async () => {
    const { fetchFn } = fakeFetch(okReply([predAns('overlap', 0.7)], 2000));
    const r = await createLuna({ apiKey: KEY, fetchFn }).overlap({ a, b });

    assert.equal(r.probability, 0.7);
    assert.ok(Math.abs(r.cost - expectedCost(2000)) < 1e-12);
  });

  test('a refusal gives a null probability', async () => {
    const { fetchFn } = fakeFetch(okReply([refusal('overlap')]));
    const r = await createLuna({ apiKey: KEY, fetchFn }).overlap({ a, b });

    assert.equal(r.probability, null);
  });

  test('a predicate answer without a probability is an error', async () => {
    const { fetchFn } = fakeFetch(okReply([{ type: 'predicate', name: 'overlap' }]));
    await assert.rejects(createLuna({ apiKey: KEY, fetchFn }).overlap({ a, b }), /no probability for "overlap"/);
  });
});

describe('totals', () => {
  test('a new client has zero totals', () => {
    assert.deepEqual(createLuna({ apiKey: KEY }).totals(), { calls: 0, cost: 0, inputTokens: 0, cachedTokens: 0 });
  });

  test('calls, input tokens, cached tokens and cost accumulate across review, pick and overlap', async () => {
    const { fetchFn } = fakeFetch(
      okReply([predAns('faithful', 0.9), predAns('clear', 0.9)], 1000, 200),
      okReply([choiceAns('better', 'a', 0.8)], 500, 0),
      okReply([predAns('overlap', 0.4)], 300, 100),
    );
    const luna = createLuna({ apiKey: KEY, fetchFn });
    await luna.review({ original: 'a', translation: 'b', kind: 'doc' });
    await luna.pick({ original: 'a', a: 'b', b: 'c' });
    await luna.overlap({ a: { name: 'x' }, b: { name: 'y' } });

    const t = luna.totals();
    assert.equal(t.calls, 3);
    assert.equal(t.inputTokens, 1800);
    assert.equal(t.cachedTokens, 300);
    assert.ok(Math.abs(t.cost - expectedCost(1800)) < 1e-12);
  });

  test('retried requests and failed requests are not counted as calls', async () => {
    const { fetchFn } = fakeFetch(
      reply({ error: { message: 'slow' } }, 429),
      okReply([predAns('overlap', 0.4)], 300),
      reply({ error: { message: 'bad model' } }, 400),
    );
    const { sleepFn } = noSleep();
    const luna = createLuna({ apiKey: KEY, fetchFn, backoffMs: 1, sleepFn });
    await luna.overlap({ a: { name: 'x' }, b: { name: 'y' } });
    await assert.rejects(luna.overlap({ a: { name: 'x' }, b: { name: 'y' } }), /Luna HTTP 400/);

    const t = luna.totals();
    assert.equal(t.calls, 1);
    assert.equal(t.inputTokens, 300);
  });

  test('a call without usage counts as a call but adds no cost', async () => {
    const { fetchFn } = fakeFetch(
      reply({ answers: [predAns('overlap', 0.4)] }),
      okReply([predAns('overlap', 0.4)], 100),
    );
    const luna = createLuna({ apiKey: KEY, fetchFn });
    await luna.overlap({ a: { name: 'x' }, b: { name: 'y' } });
    await luna.overlap({ a: { name: 'x' }, b: { name: 'y' } });

    const t = luna.totals();
    assert.equal(t.calls, 2);
    assert.equal(t.inputTokens, 100);
    assert.ok(Math.abs(t.cost - expectedCost(100)) < 1e-12);
  });

  test('totals returns a copy that later calls do not change', async () => {
    const { fetchFn } = fakeFetch(okReply([predAns('overlap', 0.4)], 100));
    const luna = createLuna({ apiKey: KEY, fetchFn });
    const before = luna.totals();
    await luna.overlap({ a: { name: 'x' }, b: { name: 'y' } });

    assert.equal(before.calls, 0);
    assert.equal(luna.totals().calls, 1);
  });
});
