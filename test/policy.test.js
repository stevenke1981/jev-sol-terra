import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTurn, outputFailed, classifyCall } from '../src/trajectory.js';
import { assess, nextState, isNewTurn, HARD_TASK, LONG_PROMPT_CHARS } from '../src/policy.js';

const LADDER = ['low', 'medium', 'high'];
const user = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const env = user('<environment_context><cwd>/repo</cwd></environment_context>');
let id = 0;
function call(cmd, output) {
  const call_id = `c${++id}`;
  return [
    { type: 'function_call', name: 'shell', call_id, arguments: JSON.stringify({ command: ['bash', '-lc', cmd] }) },
    { type: 'function_call_output', call_id, output },
  ];
}
const ok = (cmd) => call(cmd, 'Exit code: 0\nWall time: 0.1 seconds\nOutput:\nfine');
const bad = (cmd) => call(cmd, 'Exit code: 1\nWall time: 0.1 seconds\nOutput:\nTraceback (most recent call last):');

test('ignores synthetic user messages and starts at the real request', () => {
  const turn = parseTurn([user('old task'), ...ok('ls'), user('find bugs'), env]);
  assert.equal(turn.userText, 'find bugs');
  assert.equal(turn.steps.length, 0);
});

test('exit code wins over failure-looking text', () => {
  assert.equal(outputFailed('Exit code: 0\nOutput:\nsrc/x.py: raise Error: nope'), false);
  assert.equal(outputFailed('{"output":"boom","metadata":{"exit_code":2}}'), true);
  assert.equal(outputFailed('Process exited with code 1'), true);
  assert.equal(outputFailed({ content: 'x', success: false }), true);
  assert.equal(outputFailed('3 failed, 10 passed'), true);
});

