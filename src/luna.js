// Luna (OpenAI Decisions API, model gpt-6-luna) as the curator's reviewer and librarian.
// It answers typed questions only (predicate, choice) and never writes text. Zero dependencies.

const DEFAULT_URL = 'https://api.openai.com/v1/decisions';
const DEFAULT_MODEL = 'gpt-6-luna';
const CACHE_KEY = 'luna-skill-curator/v1';
// Longer texts are cut to keep each request small; the flag tells Luna the cut is not a defect.
const MAX_TEXT = 24000;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 30000;
// Uncached input price; cached reads cost less, so this is an upper bound.
const USD_PER_INPUT_TOKEN = 0.10 / 1e6;

// One rubric for every call: the shared prefix stays identical, so it is cached.
const RUBRIC = `You are the reviewer and librarian of a skill curator. Agent skill packs are folders of
Markdown files: each SKILL.md has a YAML front matter with a name and a description, and the body
tells a coding agent how to do a job; references hold more detail. The packs are written in Chinese,
English or both. The curator translates them into clear, natural English without changing their
meaning. Each request gives you a JSON object and one or more questions. Answer every question
independently, from the evidence in the JSON.

Judge like a careful technical editor:
- Faithful: the translation keeps every instruction, warning, number, unit, command, path,
  identifier and link of the original, and adds or changes none of them. A missing step is a
  failure, however well it reads.
- Clear: an engineer can follow the English without the original.
- Trigger: the front matter description says what the skill does and when an agent should use it.
- Category and overlap: judge a skill by its main job, not by a side detail.
- Pick: between two translations of the same original, faithfulness decides first; clarity decides
  only between translations that are equally faithful.

If the JSON says "truncated": true, only the start of a long text is shown. Judge the part you see
and do not count the cut itself as a missing part.

Give honest probabilities. When the evidence is thin, spread the probability across the plausible
answers instead of guessing.`;

const QUESTIONS = {
  faithful: 'Does the translation keep every instruction, warning, number, command, path and identifier of the original, without adding or changing any?',
  clear: 'Is the translation clear, natural English that an engineer can follow without the original?',
  trigger: 'Does the front matter description say clearly what the skill does and when an agent should use it?',
  category: 'Which category best fits this skill? Judge by its main job, not by a side detail.',
  better: 'Which translation is better? Judge faithfulness first: a translation that drops or changes an instruction, warning, number, command, path or identifier loses to one that keeps them all. If both are equally faithful, the clearer and more natural English wins.',
  overlap: 'Do these two skills cover the same job, so that an agent could not tell which one to use?',
};

function predicate(name) {
  return { type: 'predicate', name, instructions: QUESTIONS[name] };
}

function choiceOption({ value, description }) {
  return description ? { value, description } : { value };
}

// Cuts a text to MAX_TEXT and says whether it was cut.
function clip(text) {
  const s = String(text ?? '');
  if (s.length <= MAX_TEXT) return { text: s, truncated: false };
  let head = s.slice(0, MAX_TEXT);
  // Do not leave a lone high surrogate at the cut.
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return { text: head, truncated: true };
}

function skillView(skill = {}) {
  return { name: skill.name ?? '', description: skill.description ?? '' };
}

// Answers by question name. A refusal may carry no name, so its position in the list identifies it.
function answersOf(body, questions) {
  const out = new Map();
  const list = Array.isArray(body?.answers) ? body.answers : [];
  list.forEach((a, i) => {
    const name = a?.name ?? questions[i]?.name;
    if (typeof name === 'string') out.set(name, a);
  });
  return out;
}

// The answer to one question: null when Luna refused it; an error when it is missing or of another type.
function answerOf(answers, name, type) {
  const a = answers.get(name);
  if (!a) throw new Error(`Luna returned no answer for "${name}"`);
  if (a.type === 'refusal') return null;
  if (a.type !== type) throw new Error(`Luna returned a ${a.type} answer for "${name}", expected ${type}`);
  return a;
}

function probabilityIn(answers, name) {
  const a = answerOf(answers, name, 'predicate');
  if (!a) return null;
  if (!Number.isFinite(a.probability)) throw new Error(`Luna returned no probability for "${name}"`);
  return Math.min(1, Math.max(0, a.probability));
}

function choiceIn(answers, name, values) {
  const a = answerOf(answers, name, 'choice');
  if (!a) return null;
  if (!values.includes(a.choice)) throw new Error(`Luna returned an unknown choice for "${name}": ${a.choice}`);
  return { choice: a.choice, confidence: Number.isFinite(a.confidence) ? a.confidence : null };
}

/**
 * @param {{apiKey:string, url?:string, model?:string, timeoutMs?:number, fetchFn?:Function,
 *   retries?:number, backoffMs?:number, sleepFn?:(ms:number)=>Promise<void>}} options
 *   backoffMs and sleepFn exist so tests run without waiting; the defaults are the contract.
 */
