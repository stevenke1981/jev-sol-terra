import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildState, buildQuestions, toAssessment, jevDecide } from '../src/decisions.js';
import { createRouter } from '../src/router.js';
import { loadConfig } from '../src/config.js';

const LADDER = ['low', 'medium', 'high'];
const turn = {
  userText: 'find bugs',
  steps: [
    { kind: 'read', command: 'rg foo', failed: false },
    { kind: 'verify', command: 'pytest', failed: true },
    { kind: 'verify', command: 'pytest', failed: true },
  ],
};
const answers = (score, stuck, confidence = 0.9, strong = 0.2) => ({
  effort: { type: 'score', score, confidence, probabilities: {}, legend: {} },
  stuck: { type: 'noul', noul: stuck },
  strong: { type: 'noul', noul: strong },
});

test('state summarizes the trajectory; questions follow the ladder', () => {
  const s = buildState(turn, 'medium');
  assert.equal(s.next_generation, 4);
  assert.deepEqual(s.totals, { tool_calls: 3, failures: 2, consecutive_failures: 2, edits: 0 });
  assert.equal(s.recent_steps[2].status, 'failed');
  const q = buildQuestions(LADDER);
  assert.equal(q.effort.type, 'score');
  assert.equal(q.effort.criteria.length, 3);
  assert.match(q.effort.criteria[0], /^low:/);
  assert.deepEqual(Object.keys(q.stuck.criteria), ['true', 'false']);
  assert.deepEqual(Object.keys(q.strong.criteria), ['true', 'false']);
  assert.match(q.strong.instructions, /NEXT generation.*strongest, most expensive coding model\?$/);
});

test('strong question: its probability is returned; a missing answer is null', () => {
  assert.equal(toAssessment(answers(1, 0.1, 0.9, 0.85), LADDER, 0.3).strong, 0.85);
  assert.equal(toAssessment(answers(1, 0.1, 0.9, 0), LADDER, 0.3).strong, 0);
  const { strong: _omitted, ...withoutStrong } = answers(1, 0.1);
  assert.equal(toAssessment(withoutStrong, LADDER, 0.3).strong, null);
  assert.equal(toAssessment({ ...answers(1, 0.1), strong: { type: 'noul', noul: 'high' } }, LADDER, 0.3).strong, null);
});

test('answers map to rung, hold and release', () => {
  assert.deepEqual(
    [toAssessment(answers(1.8, 0.9), LADDER, 0.3)].map((a) => [a.target, a.hold, a.release])[0], [2, 2, false]);
  assert.deepEqual(
    [toAssessment(answers(0.2, 0.1), LADDER, 0.3)].map((a) => [a.target, a.hold, a.release])[0], [0, 0, true]);
  assert.equal(toAssessment(answers(9, 0.6), LADDER, 0.3).target, 2);
  assert.throws(() => toAssessment(answers(1, 0.5, 0.1), LADDER, 0.3), /confidence/);
  assert.throws(() => toAssessment({ effort: { type: 'choice' } }, LADDER, 0.3), /unexpected/);
});

function decisionsServer(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
      handler(res);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, seen, url: `http://127.0.0.1:${server.address().port}/api/alpha/decisions` })));
}

test('jevDecide posts a Decisions request and returns cost', async () => {
  const { server, seen, url } = await decisionsServer((res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'gen-dec-1', model: 'typesafe/jev-1.14-20261014', answers: answers(1.1, 0.6), usage: { input_tokens: 400, output_tokens: 0, cost: 0.0000168 } }));
  });
  try {
    const d = await jevDecide(turn, { url, apiKey: 'or-test', model: 'typesafe/jev-1.14', timeoutMs: 2000, ladder: LADDER, minConfidence: 0.3, sessionId: 's1' });
    assert.deepEqual([d.target, d.hold, d.cost, d.strong], [1, 1, 0.0000168, 0.2]);
    assert.equal(seen[0].headers.authorization, 'Bearer or-test');
    assert.equal(seen[0].body.model, 'typesafe/jev-1.14');
    assert.equal(seen[0].body.session_id, 's1');
    assert.deepEqual(Object.keys(seen[0].body.questions), ['effort', 'stuck', 'strong']);
  } finally {
    server.close();
  }
});

test('router falls back to heuristic when Jev errors', async () => {
  const { server, url } = await decisionsServer((res) => {
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 402, message: 'Insufficient credits' } }));
  });
  try {
    const config = loadConfig({ OPENROUTER_API_KEY: 'or-test', JEV_DECISION_URL: url });
    assert.equal(config.mode, 'jev');
    const router = createRouter(config);
    const body = { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] };
    const d = await router.route(body, 's', null);
    assert.equal(d.effort, 'low');
    assert.match(d.source, /jev failed: Jev HTTP 402: Insufficient credits/);
  } finally {
    server.close();
  }
});

test('config: jev is default only with a key, and explicit jev requires one', () => {
  assert.equal(loadConfig({}).mode, 'heuristic');
  assert.throws(() => loadConfig({ JEV_MODE: 'jev' }), /OPENROUTER_API_KEY/);
  assert.throws(() => loadConfig({ OPENROUTER_API_KEY: 'k', JEV_MIN_CONFIDENCE: '2' }), /JEV_MIN_CONFIDENCE/);
});
