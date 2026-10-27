import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/jev.js', import.meta.url));

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
    execFile(process.execPath, [CLI, ...args], { env }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, out: stdout + stderr });
    });
  });
}

test('jev-effort stop stops a running proxy and is a no-op when none runs', async () => {
  const port = await freePort();
  const env = { ...process.env, JEV_PORT: String(port), JEV_HOME: '.jev-test', JEV_MODE: 'heuristic', JEV_QUIET: '1' };
  const child = spawn(process.execPath, [CLI, 'serve'], { env, stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', r));
  try {
    for (let i = 0; i < 50 && (await run(['status'], env)).code !== 0; i++) await new Promise((r) => setTimeout(r, 100));

    const stopped = await run(['stop'], env);
    assert.equal(stopped.code, 0, stopped.out);
    assert.match(stopped.out, new RegExp(`stopped jev proxy \\(pid ${child.pid},`));
    await exited;

    const again = await run(['stop'], env);
    assert.equal(again.code, 0);
    assert.match(again.out, /no jev proxy/);
  } finally {
    child.kill();
  }
});