export function createLuna({
  apiKey,
  url = DEFAULT_URL,
  model = DEFAULT_MODEL,
  timeoutMs = 60000,
  fetchFn = fetch,
  retries = 3,
  backoffMs = 1000,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!apiKey) throw new Error('set OPENAI_API_KEY (Luna reviews every translation)');
  const totals = { calls: 0, cost: 0, inputTokens: 0, cachedTokens: 0 };

  // Retry-After wins over the backoff when the server sends one, capped at 30 s.
  function retryDelay(res, attempt) {
    const seconds = Number(res.headers.get('retry-after'));
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    return backoffMs * 2 ** attempt;
  }

  async function post(body) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchFn(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (attempt >= retries) throw err;
        await sleepFn(backoffMs * 2 ** attempt);
        continue;
      }
      const json = await res.json().catch(() => null);
      if (res.ok) return json;
      if (!RETRY_STATUS.has(res.status) || attempt >= retries) {
        throw new Error(`Luna HTTP ${res.status}: ${json?.error?.message ?? 'no error body'}`);
      }
      await sleepFn(retryDelay(res, attempt));
    }
  }

  // Adds one successful call to the totals. Cost is the uncached-price bound of its input tokens.
  function record(usage) {
    totals.calls++;
    const input = usage?.input_tokens;
    if (!Number.isFinite(input)) return { cost: null, tokens: null };
    const cached = usage.input_tokens_details?.cached_tokens;
    const cachedCount = Number.isFinite(cached) ? cached : 0;
    const cost = input * USD_PER_INPUT_TOKEN;
    totals.cost += cost;
    totals.inputTokens += input;
    totals.cachedTokens += cachedCount;
    return { cost, tokens: { input, cached: cachedCount } };
  }

  // One Decisions call with the rubric, the JSON data and the questions.
  async function ask(data, questions) {
    const body = await post({
      model,
      input: [
        { role: 'developer', content: [{ type: 'input_text', text: RUBRIC }] },
        { role: 'user', content: [{ type: 'input_json', data }] },
      ],
      questions,
      prompt_cache_key: CACHE_KEY,
    });
    return { answers: answersOf(body, questions), ...record(body?.usage) };
  }

  /**
   * Reviews one translation. `trigger` is asked only for skills; `category` only when categories
   * are given. A refused question gives null.
   */
  async function review({ original, translation, kind, categories }) {
    const hasTrigger = kind === 'skill';
    const hasCategory = Array.isArray(categories) && categories.length > 0;
    const questions = [predicate('faithful'), predicate('clear')];
    if (hasTrigger) questions.push(predicate('trigger'));
    if (hasCategory) {
      questions.push({
        type: 'choice', name: 'category', instructions: QUESTIONS.category, choices: categories.map(choiceOption),
      });
    }

    const o = clip(original);
    const t = clip(translation);
    const data = { kind, original: o.text, translation: t.text };
    if (o.truncated || t.truncated) data.truncated = true;

    const { answers, cost, tokens } = await ask(data, questions);
    const category = hasCategory ? choiceIn(answers, 'category', categories.map((c) => c.value)) : null;
    return {
      faithful: probabilityIn(answers, 'faithful'),
      clear: probabilityIn(answers, 'clear'),
      trigger: hasTrigger ? probabilityIn(answers, 'trigger') : null,
      category: category?.choice ?? null,
      categoryConfidence: category?.confidence ?? null,
      cost,
      tokens,
    };
  }

  /** Which of two translations is better. `choice` and `confidence` are null on refusal. */
  async function pick({ original, a, b }) {
    const o = clip(original);
    const ta = clip(a);
    const tb = clip(b);
    const data = { original: o.text, a: ta.text, b: tb.text };
    if (o.truncated || ta.truncated || tb.truncated) data.truncated = true;

    const questions = [{
      type: 'choice',
      name: 'better',
      instructions: QUESTIONS.better,
      choices: [
        { value: 'a', description: 'the first translation' },
        { value: 'b', description: 'the second translation' },
      ],
    }];
    const { answers, cost } = await ask(data, questions);
    const picked = choiceIn(answers, 'better', ['a', 'b']);
    return { choice: picked?.choice ?? null, confidence: picked?.confidence ?? null, cost };
  }

  /** Whether two skills cover the same job. `probability` is null on refusal. */
  async function overlap({ a, b }) {
    const { answers, cost } = await ask({ a: skillView(a), b: skillView(b) }, [predicate('overlap')]);
    return { probability: probabilityIn(answers, 'overlap'), cost };
  }

  function totalsSnapshot() {
    return { ...totals };
  }

  return { review, pick, overlap, totals: totalsSnapshot };
}