test('classifies wrapped shell commands', () => {
  const c = (cmd) => ({ type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', cmd] }) });
  assert.equal(classifyCall(c('rg --files | head -60')), 'read');
  assert.equal(classifyCall(c('npm run build')), 'verify');
  assert.equal(classifyCall(c("apply_patch <<'EOF'")), 'edit');
  assert.equal(classifyCall({ type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch' }), 'edit');
  assert.equal(classifyCall({ type: 'function_call', name: 'exec_command', arguments: '{"cmd":"git status --short"}' }), 'read');
});

test('greeting and plain first step stay low; hard tasks start medium', () => {
  assert.equal(assess(parseTurn([user('hi!')]), LADDER).target, 0);
  assert.equal(assess(parseTurn([user('inspect this repo and find bugs.')]), LADDER).target, 0);
  assert.equal(assess(parseTurn([user('why does this deadlock under load?')]), LADDER).target, 1);
});

test('escalates with consecutive failures and repeated failing calls', () => {
  assert.equal(assess(parseTurn([user('fix'), ...bad('pytest')]), LADDER).target, 1);
  assert.equal(assess(parseTurn([user('fix'), ...bad('pytest'), ...bad('pytest -x')]), LADDER).target, 2);
  const repeated = parseTurn([user('fix'), ...bad('make'), ...ok('ls'), ...bad('make'), ...ok('ls'), ...bad('make')]);
  assert.equal(assess(repeated, LADDER).target, 2);
});

test('many reads trigger synthesis at medium; single read is routine', () => {
  const reads = [user('find bugs'), ...ok('cat a.py'), ...ok('cat b.py'), ...ok('rg foo'), ...ok('sed -n 1,80p c.py')];
  assert.equal(assess(parseTurn(reads), LADDER).target, 1);
  assert.equal(assess(parseTurn([user('find bugs'), ...ok('git status')]), LADDER).target, 0);
});

test('a success after a failing loop releases the hold and steps down one rung', () => {
  const stuck = [user('fix'), ...bad('make'), ...bad('make'), ...bad('make')];
  const s1 = nextState(undefined, { target: 0, hold: 0, reasons: [] }, 1);
  const s2 = nextState(s1, assess(parseTurn(stuck), LADDER), 4);
  assert.equal(s2.level, 2);
  const recovered = assess(parseTurn([...stuck, ...ok('make')]), LADDER);
  const s3 = nextState(s2, recovered, 5);
  assert.deepEqual([s3.level, s3.from], [1, 2]);
});

test('review fixes: search no-match, images, "<" prompts, running processes, classification', () => {
  const rgMiss = (q) => call(`rg ${q}`, 'Process exited with code 1\nOutput:\n');
  const turn = parseTurn([user('find'), ...rgMiss('a'), ...rgMiss('b'), ...rgMiss('c')]);
  assert.deepEqual(turn.steps.map((s) => s.failed), [false, false, false]);
  assert.equal(assess(turn, LADDER).target, 0);

  const img = { type: 'message', role: 'user', content: [
    { type: 'input_image', image_url: `data:image/png;base64,${'A'.repeat(50000)}` },
    { type: 'input_text', text: 'fix' }] };
  assert.equal(parseTurn([img]).userText, 'fix');

  const t = parseTurn([user('old'), ...ok('ls'), user('<div> is misaligned'), env]);
  assert.equal(t.userText, '<div> is misaligned');
  assert.equal(t.steps.length, 0);

  assert.equal(outputFailed('Process running with session ID 7\nOutput:\nretry failed requests'), null);
  assert.equal(outputFailed('Success. Updated the following files:\nM src/failed.ts'), false);
  assert.equal(outputFailed('rg: no', 'diff a b'), false);
  // Codex sandbox rejections carry no exit code.
  assert.equal(outputFailed('exec_command failed: CreateProcess { message: "Rejected(\\"`pwsh -Command ls` rejected: blocked by policy\\")" }'), true);
  assert.equal(outputFailed('bash: ./run.sh: Permission denied'), true);

  const c = (cmd) => ({ type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', cmd] }) });
  assert.equal(classifyCall(c('cat tests/foo.py')), 'read');
  assert.equal(classifyCall(c('rg apply_patch src')), 'read');
  assert.equal(classifyCall(c('cd repo && rg foo')), 'read');
  assert.equal(classifyCall(c('.venv/bin/python -m pytest -q')), 'verify');
});

test('top rung follows the configured ladder', () => {
  const turn = parseTurn([user('fix'), ...bad('a'), ...bad('b'), ...bad('c')]);
  assert.equal(assess(turn, ['low', 'medium', 'high', 'xhigh']).target, 3);
});

test('hysteresis: holds after escalation, then decays one rung at a time', () => {
  let s = nextState(undefined, { target: 0, hold: 0, reasons: [] }, 1);
  s = nextState(s, { target: 2, hold: 2, reasons: [] }, 2);
  assert.deepEqual([s.level, s.hold, s.from], [2, 2, 0]);
  s = nextState(s, { target: 0, hold: 0, reasons: [] }, 3);
  assert.deepEqual([s.level, s.hold], [2, 1]);
  s = nextState(s, { target: 0, hold: 0, reasons: [] }, 4);
  assert.deepEqual([s.level, s.hold], [2, 0]);
  s = nextState(s, { target: 0, hold: 0, reasons: [] }, 5);
  assert.equal(s.level, 1);
  s = nextState(s, { target: 0, hold: 0, reasons: [] }, 6);
  assert.equal(s.level, 0);
});

test('a new turn resets state instead of decaying', () => {
  const high = { level: 2, hold: 2, step: 9 };
  assert.equal(nextState(high, { target: 0, hold: 0, reasons: [] }, 1).level, 0);
});

test('isNewTurn: first generation, step restart, or no state; continuing steps are one turn', () => {
  assert.equal(isNewTurn(undefined, 5), true);
  assert.equal(isNewTurn({ step: 4 }, 1), true);
  assert.equal(isNewTurn({ step: 4 }, 3), true);
  assert.equal(isNewTurn({ step: 4 }, 4), false);
  assert.equal(isNewTurn({ step: 4 }, 5), false);
});

test('model-routing constants are shared with the policy', () => {
  assert.ok(HARD_TASK.test('why does this race?'));
  assert.equal(LONG_PROMPT_CHARS, 600);
});

test('a deep question starts at the middle rung like a hard task', () => {
  const a = assess({ userText: 'How does the scheduler pick the next task?', steps: [] }, ['low', 'medium', 'high', 'xhigh']);
  assert.equal(a.target, 1);
});
