// End to end, per storage mechanism: sign in to the fixture app (a real Chromium, headless), let
// that browser close, then replay the saved session in a fresh one and reach a protected page.
// Each mechanism is a separate part of the fixture, so a pass here means doorman captured and
// restored exactly that kind of state — and the negative cases show the setting that makes it work
// really is what makes it work.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'fs';
import { join } from 'path';
import { startApp } from './fixtures/app.mjs';
import { makeProject, runScript } from './helpers.mjs';

const EXIT = { OK: 0, UNAUTHENTICATED: 1, NO_SESSION: 2, ENVIRONMENT: 4 };
const SIGNED_IN = '[data-testid=account-menu]';

/** A project for one of the fixture's token-in-browser-storage apps (/ls, /ss, /idb). */
function storageProject(app, kind, extra = {}) {
  return makeProject(app.origin, {
    loginPath: `/${kind}/login?auto=1`,
    loginPathPattern: '/login$',
    defaultCheckPath: `/${kind}/app`,
    authenticatedSelector: SIGNED_IN,
    settleTimeoutMs: 800,
    ...extra,
  });
}

describe('session replay by storage mechanism', () => {
  let app;
  const projects = [];
  const project = (...args) => {
    const p = storageProject(app, ...args);
    projects.push(p);
    return p;
  };

  before(async () => { app = await startApp(); });
  after(async () => {
    for (const p of projects) p.cleanup();
    await app?.close();
  });

  test('localStorage: captured, replayed, and invalid once the server forgets the token', async () => {
    const p = project('ls');
    const capture = await runScript('login-once.mjs', [], { env: p.env });
    assert.equal(capture.code, EXIT.OK, capture.output);
    assert.match(capture.stdout, /127\.0\.0\.1\s+1 localStorage key/);

    const check = await runScript('auth-check.mjs', [], { env: p.env });
    assert.equal(check.code, EXIT.OK, check.output);

    app.expireAll();
    const expired = await runScript('auth-check.mjs', [], { env: p.env });
    assert.equal(expired.code, EXIT.UNAUTHENTICATED, expired.output);
  });

  test('sessionStorage: replayed from the sidecar file', async () => {
    const p = project('ss');
    const capture = await runScript('login-once.mjs', [], { env: p.env });
    assert.equal(capture.code, EXIT.OK, capture.output);
    assert.match(capture.stdout, /Plus 1 sessionStorage key\(s\)/);
    const check = await runScript('auth-check.mjs', [], { env: p.env });
    assert.equal(check.code, EXIT.OK, check.output);
  });

  test('sessionStorage: without captureSessionStorage the replay is signed out', async () => {
    const p = project('ss', { captureSessionStorage: false });
    const capture = await runScript('login-once.mjs', [], { env: p.env });
    assert.equal(capture.code, EXIT.OK, capture.output);
    const check = await runScript('auth-check.mjs', [], { env: p.env });
    assert.equal(check.code, EXIT.UNAUTHENTICATED, check.output);
  });

  test('IndexedDB: off by default, and the sign-in says the app uses it', async () => {
    const p = project('idb');
    const capture = await runScript('login-once.mjs', [], { env: p.env });
    assert.equal(capture.code, EXIT.OK, capture.output);
    assert.match(capture.stdout, /this app uses IndexedDB \(auth\), which was NOT saved/);
    const check = await runScript('auth-check.mjs', [], { env: p.env });
    assert.equal(check.code, EXIT.UNAUTHENTICATED, check.output);
  });

  test('IndexedDB: replayed with captureIndexedDB', async () => {
    const p = project('idb', { captureIndexedDB: true });
    const capture = await runScript('login-once.mjs', [], { env: p.env });
    assert.equal(capture.code, EXIT.OK, capture.output);
    assert.match(capture.stdout, /IndexedDB included in the snapshot/);
    const check = await runScript('auth-check.mjs', [], { env: p.env });
    assert.equal(check.code, EXIT.OK, check.output);
  });
});

describe('profiles', () => {
  let app;
  let p;
  let sessionDir;

  before(async () => {
    app = await startApp();
    p = makeProject(app.origin, { authenticatedSelector: SIGNED_IN, settleTimeoutMs: 300 });
    sessionDir = (await runScript('paths.mjs', [], { env: p.env })).stdout.match(/^session\s+(.+)$/m)[1].trim();
  });
  after(async () => {
    p?.cleanup();
    await app?.close();
  });

  test('each profile has its own session files', async () => {
    for (const args of [[], ['--profile=admin']]) {
      const capture = await runScript('login-once.mjs', args, { env: p.env });
      assert.equal(capture.code, EXIT.OK, capture.output);
    }
    assert.ok(existsSync(join(sessionDir, 'storageState.json')));
    assert.ok(existsSync(join(sessionDir, 'storageState.admin.json')));
    // The profile is named in the commands doorman suggests, so a fix lands on the right session.
    const check = await runScript('auth-check.mjs', ['--profile=admin'], { env: p.env });
    assert.equal(check.code, EXIT.OK, check.output);
  });

  test('clearing one profile leaves the other signed in', async () => {
    const clear = await runScript('ensure.mjs', ['--clear', '--no-login', '--profile=admin'], { env: p.env });
    assert.equal(clear.code, EXIT.OK, clear.output);
    assert.ok(!existsSync(join(sessionDir, 'storageState.admin.json')));

    const admin = await runScript('auth-check.mjs', ['--profile', 'admin'], { env: p.env });
    assert.equal(admin.code, EXIT.NO_SESSION, admin.output);
    assert.match(admin.output, /--profile=admin/);
    const standard = await runScript('auth-check.mjs', [], { env: p.env });
    assert.equal(standard.code, EXIT.OK, standard.output);
  });

  test('DOORMAN_PROFILE selects a profile too', async () => {
    const result = await runScript('auth-check.mjs', [], { env: { ...p.env, DOORMAN_PROFILE: 'admin' } });
    assert.equal(result.code, EXIT.NO_SESSION, result.output);
  });

  for (const bad of ['../escape', 'a/b', '.hidden', 'x'.repeat(41)]) {
    test(`a profile name like ${JSON.stringify(bad.slice(0, 12))} is refused (exit 4)`, async () => {
      const result = await runScript('auth-check.mjs', [`--profile=${bad}`], { env: p.env });
      assert.equal(result.code, EXIT.ENVIRONMENT, result.output);
      assert.match(result.stderr, /Invalid profile name/);
    });
  }
});

describe('session expiry reporting', () => {
  let app;
  let p;

  before(async () => {
    app = await startApp({ sessionTtlSeconds: 150 });
    p = makeProject(app.origin, { authenticatedSelector: SIGNED_IN, settleTimeoutMs: 300, expiryWarningMs: 15 * 60000 });
  });
  after(async () => {
    p?.cleanup();
    await app?.close();
  });

  test('the earliest cookie expiry is reported, with a warning when it is close', async () => {
    const capture = await runScript('login-once.mjs', [], { env: p.env });
    assert.equal(capture.code, EXIT.OK, capture.output);
    assert.match(capture.stdout, /earliest cookie expiry in 2m/);

    const check = await runScript('auth-check.mjs', [], { env: p.env });
    assert.equal(check.code, EXIT.OK, check.output);
    assert.match(check.stdout, /Expiring soon/);
  });
});
