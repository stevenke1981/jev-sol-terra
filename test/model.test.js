import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskProfile, wantsModelRouting, modelId, clampEffort, chooseModel } from '../src/model.js';
import { createRouter } from '../src/router.js';
import { loadConfig } from '../src/config.js';
import { parseTurn } from '../src/trajectory.js';
import { LONG_PROMPT_CHARS } from '../src/policy.js';

const auto = loadConfig({});
const IMG = 'data:image/png;base64,AAAA';
const userMsg = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const assistantMsg = (text) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const turnOf = (text) => ({ userText: text, steps: [], assistantMessages: 0 });
const TERRA_TASK = { affinity: 'terra', reasons: ['writing task'] };
const SOL_TASK = { affinity: 'sol', reasons: ['hard task'] };
const NEUTRAL = { affinity: 'neutral', reasons: ['no strong signal'] };
const TOP = 3; // ladder low, medium, high, xhigh

// Shell call + output pair; `ok` exits 0, `failing` exits 1 on `make`.
const shell = (id, command, output) => [
  { type: 'function_call', name: 'shell', call_id: id, arguments: JSON.stringify({ command: ['bash', '-lc', command] }) },
  { type: 'function_call_output', call_id: id, output },
];
const ok = (i) => shell(`k${i}`, 'ls', 'Exit code: 0\nOutput:\nsrc');
const failing = (i) => shell(`c${i}`, 'make', 'Exit code: 1\nOutput:\nboom');

// Routes with model routing on; the session id is fixed so calls share state.
const routed = (router, body, bodyBytes = 1000) =>
  router.route(body, 's1', null, parseTurn(body.input), { routeModel: true, bodyBytes });

// ---- taskProfile ----------------------------------------------------------

test('taskProfile: images in the current turn (Responses input_image) mean terra', () => {
  // "why" would be a hard task; the image rule comes first.
  const body = {
    input: [userMsg('earlier'), { type: 'message', role: 'user', content: [
      { type: 'input_image', image_url: IMG }, { type: 'input_text', text: 'why is this button misaligned?' }] }],
  };
  assert.deepEqual(taskProfile(body, parseTurn(body.input)), { affinity: 'terra', reasons: ['images in this turn'] });
});

test('taskProfile: images in Chat Completions parts (image_url and input_image) mean terra', () => {
  const chat = { messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: IMG } }] }] };
  assert.equal(taskProfile(chat, turnOf('what is this?')).affinity, 'terra');
  const legacy = { messages: [{ role: 'user', content: [{ type: 'input_image', image_url: IMG }] }] };
  assert.equal(taskProfile(legacy, turnOf('')).affinity, 'terra');
});

test('taskProfile: an image from an earlier turn does not pin the current turn; an image-only message does', () => {
  const old = { input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: IMG }] }, assistantMsg('ok'), userMsg('list the files')] };
  assert.equal(taskProfile(old, parseTurn(old.input)).affinity, 'neutral');
  const imageOnly = { input: [userMsg('hi'), { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: IMG }] }] };
  assert.equal(taskProfile(imageOnly, parseTurn(imageOnly.input)).affinity, 'terra');
});

test('taskProfile: a computer-use tool, or a browser tool this turn called, means terra', () => {
  const turn = turnOf('fix the login form');
  assert.equal(taskProfile({ tools: [{ type: 'computer_use_preview', display_width: 1280 }] }, turn).affinity, 'terra');
  // Merely mounted MCP browser tools do not pin the session to terra.
  const browserTools = { tools: [{ type: 'function', name: 'browser_navigate' }, { type: 'function', function: { name: 'take_screenshot' } }] };
  assert.equal(taskProfile(browserTools, turn).affinity, 'neutral');
  for (const command of ['browser_navigate {"url":"http://x"}', 'playwright_click {}', 'take_screenshot {}']) {
    const called = { ...turn, steps: [{ kind: 'tool', command, failed: false }] };
    assert.equal(taskProfile(browserTools, called).affinity, 'terra', command);
  }
  const reading = { ...turn, steps: [{ kind: 'read', command: 'cat browser.js', failed: false }] };
  assert.equal(taskProfile({}, reading).affinity, 'neutral');
});

