import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadConfig } from '../src/config.js';
import { createProxy, isOpenRouter } from '../src/proxy.js';
import { modelId } from '../src/model.js';
import { formatDecision } from '../src/log.js';
import { APP } from '../src/version.js';

const TERRA = 'gpt-6.1-terra';
const SOL = 'gpt-6.1-sol';
const ids = { [TERRA]: 'rs_terra_1', [SOL]: 'rs_sol_1' };

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** A Responses stream that emits one reasoning item with the given id, as the upstream does. */
function reasoningReply(id) {
  return (body, res) => {
    const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(event('response.output_item.done', { item: { type: 'reasoning', id, encrypted_content: 'enc' } }));
    res.end(event('response.completed', { response: { id: 'r', usage: { output_tokens: 4, output_tokens_details: { reasoning_tokens: 2 } } } }));
  };
}

/** Each upstream model answers with its own reasoning item id, so ownership is visible in the next request. */
const perModelReply = (body, res) => reasoningReply(ids[body?.model] ?? 'rs_other')(body, res);

async function harness({ env = {}, deps = {}, reply = perModelReply } = {}) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString();
      seen.push({ url: req.url, body: text ? JSON.parse(text) : null });
      reply(seen.at(-1).body, res);
    });
  });
  const upPort = await listen(upstream);
  const logged = [];
  const printed = [];
  // Task-based routing is tested in single-agent mode; parallel mode has its own tests.
  const config = loadConfig({ JEV_UPSTREAM: `http://127.0.0.1:${upPort}/base`, JEV_HOME: '.jev-test', JEV_AGENTS: 'single', ...env });
  const { server, stats } = createProxy(config, {
    log: { write: (r) => logged.push(r) }, print: (s) => printed.push(s), ...deps,
  });
  const port = await listen(server);
  const post = (path, body, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  }).then((r) => r.text());
  const close = () => {
    server.close();
    server.closeAllConnections();
    upstream.close();
    upstream.closeAllConnections();
  };
  return { port, seen, logged, printed, stats, post, close, config };
}

const user = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const assistant = (text) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const reasoningItem = (id) => ({ type: 'reasoning', id, encrypted_content: `enc-${id}` });
const responses = (model, input, extra = {}) => ({
  model, instructions: 'SYSTEM', input, reasoning: { effort: 'high', summary: 'auto' }, stream: true, ...extra,
});
const SIMPLE = 'hi!';
const HARD = 'design a cache that is race free';

test('jev-auto on Responses sends terra for a simple task and sol for a hard one', async () => {
  const h = await harness();
  try {
    await h.post('/v1/responses', responses('jev-auto', [user(SIMPLE)], { prompt_cache_key: 'simple' }));
    await h.post('/v1/responses', responses('jev-auto', [user(HARD)], { prompt_cache_key: 'hard' }));

    assert.equal(h.seen[0].body.model, TERRA);
    assert.equal(h.seen[0].body.reasoning.effort, 'low');
    assert.equal(h.seen[1].body.model, SOL);
    assert.equal(h.seen[1].body.reasoning.effort, 'medium');
    assert.match(stripAnsi(h.printed[0]), /^Jev {2}TERRA·LOW {2}✓ APPLIED/);
    assert.match(stripAnsi(h.printed[1]), /^Jev {2}SOL·MEDIUM {2}✓ APPLIED/);
  } finally {
    h.close();
  }
});

test('jev-auto on Chat Completions routes the model as well', async () => {
  const h = await harness();
  try {
    const chat = (text, key) => ({
      model: 'jev-auto', stream: true, reasoning_effort: 'high', messages: [{ role: 'user', content: text }], user: key,
    });
    await h.post('/v1/chat/completions', chat(SIMPLE, 'c-simple'));
    await h.post('/v1/chat/completions', chat(HARD, 'c-hard'));
    assert.equal(h.seen[0].url, '/base/chat/completions');
    assert.equal(h.seen[0].body.model, TERRA);
    assert.equal(h.seen[1].body.model, SOL);
    assert.equal(h.logged[1].api, 'chat');
    assert.equal(h.logged[1].model, SOL);
  } finally {
    h.close();
  }
});

