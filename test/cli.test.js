import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/jev.js', import.meta.url));
const RUN_TIMEOUT_MS = 15000;

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function run(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env, timeout: RUN_TIMEOUT_MS }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, out: stdout + stderr });
    });
  });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jev-sol-terra-test-'));
}

/** Answers /jev/health with the given payload on a free port, as another app would. */
async function fakeHealthServer(payload) {
  const port = await freePort();
  const server = http.createServer((req, res) => {
    const health = req.url === '/jev/health';
    res.writeHead(health ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(health ? payload : {}));
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return {
    port,
    close: () => new Promise((r) => {
      server.close(r);
      server.closeAllConnections();
    }),
  };
}

/** A real process the CLI must never signal. */
function bystander() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
}

test('jev-sol-terra stop stops a running proxy and is a no-op when none runs', async () => {
  const port = await freePort();
  const env = { ...process.env, JEV_PORT: String(port), JEV_HOME: '.jev-test', JEV_MODE: 'heuristic', JEV_QUIET: '1' };
  const child = spawn(process.execPath, [CLI, 'serve'], { env, stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', r));
  try {
    for (let i = 0; i < 50 && (await run(['status'], env)).code !== 0; i++) await new Promise((r) => setTimeout(r, 100));

    const stopped = await run(['stop'], env);
    assert.equal(stopped.code, 0, stopped.out);
    assert.match(stopped.out, new RegExp(`stopped jev-sol-terra proxy \\(pid ${child.pid},`));
    await exited;

    const again = await run(['stop'], env);
    assert.equal(again.code, 0);
    assert.match(again.out, /no jev-sol-terra proxy/);
  } finally {
    child.kill();
  }
});

test('stop and status never signal or reuse a server that does not name jev-sol-terra', async () => {
  const victim = bystander();
  const home = tempDir();
  const fake = await fakeHealthServer({ app: 'some-other-app', version: '9.9.9', build: 'x', pid: victim.pid });
  const anon = await fakeHealthServer({ version: '9.9.9', build: 'x', pid: victim.pid });
  const env = { ...process.env, JEV_PORT: String(fake.port), JEV_HOME: home, JEV_QUIET: '1' };
  try {
    const stopped = await run(['stop'], env);
    assert.equal(stopped.code, 1, stopped.out);
    assert.match(stopped.out, /port \d+ is answered by app "some-other-app", not a jev-sol-terra proxy/);
    assert.match(stopped.out, /not stopping it/);

    const status = await run(['status'], env);
    assert.equal(status.code, 1);
    assert.match(status.out, /not a jev-sol-terra proxy/);

    // A server whose health has no app field at all is foreign too.
    const anonStop = await run(['stop'], { ...env, JEV_PORT: String(anon.port) });
    assert.equal(anonStop.code, 1);
    assert.match(anonStop.out, /no app id/);

    // Codex must not be pointed at a foreign server: ensureProxy refuses before any codex lookup.
    // PATH and APPDATA are emptied so that, if the guard regressed, codex still could not start.
    const codex = await run(['codex'], { ...env, PATH: '', Path: '', APPDATA: home });
    assert.equal(codex.code, 1);
    assert.match(codex.out, /not a jev-sol-terra proxy/);

    assert.equal(victim.exitCode, null, 'bystander exited, so the CLI signalled it');
    assert.equal(victim.signalCode, null, 'bystander was signalled');
  } finally {
    victim.kill();
    await fake.close();
    await anon.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('serve names the other app when its port is taken and does not reuse it', async () => {
  const fake = await fakeHealthServer({ app: 'other-app' });
  const home = tempDir();
  try {
    const served = await run(['serve'], { ...process.env, JEV_PORT: String(fake.port), JEV_HOME: home, JEV_QUIET: '1' });
    assert.equal(served.code, 1, served.out);
    assert.match(served.out, /EADDRINUSE/);
    assert.match(served.out, /answered by app "other-app", not a jev-sol-terra proxy/);
  } finally {
    await fake.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('install writes the jevst Codex profile for the configured Sol id and refuses foreign files', async () => {
  const codexHome = tempDir();
  const env = { ...process.env, CODEX_HOME: codexHome, JEV_PORT: '9999', JEV_SOL_MODEL: 'gpt-6.1-sol', JEV_HOME: codexHome };
  const file = path.join(codexHome, 'jevst.config.toml');
  try {
    const first = await run(['install'], env);
    assert.equal(first.code, 0, first.out);
    const toml = fs.readFileSync(file, 'utf8');
    assert.ok(toml.startsWith('# Generated by `jev-sol-terra install`'));
    assert.match(toml, /^model_provider = "jevst"$/m);
    assert.match(toml, /^model = "gpt-6\.1-sol"$/m);
    assert.match(toml, /^base_url = "http:\/\/127\.0\.0\.1:9999\/v1"$/m);
    assert.ok(toml.indexOf('model = ') < toml.indexOf('[model_providers.jevst]'), 'model must sit above the table');
    assert.ok(!fs.existsSync(path.join(codexHome, 'jev.config.toml')));

    fs.writeFileSync(file, 'hand written\n');
    const second = await run(['install'], env);
    assert.equal(second.code, 1);
    assert.match(second.out, /was not written by jev-sol-terra/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'hand written\n');
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('stats groups decisions by model and effort, mapping upstream ids back to terra and sol', async () => {
  const home = tempDir();
  const rows = [
    { model: 'openai/gpt-6.1-sol', effort: 'xhigh', session: 'a', source: 'jev', cost: 0.001,
      usage: { output_tokens: 100, output_tokens_details: { reasoning_tokens: 50 } } },
    { model: 'gpt-6.1-terra', effort: 'low', session: 'b', usage: { output_tokens: 10, output_tokens_details: { reasoning_tokens: 0 } } },
    { model: 'gpt-6.1-terra', effort: 'low', session: 'b', usage: { output_tokens: 20, output_tokens_details: { reasoning_tokens: 0 } } },
    { model: 'openai/gpt-6.1-other', effort: 'low', session: 'c' },
    { effort: 'high', session: 'd' },
  ];
  fs.writeFileSync(path.join(home, 'decisions.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  try {
    const res = await run(['stats'], { ...process.env, JEV_HOME: home });
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /^5 generations, 4 sessions, 1 routed by Jev \(\$0\.001000\)/);
    assert.match(res.out, /terra\/low\s+2 gens\s+0 avg reasoning tok\s+30 output tok/);
    assert.match(res.out, /sol\/xhigh\s+1 gens\s+50 avg reasoning tok\s+100 output tok/);
    assert.match(res.out, /openai\/gpt-6\.1-other\/low\s+1 gens/);
    assert.match(res.out, /-\/high\s+1 gens/);

    const order = ['terra/low', 'sol/xhigh', 'openai/gpt-6.1-other/low', '-/high'].map((s) => res.out.indexOf(s));
    assert.ok(order.every((i) => i > 0), res.out);
    assert.deepEqual([...order].sort((a, b) => a - b), order);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('help names the jev-sol-terra commands, the model variables and the port', async () => {
  const home = tempDir();
  try {
    const res = await run([], { ...process.env, JEV_HOME: home });
    assert.equal(res.code, 0);
    assert.match(res.out, /jev-sol-terra serve/);
    assert.match(res.out, /codex -p jevst/);
    for (const name of ['JEV_MODEL (auto|terra|sol)', 'JEV_TERRA_MODEL', 'JEV_SOL_MODEL', 'JEV_DOWNGRADE_MAX_KB', 'JEV_PORT (8788)']) {
      assert.ok(res.out.includes(name), `help is missing ${name}`);
    }
    assert.match(res.out, /http:\/\/127\.0\.0\.1:8788\/v1, model jev-auto/);
    assert.doesNotMatch(res.out, /jev-effort/);

    const version = await run(['--version'], { ...process.env, JEV_HOME: home });
    assert.match(version.out, /^jev-sol-terra v\d+\.\d+\.\d+ \(build [0-9a-f]{12}\)/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
