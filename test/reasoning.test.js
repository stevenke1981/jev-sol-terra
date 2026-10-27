import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReasoningTracker } from '../src/reasoning.js';

const reasoning = (id) => ({ type: 'reasoning', id, encrypted_content: `enc-${id}` });
const message = (id) => ({ type: 'message', id, role: 'assistant', content: [] });
const done = (item) => ({ type: 'response.output_item.done', item });

test('streamed reasoning items are remembered under the model that sent the request', () => {
  const t = createReasoningTracker();
  t.observe({ type: 'response.created', response: { id: 'r1' } }, 'gpt-6.1-terra');
  t.observe(done(reasoning('rs_t1')), 'gpt-6.1-terra');
  t.observe(done(message('msg_1')), 'gpt-6.1-terra');

  const input = [reasoning('rs_t1'), message('msg_1')];
  assert.deepEqual(t.strip(input, 'gpt-6.1-sol'), [message('msg_1')]);
  assert.deepEqual(t.strip(input, 'gpt-6.1-terra'), input);
});

test('a plain JSON response contributes its output reasoning items', () => {
  const t = createReasoningTracker();
  t.observe({ id: 'r2', output: [reasoning('rs_s1'), message('msg_2')] }, 'gpt-6.1-sol');
  assert.deepEqual(t.strip([reasoning('rs_s1')], 'gpt-6.1-terra'), []);
  assert.deepEqual(t.strip([reasoning('rs_s1')], 'gpt-6.1-sol'), [reasoning('rs_s1')]);
});

test('unknown reasoning ids, items without ids and non-reasoning items are kept', () => {
  const t = createReasoningTracker();
  t.observe(done(reasoning('rs_t1')), 'gpt-6.1-terra');
  const input = [reasoning('rs_never_seen'), { type: 'reasoning' }, message('rs_t1'), { type: 'function_call', call_id: 'c1' }];
  assert.deepEqual(t.strip(input, 'gpt-6.1-sol'), input);
});

test('events that carry no reasoning item record nothing', () => {
  const t = createReasoningTracker();
  t.observe(done(message('msg_3')), 'gpt-6.1-terra');
  t.observe({ type: 'response.completed', response: { output: [message('msg_4')], usage: { output_tokens: 3 } } }, 'gpt-6.1-terra');
  t.observe(null, 'gpt-6.1-terra');
  t.observe(done(undefined), 'gpt-6.1-terra');
  assert.deepEqual(t.strip([reasoning('rs_missing')], 'gpt-6.1-sol'), [reasoning('rs_missing')]);
});

test('strip returns a new array and leaves the input untouched', () => {
  const t = createReasoningTracker();
  t.record('rs_t1', 'gpt-6.1-terra');
  const input = [reasoning('rs_t1'), message('msg_1')];
  const snapshot = structuredClone(input);
  const out = t.strip(input, 'gpt-6.1-sol');
  assert.notEqual(out, input);
  assert.deepEqual(input, snapshot);
  assert.equal(out.length, 1);
});

test('strip passes non-array input through unchanged', () => {
  const t = createReasoningTracker();
  assert.equal(t.strip('plain text', 'gpt-6.1-sol'), 'plain text');
  assert.equal(t.strip(undefined, 'gpt-6.1-sol'), undefined);
});

test('the same id recorded again belongs to the latest model', () => {
  const t = createReasoningTracker();
  t.record('rs_x', 'gpt-6.1-terra');
  t.record('rs_x', 'gpt-6.1-sol');
  assert.deepEqual(t.strip([reasoning('rs_x')], 'gpt-6.1-sol'), [reasoning('rs_x')]);
  assert.deepEqual(t.strip([reasoning('rs_x')], 'gpt-6.1-terra'), []);
});

test('the tracker forgets the oldest ids beyond its limit, which then count as unknown', () => {
  const t = createReasoningTracker(2);
  t.record('rs_1', 'gpt-6.1-terra');
  t.record('rs_2', 'gpt-6.1-terra');
  t.record('rs_3', 'gpt-6.1-terra');
  const input = [reasoning('rs_1'), reasoning('rs_2'), reasoning('rs_3')];
  // rs_1 was forgotten, so it is unknown and kept; rs_2 and rs_3 are still terra's and go.
  assert.deepEqual(t.strip(input, 'gpt-6.1-sol'), [reasoning('rs_1')]);
});

test('record ignores a missing id or model', () => {
  const t = createReasoningTracker();
  t.record(undefined, 'gpt-6.1-terra');
  t.record('rs_y', '');
  t.record('rs_y', undefined);
  assert.deepEqual(t.strip([reasoning('rs_y')], 'gpt-6.1-sol'), [reasoning('rs_y')]);
});