test('with JEV_MODE=off jev-auto still becomes terra and the effort is left untouched', async () => {
  const h = await harness({ env: { JEV_MODE: 'off' } });
  try {
    await h.post('/v1/responses', responses('jev-auto', [user(SIMPLE)], { prompt_cache_key: 'off-simple' }));
    await h.post('/v1/responses', responses('jev-auto', [user(HARD)], { prompt_cache_key: 'off-hard' }));

    assert.equal(h.seen[0].body.model, TERRA);
    assert.deepEqual(h.seen[0].body.reasoning, { effort: 'high', summary: 'auto' });
    // Off mode never takes the hard-task path: it stays on terra with the client's effort.
    assert.equal(h.seen[1].body.model, TERRA);
    assert.equal(h.seen[1].body.reasoning.effort, 'high');
    assert.equal(h.logged[0].effort, null);
    assert.equal(h.logged[0].modelKey, 'terra');
    assert.equal(h.stats.byModel[TERRA], 2);
    assert.deepEqual(h.stats.byEffort, {});
    assert.match(stripAnsi(h.printed[0]), /^Jev {2}TERRA {2}✓ APPLIED/);
  } finally {
    h.close();
  }
});

test('JEV_MODEL pins the model for jev-auto whatever the task', async () => {
  const sol = await harness({ env: { JEV_MODEL: 'sol' } });
  const terra = await harness({ env: { JEV_MODEL: 'terra' } });
  try {
    await sol.post('/v1/responses', responses('jev-auto', [user(SIMPLE)], { prompt_cache_key: 'p' }));
    await terra.post('/v1/responses', responses('jev-auto', [user(HARD)], { prompt_cache_key: 'p' }));
    assert.equal(sol.seen[0].body.model, SOL);
    assert.equal(terra.seen[0].body.model, TERRA);
    assert.equal(terra.seen[0].body.reasoning.effort, 'medium', 'effort still follows the ladder');
  } finally {
    sol.close();
    terra.close();
  }
});

test('an unrelated model is not rewritten, but its effort still is', async () => {
  const h = await harness();
  try {
    await h.post('/v1/responses', responses('gpt-x', [user(HARD)], { prompt_cache_key: 'x' }));
    assert.equal(h.seen[0].body.model, 'gpt-x');
    assert.equal(h.seen[0].body.reasoning.effort, 'medium');
    assert.equal(h.logged[0].model, 'gpt-x');
    assert.equal(h.logged[0].requested, 'gpt-x');
    assert.equal(h.logged[0].modelKey, null);
    assert.equal(h.stats.byModel['gpt-x'], 1);
  } finally {
    h.close();
  }
});

test('reasoning items from terra are stripped for sol and kept while the turn stays on terra', async () => {
  const h = await harness();
  try {
    // Turn 1 on terra; the upstream streams reasoning item rs_terra_1.
    await h.post('/v1/responses', responses('jev-auto', [user(SIMPLE)], { prompt_cache_key: 'strip' }));
    // Turn 2 is hard, so it goes to sol. The unknown id from the client must survive.
    await h.post('/v1/responses', responses('jev-auto', [
      user(SIMPLE), reasoningItem('rs_terra_1'), assistant('done'), reasoningItem('rs_client_old'), user(HARD),
    ], { prompt_cache_key: 'strip' }));
    // Turn 3 is a writing task: sol drops back to terra within the size limit.
    await h.post('/v1/responses', responses('jev-auto', [
      user(HARD), reasoningItem('rs_terra_1'), reasoningItem('rs_sol_1'), assistant('ok'), user('translate this line into French'),
    ], { prompt_cache_key: 'strip' }));

    assert.equal(h.seen[1].body.model, SOL);
    assert.deepEqual(h.seen[1].body.input.map((i) => i.id ?? i.type), ['message', 'message', 'rs_client_old', 'message']);
    assert.equal(h.seen[2].body.model, TERRA);
    assert.deepEqual(h.seen[2].body.input.map((i) => i.id ?? i.type), ['message', 'rs_terra_1', 'message', 'message']);
  } finally {
    h.close();
  }
});

test('reasoning items stay put when the next request also goes to terra', async () => {
  const h = await harness();
  try {
    await h.post('/v1/responses', responses('jev-auto', [user(SIMPLE)], { prompt_cache_key: 'keep' }));
    await h.post('/v1/responses', responses('jev-auto', [
      user(SIMPLE), reasoningItem('rs_terra_1'), assistant('done'), user('translate this line into French'),
    ], { prompt_cache_key: 'keep' }));
    assert.equal(h.seen[1].body.model, TERRA);
    assert.deepEqual(h.seen[1].body.input.map((i) => i.id ?? i.type), ['message', 'rs_terra_1', 'message', 'message']);
  } finally {
    h.close();
  }
});