test('taskProfile: "copy" is not a writing signal', () => {
  assert.equal(taskProfile({}, turnOf('copy the file to dist')).affinity, 'neutral');
});

test('taskProfile: a hard task or a long prompt means sol', () => {
  assert.deepEqual(taskProfile({}, turnOf('design a retry policy for the uploader')), { affinity: 'sol', reasons: ['hard task'] });
  assert.equal(taskProfile({}, turnOf('為什麼這裡會慢？')).affinity, 'sol');
  const long = taskProfile({}, turnOf('x'.repeat(LONG_PROMPT_CHARS + 1)));
  assert.equal(long.affinity, 'sol');
  assert.match(long.reasons[0], /^long prompt \(601 chars\)$/);
  assert.equal(taskProfile({}, turnOf('x'.repeat(LONG_PROMPT_CHARS))).affinity, 'neutral');
});

test('taskProfile: a hard task beats the writing rule', () => {
  assert.equal(taskProfile({}, turnOf('write a design doc for the cache')).affinity, 'sol');
});

test('taskProfile: writing without code means terra, in English and Chinese', () => {
  for (const text of [
    'write a short email to my landlord',
    'Rewrite this paragraph for a blog post',
    'translate the README into Japanese',
    '撰寫一篇介紹產品的文章',
    '幫我改寫這段文案',
  ]) {
    assert.equal(taskProfile({}, turnOf(text)).affinity, 'terra', text);
  }
});

test('taskProfile: writing that also shows code is neutral, not terra', () => {
  assert.deepEqual(taskProfile({}, turnOf('write a function that parses the CSV')), { affinity: 'neutral', reasons: ['writing with code'] });
  assert.equal(taskProfile({}, turnOf('draft the README with a ```js example```')).affinity, 'neutral');
  assert.equal(taskProfile({}, turnOf('write a test for parse.py')).affinity, 'neutral');
  assert.equal(taskProfile({}, turnOf('撰寫這段程式的說明文件')).affinity, 'neutral');
});

test('taskProfile: anything else is neutral', () => {
  assert.deepEqual(taskProfile({}, turnOf('the build looks slow today')), { affinity: 'neutral', reasons: ['no strong signal'] });
});

test('taskProfile: a deep question means sol', () => {
  for (const q of ['How does the event loop schedule microtasks?', 'explain how the cache invalidates entries',
    'what are the trade-offs of SQLite vs Postgres here', 'analyze the complexity of this algorithm',
    '深入說明 React 的 reconciliation 原理', '比較 zstd 與 gzip 的取捨', '這個鎖是怎麼運作的？']) {
    assert.deepEqual(taskProfile({}, turnOf(q)), { affinity: 'sol', reasons: ['deep question'] }, q);
  }
});

test('taskProfile: clear instructions start on terra (neutral), including a long step list', () => {
  for (const q of ['list the files in src', 'rename getUser to fetchUser in api.ts', 'Please add a --verbose flag to the CLI',
    'run npm test and report', '幫我把 config.json 的 port 改成 9000', '請新增一個 .gitignore', '依照 README 安裝依賴']) {
    assert.deepEqual(taskProfile({}, turnOf(q)), { affinity: 'neutral', reasons: ['clear instructions'] }, q);
  }
  const steps = ['1. bump the version in package.json', '2. update CHANGELOG.md', '3. run npm test', '4. commit as "release 1.2.0"']
    .join('\n').concat('\n', 'Notes: '.padEnd(LONG_PROMPT_CHARS, 'x'));
  assert.deepEqual(taskProfile({}, turnOf(steps)), { affinity: 'neutral', reasons: ['clear instructions (4 steps)'] });
  // Two bullets are not a plan; the long prompt still goes to sol.
  const two = `- a\n- b\n${'x'.repeat(LONG_PROMPT_CHARS)}`;
  assert.equal(taskProfile({}, turnOf(two)).affinity, 'sol');
  // A hard task stays on sol even when phrased as an instruction.
  assert.equal(taskProfile({}, turnOf('refactor the auth module into services')).affinity, 'sol');
});

// ---- wantsModelRouting / modelId / clampEffort ----------------------------

