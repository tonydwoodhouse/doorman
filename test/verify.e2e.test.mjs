// End to end: capture a real session against the fixture app, then check how each kind of route is
// classified by the scripts an agent actually runs. Exit codes are the contract, so they're what's
// asserted.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './fixtures/app.mjs';
import { makeProject, runScript } from './helpers.mjs';

const EXIT = { OK: 0, UNAUTHENTICATED: 1, NO_SESSION: 2, INCONCLUSIVE: 3, ENVIRONMENT: 4 };

describe('verification outcomes against a live app', () => {
  let app;
  let project;

  before(async () => {
    app = await startApp();
    project = makeProject(app.origin, {
      authenticatedSelector: '[data-testid=account-menu]',
      navigationTimeoutMs: 3000,
      settleTimeoutMs: 300,
    });
  });
  after(async () => {
    project?.cleanup();
    await app?.close();
  });

  test('no session yet exits 2', async () => {
    const result = await runScript('auth-check.mjs', [], { env: project.env });
    assert.equal(result.code, EXIT.NO_SESSION, result.output);
  });

  test('ensure.mjs captures a session and verifies it', async () => {
    const result = await runScript('ensure.mjs', [], { env: project.env });
    assert.equal(result.code, EXIT.OK, result.output);
    assert.match(result.stdout, /=== SESSION READY ===/);
  });

  test('a gated page with the authenticated selector is valid (explicit evidence)', async () => {
    const result = await runScript('auth-check.mjs', ['/dashboard'], { env: project.env });
    assert.equal(result.code, EXIT.OK, result.output);
    assert.doesNotMatch(result.stdout, /Evidence: the page loaded without a login redirect/);
  });

  for (const [route, label] of [['/missing', '404'], ['/boom', '500']]) {
    test(`${label} is inconclusive (exit 3) and never reported as valid`, async () => {
      const result = await runScript('auth-check.mjs', [route], { env: project.env });
      assert.equal(result.code, EXIT.INCONCLUSIVE, result.output);
      assert.match(result.stderr, /INCONCLUSIVE/);
      assert.doesNotMatch(result.output, /VALID|Authenticated/);
    });
  }

  test('403 is invalid (exit 1)', async () => {
    const result = await runScript('auth-check.mjs', ['/admin'], { env: project.env });
    assert.equal(result.code, EXIT.UNAUTHENTICATED, result.output);
  });

  test('a navigation timeout is inconclusive, not an environment failure', async () => {
    const result = await runScript('auth-check.mjs', ['/slow'], { env: project.env });
    assert.equal(result.code, EXIT.INCONCLUSIVE, result.output);
    assert.match(result.stderr, /did not finish loading in time/);
  });

  test('a redirect loop is inconclusive instead of crashing with exit 1', async () => {
    const result = await runScript('auth-check.mjs', ['/loop'], { env: project.env });
    assert.equal(result.code, EXIT.INCONCLUSIVE, result.output);
  });

  test('shot.mjs writes nothing for an inconclusive route', async () => {
    const result = await runScript('shot.mjs', ['/missing', 'missing.png'], { env: project.env });
    assert.equal(result.code, EXIT.INCONCLUSIVE, result.output);
    assert.match(result.stderr, /No screenshot written/);
  });

  test('ensure.mjs does not open a sign-in for an inconclusive route', async () => {
    const result = await runScript('ensure.mjs', ['/boom'], { env: project.env });
    assert.equal(result.code, EXIT.INCONCLUSIVE, result.output);
    assert.doesNotMatch(result.stdout, /SIGN-IN REQUIRED/);
  });

  test('SPA shell answering 200 with a sign-in component is invalid once signed out', async () => {
    app.expireAll();
    const result = await runScript('auth-check.mjs', ['/spa'], { env: project.env });
    assert.equal(result.code, EXIT.UNAUTHENTICATED, result.output);
    assert.match(result.stderr, /authenticatedSelector/);
  });

  test('an expired server-side session is invalid (login redirect)', async () => {
    const result = await runScript('auth-check.mjs', ['/dashboard'], { env: project.env });
    assert.equal(result.code, EXIT.UNAUTHENTICATED, result.output);
    assert.match(result.stderr, /login page/);
  });

  test('ensure.mjs signs in again after expiry', async () => {
    const result = await runScript('ensure.mjs', [], { env: project.env });
    assert.equal(result.code, EXIT.OK, result.output);
    assert.match(result.stdout, /=== SIGN-IN REQUIRED ===[\s\S]*=== SESSION READY ===/);
  });
});

describe('verification without any positive signal configured', () => {
  let app;
  let project;

  before(async () => {
    app = await startApp();
    project = makeProject(app.origin, { navigationTimeoutMs: 3000, settleTimeoutMs: 300 });
    await runScript('ensure.mjs', [], { env: project.env });
  });
  after(async () => {
    project?.cleanup();
    await app?.close();
  });

  test('200 is valid but says the evidence is status-only', async () => {
    const result = await runScript('auth-check.mjs', ['/dashboard'], { env: project.env });
    assert.equal(result.code, EXIT.OK, result.output);
    assert.match(result.stdout, /Evidence: the page loaded without a login redirect/);
  });

  test('SPA shell: unauthenticatedSelector catches a 200 sign-in component', async () => {
    app.expireAll();
    project.setConfig({
      appName: 'fixture', baseUrl: app.origin, loginPath: '/login?auto=1', defaultCheckPath: '/dashboard',
      unauthenticatedSelector: '[data-testid=login-form]', settleTimeoutMs: 300,
    });
    const result = await runScript('auth-check.mjs', ['/spa'], { env: project.env });
    assert.equal(result.code, EXIT.UNAUTHENTICATED, result.output);
    assert.match(result.stderr, /unauthenticatedSelector/);
  });
});

test('server down is an environment problem (exit 4)', async () => {
  const app = await startApp();
  const { origin } = app;
  await app.close();
  const project = makeProject(origin);
  try {
    // A session file must exist for the check to get as far as the network.
    const { mkdirSync, writeFileSync } = await import('fs');
    const { join } = await import('path');
    const paths = await runScript('paths.mjs', [], { env: project.env });
    const sessionDir = paths.stdout.match(/^session\s+(.+)$/m)[1].trim();
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'storageState.json'), '{"cookies":[],"origins":[]}');
    const result = await runScript('auth-check.mjs', [], { env: project.env });
    assert.equal(result.code, EXIT.ENVIRONMENT, result.output);
    assert.match(result.stderr, /Nothing answered/);
  } finally {
    project.cleanup();
  }
});