test('an effort-only request does not strip reasoning items', async () => {
  const h = await harness();
  try {
    // rs_sol_1 is recorded as sol's, but gpt-x is not a routed model, so nothing is dropped.
    await h.post('/v1/responses', responses('jev-auto', [user(HARD)], { prompt_cache_key: 'eff' }));
    const input = [user(HARD), reasoningItem('rs_sol_1')];
    await h.post('/v1/responses', responses('gpt-x', input, { prompt_cache_key: 'eff' }));
    assert.equal(h.seen[0].body.model, SOL);
    assert.deepEqual(h.seen[1].body.input, input);
  } finally {
    h.close();
  }
});

test('the log record names the upstream model and the one the client asked for', async () => {
  const h = await harness();
  try {
    await h.post('/v1/responses', responses('jev-auto', [user(HARD)], { prompt_cache_key: 'log' }));
    const [record] = h.logged;
    assert.equal(record.model, SOL);
    assert.equal(record.requested, 'jev-auto');
    assert.equal(record.modelKey, 'sol');
    assert.equal(record.effort, 'medium');
    assert.equal(record.status, 200);
    assert.equal(record.usage.output_tokens, 4);
    assert.equal(h.stats.reasoningTokens.medium, 2);
  } finally {
    h.close();
  }
});

test('stats count generations by the model that served them, and health names the app', async () => {
  const h = await harness();
  try {
    await h.post('/v1/responses', responses('jev-auto', [user(SIMPLE)], { prompt_cache_key: 's1' }));
    await h.post('/v1/responses', responses('jev-auto', [user(HARD)], { prompt_cache_key: 's2' }));
    await h.post('/v1/responses', responses('jev-auto', [user(SIMPLE)], { prompt_cache_key: 's3' }));
    await h.post('/v1/responses', responses('gpt-x', [user(SIMPLE)], { prompt_cache_key: 's4' }));

    assert.deepEqual(h.stats.byModel, { [TERRA]: 2, [SOL]: 1, 'gpt-x': 1 });
    assert.equal(h.stats.routed, 4);

    const health = await (await fetch(`http://127.0.0.1:${h.port}/jev/health`)).json();
    assert.equal(health.app, 'jev-sol-terra');
    assert.equal(health.app, APP);
    assert.deepEqual(health.stats.byModel, { [TERRA]: 2, [SOL]: 1, 'gpt-x': 1 });
  } finally {
    h.close();
  }
});

test('OpenRouter ids carry the openai/ prefix', () => {
  const config = loadConfig({});
  assert.equal(modelId('terra', config, true), 'openai/gpt-6.1-terra');
  assert.equal(modelId('sol', config, true), 'openai/gpt-6.1-sol');
  assert.equal(modelId('sol', config, false), SOL);
  const custom = loadConfig({ JEV_SOL_MODEL: 'vendor/custom-sol' });
  assert.equal(modelId('sol', custom, true), 'vendor/custom-sol', 'an id that already has a slash is kept');
  assert.equal(isOpenRouter('https://openrouter.ai/api/v1'), true);
  assert.equal(isOpenRouter('https://api.openai.com/v1'), false);
});

test('the proxy sends the openai/ id when the upstream is OpenRouter', async () => {
  const h = await harness({ deps: { isOpenRouter: () => true } });
  try {
    await h.post('/v1/responses', responses('jev-auto', [user(SIMPLE)], { prompt_cache_key: 'or' }));
    await h.post('/v1/responses', responses('jev-auto', [user(HARD)], { prompt_cache_key: 'or2' }));
    assert.equal(h.seen[0].body.model, `openai/${TERRA}`);
    assert.equal(h.seen[1].body.model, `openai/${SOL}`);
    assert.equal(h.logged[1].model, `openai/${SOL}`, 'the log keeps the id as sent');
  } finally {
    h.close();
  }
});

test('formatDecision shows the model and effort change when a model was routed', () => {
  const line = formatDecision({
    model: 'sol', fromModel: 'terra', effort: 'xhigh', from: 'low', step: 4, hold: 2, ms: 3,
    reasons: ['mid-turn: x'], modelReasons: ['mid-turn: strong 0.70, escalate to sol'],
  });
  assert.equal(stripAnsi(line), 'Jev  TERRA·LOW → SOL·XHIGH  ✓ APPLIED\n'
    + '     Step 4 · next 2 generation(s) · 3 ms · mid-turn: x; mid-turn: strong 0.70, escalate to sol');
});