test('wantsModelRouting: aliases, both ids and the openai/ prefix hand over; other models do not', () => {
  for (const model of ['jev-auto', 'auto', 'AUTO', 'gpt-6.1-terra', 'gpt-6.1-sol', 'openai/gpt-6.1-sol', 'openai/gpt-6.1-terra']) {
    assert.equal(wantsModelRouting({ model }, auto), true, model);
  }
  for (const model of ['gpt-5.5', 'openai/gpt-5.5', 'gpt-6.1', 'gpt-6.1-sol-mini', '', undefined, 42]) {
    assert.equal(wantsModelRouting({ model }, auto), false, String(model));
  }
  assert.equal(wantsModelRouting({}, auto), false);
});

test('wantsModelRouting follows configured ids, not the defaults', () => {
  const custom = loadConfig({ JEV_SOL_MODEL: 'my-sol' });
  assert.equal(wantsModelRouting({ model: 'my-sol' }, custom), true);
  assert.equal(wantsModelRouting({ model: 'gpt-6.1-sol' }, custom), false);
});

test('modelId: OpenRouter needs the openai/ prefix unless the id already has a slash', () => {
  assert.equal(modelId('sol', auto, false), 'gpt-6.1-sol');
  assert.equal(modelId('terra', auto, true), 'openai/gpt-6.1-terra');
  const vendor = loadConfig({ JEV_SOL_MODEL: 'acme/sol-x' });
  assert.equal(modelId('sol', vendor, true), 'acme/sol-x');
  assert.equal(modelId('sol', vendor, false), 'acme/sol-x');
});

test('clampEffort: sol has no none/minimal, terra has no minimal', () => {
  assert.equal(clampEffort('sol', 'none'), 'low');
  assert.equal(clampEffort('sol', 'minimal'), 'low');
  assert.equal(clampEffort('sol', 'low'), 'low');
  assert.equal(clampEffort('sol', 'xhigh'), 'xhigh');
  assert.equal(clampEffort('sol', 'max'), 'max');
  assert.equal(clampEffort('terra', 'none'), 'none');
  assert.equal(clampEffort('terra', 'minimal'), 'low');
  assert.equal(clampEffort('terra', 'medium'), 'medium');
  assert.equal(clampEffort('terra', 'max'), 'max');
});

// ---- chooseModel ----------------------------------------------------------

function pick(prev, over = {}) {
  return chooseModel(prev, { config: auto, profile: NEUTRAL, newTurn: false, level: 0, top: TOP, strong: null, bodyBytes: 1000, ...over });
}

test('chooseModel: a pinned model ignores the task and the state', () => {
  const pinSol = loadConfig({ JEV_MODEL: 'sol' });
  const pinTerra = loadConfig({ JEV_MODEL: 'terra' });
  assert.deepEqual(pick({ model: 'terra' }, { config: pinSol, profile: TERRA_TASK, newTurn: true }), { model: 'sol', reasons: ['pinned'] });
  assert.deepEqual(pick({ model: 'sol' }, { config: pinTerra, profile: SOL_TASK, level: TOP, strong: 0.9 }), { model: 'terra', reasons: ['pinned'] });
});

test('chooseModel: a new turn follows the task affinity', () => {
  assert.equal(pick(undefined, { newTurn: true, profile: SOL_TASK }).model, 'sol');
  assert.equal(pick(undefined, { newTurn: true, profile: TERRA_TASK }).model, 'terra');
  assert.equal(pick(undefined, { newTurn: true, profile: NEUTRAL }).model, 'terra');
  assert.equal(pick({ model: 'terra' }, { newTurn: true, profile: SOL_TASK }).model, 'sol');
});

test('chooseModel: sol drops to terra on a new turn only when the body is small', () => {
  const big = { newTurn: true, profile: NEUTRAL, bodyBytes: 65537 };
  const blocked = pick({ model: 'sol' }, big);
  assert.equal(blocked.model, 'sol');
  assert.match(blocked.reasons.join(), /stay sol/);
  assert.equal(pick({ model: 'sol' }, { newTurn: true, profile: TERRA_TASK, bodyBytes: 70000 }).model, 'sol');
  // The limit is inclusive: a body of exactly downgradeMaxBytes may still downgrade.
  assert.equal(pick({ model: 'sol' }, { ...big, bodyBytes: 65536 }).model, 'terra');
  const small = pick({ model: 'sol' }, { ...big, bodyBytes: 1000 });
  assert.equal(small.model, 'terra');
  assert.match(small.reasons.join(), /downgrade within limit/);
});

