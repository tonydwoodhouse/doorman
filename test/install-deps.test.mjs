// The dependency installer's lock: a killed install must not block later ones, and two installs
// must never run at once. npm and npx are replaced by a stand-in on PATH that records each call,
// so this runs offline in a second or two.
import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { hostname } from 'os';
import { delimiter, join } from 'path';
import { makeProject, runScript } from './helpers.mjs';
import { installInProgress } from '../scripts/install-lock.mjs';

const project = makeProject('http://127.0.0.1:9');
const deps = join(project.root, 'data', 'deps');
const lock = join(deps, '.installing');
const calls = join(project.root, 'npm-calls.log');
const bin = join(project.root, 'bin');

// The stand-in: logs "<tool> <args>", fakes a Playwright install, and can be told to fail or dawdle.
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, 'fake-npm.mjs'), `
import { appendFileSync, mkdirSync } from 'fs';
const [tool, ...args] = process.argv.slice(2);
appendFileSync(process.env.FAKE_NPM_LOG, tool + ' ' + args.join(' ') + '\\n');
if (process.env.FAKE_NPM_FAIL === tool) process.exit(7);
if (tool === 'npm') mkdirSync('node_modules/playwright', { recursive: true });
await new Promise((done) => setTimeout(done, Number(process.env.FAKE_NPM_DELAY ?? 0)));
`);
for (const tool of ['npm', 'npx']) {
  if (process.platform === 'win32') {
    writeFileSync(join(bin, `${tool}.cmd`), `@echo off\r\nnode "%~dp0fake-npm.mjs" ${tool} %*\r\n`);
  } else {
    writeFileSync(join(bin, tool), `#!/bin/sh\nexec node "$(dirname "$0")/fake-npm.mjs" ${tool} "$@"\n`);
    chmodSync(join(bin, tool), 0o755);
  }
}

const env = { ...project.env, FAKE_NPM_LOG: calls };
delete env.DOORMAN_SKIP_INSTALL;
// Windows spells it Path; setting a second PATH key would leave the child with two.
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
env[pathKey] = `${bin}${delimiter}${env[pathKey]}`;

const install = (args = [], extra = {}) => runScript('install-deps.mjs', args, { env: { ...env, ...extra } });
const npmInstalls = () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '').split('\n').filter((l) => l.startsWith('npm install')).length;
const writeLock = (fields) => {
  mkdirSync(deps, { recursive: true });
  writeFileSync(lock, `${JSON.stringify({ host: hostname(), ...fields })}\n`);
};
const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();
const waitFor = (condition, timeoutMs = 15000) => new Promise((done, fail) => {
  const started = Date.now();
  const poll = setInterval(() => {
    if (condition()) { clearInterval(poll); done(); }
    else if (Date.now() - started > timeoutMs) { clearInterval(poll); fail(new Error('timed out waiting')); }
  }, 50);
});
const DEAD_PID = 2 ** 22 + 12345; // above every platform's default PID ceiling

describe('install-deps lock', () => {
  beforeEach(() => {
    rmSync(deps, { recursive: true, force: true });
    rmSync(calls, { force: true });
  });
  after(() => project.cleanup());

  test('a plain install takes the lock, stamps, and releases it', async () => {
    const result = await install(['--sync']);
    assert.equal(result.code, 0, result.output);
    assert.ok(existsSync(join(deps, '.installed')));
    assert.ok(!existsSync(lock), 'lock left behind');
    assert.equal(npmInstalls(), 1);
  });

  test('a lock whose process is gone is cleared and the install recovers', async () => {
    writeLock({ pid: DEAD_PID, startedAt: new Date().toISOString() });
    const result = await install(['--sync']);
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, new RegExp(`cleared a stale install lock \\(process ${DEAD_PID} is no longer running\\)`));
    assert.equal(npmInstalls(), 1);
    assert.ok(!existsSync(lock));
  });

  test('a lock older than any install is stale even if its PID is alive', async () => {
    writeLock({ pid: process.pid, startedAt: hoursAgo(3) });
    const result = await install(['--sync']);
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /cleared a stale install lock \(it was taken 180 minutes ago\)/);
  });

  test("0.1.0's bare-timestamp lock is judged by its age", async () => {
    mkdirSync(deps, { recursive: true });
    writeFileSync(lock, `${hoursAgo(5)}\n`);
    const result = await install(['--sync']);
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /cleared a stale install lock/);
  });

  test('the hook clears a stale lock, says so, and starts the install', async () => {
    writeLock({ pid: DEAD_PID, startedAt: hoursAgo(1) });
    const result = await install();
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /cleared a stale install lock[\s\S]*installing Playwright in the background/);
    // The detached child does the install; let it finish before the next test clears the directory.
    await waitFor(() => existsSync(join(deps, '.installed')) && !existsSync(lock));
    assert.equal(npmInstalls(), 1);
  });

  test('with a live lock the hook and the detached installer stand aside', async () => {
    writeLock({ pid: process.pid, startedAt: new Date().toISOString() });
    const before = readFileSync(lock, 'utf8');
    for (const args of [[], ['--run']]) {
      const result = await install(args);
      assert.equal(result.code, 0, result.output);
      assert.doesNotMatch(result.stdout, /installing|cleared/);
    }
    assert.equal(readFileSync(lock, 'utf8'), before, 'a live lock was touched');
    assert.equal(npmInstalls(), 0);
  });

  test('--sync waits out a live install instead of failing', async () => {
    writeLock({ pid: process.pid, startedAt: new Date().toISOString() });
    const pending = install(['--sync']);
    setTimeout(() => rmSync(lock, { force: true }), 1500); // the other install finishes (without stamping)
    const result = await pending;
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, new RegExp(`another install is already running \\(pid ${process.pid}`));
    assert.equal(npmInstalls(), 1, 'it should install once the lock was released, since nothing was stamped');
  });

  test('only a live lock counts as an install in progress (what playwright.mjs reports)', () => {
    writeLock({ pid: process.pid, startedAt: new Date().toISOString() });
    assert.equal(installInProgress(deps), true);
    writeLock({ pid: DEAD_PID, startedAt: new Date().toISOString() });
    assert.equal(installInProgress(deps), false);
    rmSync(lock);
    assert.equal(installInProgress(deps), false);
  });

  test('a failed install still releases the lock', async () => {
    const result = await install(['--sync'], { FAKE_NPM_FAIL: 'npm' });
    assert.equal(result.code, 7, result.output);
    assert.match(result.stdout, /install failed \(exit 7\)/);
    assert.ok(!existsSync(lock), 'lock left behind after a failure');
    assert.ok(!existsSync(join(deps, '.installed')));
  });

  test('two concurrent installs run npm once; the second waits and finds it done', async () => {
    const slow = { FAKE_NPM_DELAY: '1500' };
    const first = install(['--sync'], slow);
    // Let the first take the lock before the second arrives.
    await waitFor(() => existsSync(lock));
    const [a, b] = await Promise.all([first, install(['--sync'], slow)]);
    assert.equal(a.code, 0, a.output);
    assert.equal(b.code, 0, b.output);
    assert.match(b.stdout, /another install is already running/);
    assert.equal(npmInstalls(), 1);
  });
});