test('formatDecision omits the arrow when nothing changed and the model is new', () => {
  const first = formatDecision({ model: 'terra', fromModel: null, effort: 'low', from: null, step: 1, hold: 0, ms: 1, reasons: ['new turn'], modelReasons: [] });
  assert.equal(stripAnsi(first).split('\n')[0], 'Jev  TERRA·LOW  ✓ APPLIED');
  const same = formatDecision({ model: 'sol', fromModel: null, effort: 'high', from: 'high', step: 2, hold: 0, ms: 1, reasons: [], modelReasons: [] });
  assert.equal(stripAnsi(same).split('\n')[0], 'Jev  SOL·HIGH  ✓ APPLIED');
});

test('formatDecision shows only the model when the effort was left alone', () => {
  const line = formatDecision({ model: 'terra', fromModel: 'sol', effort: null, from: null, step: 0, hold: 0, ms: 0, reasons: [], modelReasons: ['mode off: terra'] });
  assert.equal(stripAnsi(line), 'Jev  SOL → TERRA  ✓ APPLIED\n     Step 0 · 0 ms · mode off: terra');
});

test('formatDecision reads a log record by its modelKey and keeps the unchanged form for effort-only rows', () => {
  const routed = formatDecision({
    model: 'openai/gpt-6.1-sol', modelKey: 'sol', fromModel: null, requested: 'jev-auto',
    effort: 'high', from: 'high', step: 5, hold: 0, ms: 2, reasons: [], modelReasons: [],
  });
  assert.equal(stripAnsi(routed).split('\n')[0], 'Jev  SOL·HIGH  ✓ APPLIED');

  const effortOnly = formatDecision({ model: 'gpt-x', modelKey: null, effort: 'high', from: 'low', step: 2, hold: 1, ms: 5, reasons: ['routine read'] });
  assert.equal(stripAnsi(effortOnly), 'Jev  LOW → HIGH  ✓ APPLIED\n     Step 2 · next 1 generation(s) · 5 ms · routine read');
});

test('formatDecision keeps the unchanged form for rows written before model routing', () => {
  const legacy = formatDecision({ model: 'gpt-5.5', effort: 'medium', from: 'medium', step: 3, hold: 0, ms: 4, reasons: ['routine edit'] });
  assert.equal(stripAnsi(legacy), 'Jev  MEDIUM  ✓ APPLIED\n     Step 3 · next 1 generation(s) · 4 ms · routine edit');
});

test('jev-auto without a reasoning field gets the model but no reasoning is added', async () => {
  const h = await harness();
  try {
    const body = { model: 'jev-auto', input: [user(SIMPLE)], stream: true, prompt_cache_key: 'bare' };
    await h.post('/v1/responses', body);
    assert.equal(h.seen[0].body.model, TERRA);
    assert.equal('reasoning' in h.seen[0].body, false);
    assert.deepEqual({ ...h.seen[0].body, model: 'jev-auto' }, body, 'everything else must be byte-identical');
  } finally {
    h.close();
  }
});