test('chooseModel: sol stays sol for the rest of the turn', () => {
  assert.equal(pick({ model: 'sol' }, { profile: TERRA_TASK, level: 0 }).model, 'sol');
  assert.equal(pick({ model: 'sol' }, { profile: NEUTRAL, level: 0, strong: 0 }).model, 'sol');
});

test('chooseModel: neutral terra escalates to sol at the top rung', () => {
  const r = pick({ model: 'terra' }, { profile: NEUTRAL, level: TOP });
  assert.equal(r.model, 'sol');
  assert.match(r.reasons.join(), /top effort/);
  assert.equal(pick({ model: 'terra' }, { profile: NEUTRAL, level: TOP - 1 }).model, 'terra');
});

test('chooseModel: neutral terra escalates to sol when strong >= 0.6', () => {
  const r = pick({ model: 'terra' }, { profile: NEUTRAL, level: 1, strong: 0.6 });
  assert.equal(r.model, 'sol');
  assert.match(r.reasons.join(), /strong 0\.60/);
  assert.equal(pick({ model: 'terra' }, { profile: NEUTRAL, level: 1, strong: 0.59 }).model, 'terra');
  assert.equal(pick({ model: 'terra' }, { profile: NEUTRAL, level: 1, strong: 0.95 }).model, 'sol');
});

test('chooseModel: a terra-affinity turn never escalates, even at the top rung with strong', () => {
  const r = pick({ model: 'terra' }, { profile: TERRA_TASK, level: TOP, strong: 0.99 });
  assert.equal(r.model, 'terra');
  assert.match(r.reasons.join(), /terra affinity/);
});

// ---- router.route with model routing --------------------------------------

test('router.route: a hard task starts on sol and reports the choice', async () => {
  const router = createRouter(auto);
  const d = await routed(router, { model: 'jev-auto', input: [userMsg('design the retry logic')] });
  assert.equal(d.model, 'sol');
  assert.equal(d.fromModel, null);
  assert.equal(d.effort, 'medium');
  assert.match(d.modelReasons.join(), /hard task/);
});

test('router.route: a neutral turn starts on terra, then moves to sol at the top rung and reports fromModel', async () => {
  const router = createRouter(auto);
  const u = userMsg('fix the flaky build');
  const d1 = await routed(router, { input: [u] });
  assert.deepEqual([d1.effort, d1.model, d1.fromModel], ['low', 'terra', null]);
  const d2 = await routed(router, { input: [u, ...failing(1)] });
  assert.deepEqual([d2.effort, d2.model, d2.fromModel], ['medium', 'terra', null]);
  const d3 = await routed(router, { input: [u, ...failing(1), ...failing(2)] });
  assert.deepEqual([d3.effort, d3.model], ['high', 'terra']);
  const d4 = await routed(router, { input: [u, ...failing(1), ...failing(2), ...failing(3)] });
  assert.deepEqual([d4.effort, d4.model, d4.fromModel], ['xhigh', 'sol', 'terra']);
  assert.match(d4.modelReasons.join(), /top effort/);
  const d5 = await routed(router, { input: [u, ...failing(1), ...failing(2), ...failing(3), ...failing(4)] });
  assert.deepEqual([d5.model, d5.fromModel], ['sol', null]);
});

test('router.route: a terra-affinity turn stays on terra up to the top rung', async () => {
  const router = createRouter(auto);
  const u = userMsg('write a short email to the team');
  const last = await routed(router, { input: [u, ...failing(1), ...failing(2), ...failing(3)] });
  assert.deepEqual([last.effort, last.model, last.fromModel], ['xhigh', 'terra', null]);
});

test('router.route: a new turn after sol keeps sol when the body is large, downgrades when small', async () => {
  const router = createRouter(auto);
  const first = await routed(router, { input: [userMsg('design the cache')] });
  assert.equal(first.model, 'sol');
  const next = { input: [userMsg('design the cache'), assistantMsg('done'), userMsg('list the files')] };
  const big = await routed(router, next, 70000);
  assert.equal(big.model, 'sol');
  const small = await routed(router, next, 1000);
  assert.equal(small.model, 'terra');
  assert.equal(small.fromModel, null);
});

test('router.route: a Jev strong answer escalates a neutral terra turn to sol at 0.6 and above', async () => {
  const strongAt = (strong) => createRouter(loadConfig({ OPENROUTER_API_KEY: 'or-test' }), {
    decideFn: async () => ({ target: 0, hold: 0, release: false, reasons: ['stub'], cost: null, strong }),
  });
  const u = userMsg('fix the flaky build');
  const next = { input: [u, ...ok(1)] };

  const high = strongAt(0.7);
  assert.equal((await routed(high, { input: [u] })).model, 'terra');
  const escalated = await routed(high, next);
  assert.deepEqual([escalated.model, escalated.fromModel], ['sol', 'terra']);
  assert.match(escalated.modelReasons.join(), /strong 0\.70/);

  const low = strongAt(0.59);
  assert.equal((await routed(low, { input: [u] })).model, 'terra');
  assert.equal((await routed(low, next)).model, 'terra');
});

test('router.route: without routeModel the model fields stay empty and effort still routes', async () => {
  const router = createRouter(auto);
  const d = await router.route({ model: 'gpt-5.5', input: [userMsg('design the cache')] }, 's2', null);
  assert.deepEqual([d.model, d.fromModel, d.modelReasons], [null, null, []]);
  assert.equal(d.effort, 'medium');
});

test('router.route: an effort-only request keeps the session model for the next routed one', async () => {
  const router = createRouter(auto);
  const input = [userMsg('design the cache')];
  await router.route({ model: 'jev-auto', input }, 's3', null, parseTurn(input), { routeModel: true });
  await router.route({ model: 'gpt-5.5', input }, 's3', null);
  assert.equal(router.sessions.get('s3').model, 'sol');
});

test('chooseModel: terra still stuck after a generation at the second rung escalates to sol', () => {
  const second = TOP - 1;
  const terraAt = (level) => ({ model: 'terra', level, hold: 2, step: 3 });
  const pick = (prev, over) => chooseModel(prev, { config: auto, profile: NEUTRAL, newTurn: false, top: TOP, strong: null, bodyBytes: 1000, ...over });
  // Real Jev answers after 2 and 3 failures: score ~2 (high), stuck 0.96-0.97.
  assert.equal(pick(terraAt(second - 1), { level: second, stuck: 0.96 }).model, 'terra');
  const esc = pick(terraAt(second), { level: second, stuck: 0.97 });
  assert.equal(esc.model, 'sol');
  assert.match(esc.reasons[0], /still stuck 0\.97/);
  assert.equal(pick(terraAt(second), { level: second, stuck: 0.89 }).model, 'terra');
  assert.equal(pick(terraAt(second), { level: second, stuck: null }).model, 'terra');
  const terraTask = { affinity: 'terra', reasons: ['images in this turn'] };
  assert.equal(pick(terraAt(second), { level: second, stuck: 0.99, profile: terraTask }).model, 'terra');
});

test('taskProfile: a shell step named like a browser tool is not computer use', () => {
  const turn = { ...turnOf('fix the login form'), steps: [{ kind: 'verify', command: 'playwright test', failed: true }] };
  assert.equal(taskProfile({}, turn).affinity, 'neutral');
});

test('agentRole: Codex subagent headers and x-jev-role', async () => {
  const { agentRole } = await import('../src/model.js');
  assert.equal(agentRole({}), 'main');
  assert.equal(agentRole({ 'x-codex-parent-thread-id': 't1' }), 'worker');
  assert.equal(agentRole({ 'x-openai-subagent': 'compact' }), 'worker');
  assert.equal(agentRole({ 'x-jev-role': 'Main', 'x-openai-subagent': 'thread_spawn' }), 'main');
  assert.equal(agentRole({ 'x-jev-role': 'worker' }), 'worker');
  assert.equal(agentRole({ 'x-jev-role': 'boss' }), 'main');
});

test('loadConfig: JEV_AGENTS defaults to parallel and rejects unknown values', () => {
  assert.equal(loadConfig({}).agents, 'parallel');
  assert.equal(loadConfig({ JEV_AGENTS: 'Single' }).agents, 'single');
  assert.throws(() => loadConfig({ JEV_AGENTS: 'swarm' }), /JEV_AGENTS/);
});