test('the downgrade guard measures the decoded body, not the compressed one', async () => {
  const { gzipSync } = await import('node:zlib');
  const h = await harness();
  try {
    const key = { prompt_cache_key: 'big' };
    await h.post('/v1/responses', responses('jev-auto', [user(HARD)], key));
    // A large history compresses to well under the 64 KB limit.
    const history = Array.from({ length: 2000 }, (_, i) => assistant(`step ${i} `.repeat(20)));
    const big = responses('jev-auto', [user(HARD), ...history, user('list the files')], key);
    const gz = gzipSync(JSON.stringify(big));
    assert.ok(gz.length < h.config.downgradeMaxBytes);
    await fetch(`http://127.0.0.1:${h.port}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: gz,
    }).then((r) => r.text());
    assert.equal(h.seen[1].body.model, SOL);
    assert.match(h.logged[1].modelReasons[0], /over downgrade limit/);
  } finally {
    h.close();
  }
});

test('llm mode judges an aliased request on terra, not on the alias', async () => {
  const judged = [];
  const judgeFn = async (turn, opts) => {
    judged.push(opts.model);
    return { target: 0, hold: 0, reasons: ['judge: ok'] };
  };
  const h = await harness({ env: { JEV_MODE: 'llm' }, deps: { judgeFn } });
  try {
    const first = [user(SIMPLE)];
    const call = { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"cmd":"ls"}' };
    const out = { type: 'function_call_output', call_id: 'c1', output: 'Exit code: 0\na.txt' };
    await h.post('/v1/responses', responses('jev-auto', [...first, call, out], { prompt_cache_key: 'j' }));
    await h.post('/v1/responses', responses('gpt-x', [...first, call, out], { prompt_cache_key: 'k' }));
    assert.deepEqual(judged, [TERRA, 'gpt-x']);
  } finally {
    h.close();
  }
});

// ---- parallel agents --------------------------------------------------------

const PARALLEL = { JEV_AGENTS: 'parallel' };
const SUBAGENT = { 'x-codex-parent-thread-id': 'thread-main', 'x-openai-subagent': 'thread_spawn' };
const fail = (id, cmd) => [
  { type: 'function_call', call_id: id, name: 'shell', arguments: JSON.stringify({ cmd }) },
  { type: 'function_call_output', call_id: id, output: 'Exit code: 1\nAssertionError: boom' },
];

test('parallel: the main agent runs on sol and a subagent on terra, both from low', async () => {
  const h = await harness({ env: PARALLEL });
  try {
    // A hard task would start at medium in single mode; parallel agents start low.
    await h.post('/v1/responses', responses('jev-auto', [user(HARD)], { prompt_cache_key: 'main' }));
    await h.post('/v1/responses', responses('jev-auto', [user(HARD)], { prompt_cache_key: 'sub' }), SUBAGENT);
    await h.post('/v1/responses', responses('jev-auto', [user(SIMPLE)], { prompt_cache_key: 'main2' }));

    assert.deepEqual(h.seen.map((s) => [s.body.model, s.body.reasoning.effort]), [[SOL, 'low'], [TERRA, 'low'], [SOL, 'low']]);
    assert.deepEqual(h.logged.map((r) => r.role), ['main', 'worker', 'main']);
    assert.match(h.logged[1].modelReasons.join(), /subagent on terra/);
  } finally {
    h.close();
  }
});

test('parallel: a stuck subagent climbs the effort ladder and then moves to sol', async () => {
  const h = await harness({ env: PARALLEL });
  try {
    const turn = [user('add a --verbose flag to the CLI')];
    const sent = [];
    for (let i = 0; i <= 3; i++) {
      await h.post('/v1/responses', responses('jev-auto', turn, { prompt_cache_key: 'sub-stuck' }), SUBAGENT);
      sent.push(`${h.seen.at(-1).body.model === SOL ? 'sol' : 'terra'}/${h.seen.at(-1).body.reasoning.effort}`);
      turn.push(...fail(`c${i}`, 'npm test'));
    }
    assert.equal(sent[0], 'terra/low');
    assert.equal(sent.at(-1), 'sol/xhigh');
  } finally {
    h.close();
  }
});

test('parallel: x-jev-role marks agents for other clients', async () => {
  const h = await harness({ env: PARALLEL });
  try {
    await h.post('/v1/chat/completions', { model: 'jev-auto', user: 'oc-sub', messages: [{ role: 'user', content: HARD }] }, { 'x-jev-role': 'worker' });
    assert.equal(h.seen[0].body.model, TERRA);
    assert.equal(h.logged[0].role, 'worker');
  } finally {
    h.close();
  }
});

test('parallel: JEV_MODEL pins over the roles and JEV_AGENTS=single ignores them', async () => {
  const pinned = await harness({ env: { ...PARALLEL, JEV_MODEL: 'terra' } });
  const single = await harness({ env: { JEV_AGENTS: 'single' } });
  try {
    await pinned.post('/v1/responses', responses('jev-auto', [user(HARD)], { prompt_cache_key: 'p' }));
    await single.post('/v1/responses', responses('jev-auto', [user(HARD)], { prompt_cache_key: 's' }), SUBAGENT);
    assert.equal(pinned.seen[0].body.model, TERRA);
    assert.equal(single.seen[0].body.model, SOL);
    assert.equal(single.logged[0].role, undefined);
  } finally {
    pinned.close();
    single.close();
  }
});
