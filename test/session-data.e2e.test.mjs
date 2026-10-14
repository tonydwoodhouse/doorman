// End to end: what a real capture writes to disk and prints. A saved session is a bearer
// credential, so this checks permissions, that no value reaches the output, that captureOrigins
// trims the identity provider when asked, and that a session is never saved where Git could commit it.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { startApp } from './fixtures/app.mjs';
import { makeProject, runScript } from './helpers.mjs';

const sessionDir = async (env) =>
  (await runScript('paths.mjs', [], { env })).stdout.match(/^session\s+(.+)$/m)[1].trim();

describe('session files from a sign-in through a separate identity provider', () => {
  let app;
  let project;
  let capture;
  let dir;

  before(async () => {
    app = await startApp();
    project = makeProject(app.origin, {
      loginPath: '/idp-login?auto=1',
      authenticatedSelector: '[data-testid=account-menu]',
      settleTimeoutMs: 300,
    });
    // Created beforehand with default permissions, as an older version would have left it.
    dir = await sessionDir(project.env);
    mkdirSync(dir, { recursive: true });
    capture = await runScript('login-once.mjs', [], { env: project.env });
  });
  after(async () => {
    project?.cleanup();
    await app?.close();
  });

  test('the capture succeeds and lists both hosts without any value', () => {
    assert.equal(capture.code, 0, capture.output);
    assert.match(capture.stdout, /Saved for \(values not shown\):[\s\S]*127\.0\.0\.1\s+1 cookie[\s\S]*localhost\s+1 cookie/);
    assert.match(capture.stdout, /Also saved: localhost/);
    const state = JSON.parse(readFileSync(join(dir, 'storageState.json'), 'utf8'));
    for (const { value } of state.cookies) assert.ok(!capture.output.includes(value), 'a cookie value was printed');
  });

  test('the session file and directory are owner-only (even a pre-existing directory), with no temp files left', () => {
    assert.deepEqual(readdirSync(dir).filter((f) => /\.tmp/.test(f)), []);
    const file = join(dir, 'storageState.json');
    if (process.platform === 'win32') {
      for (const target of [dir, file]) {
        const acl = execFileSync('icacls', [target], { encoding: 'utf8' });
        assert.doesNotMatch(acl, /Everyone|BUILTIN|Authenticated Users|NT AUTHORITY/i, acl);
      }
    } else {
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      assert.equal(statSync(file).mode & 0o777, 0o600);
    }
  });

  test('the saved session works', async () => {
    const result = await runScript('auth-check.mjs', ['/dashboard'], { env: project.env });
    assert.equal(result.code, 0, result.output);
  });

  test('capture waits for authenticatedText, and saves nothing if it never shows', async () => {
    const file = join(dir, 'storageState.json');
    const before = readFileSync(file, 'utf8');
    const config = {
      appName: 'fixture', baseUrl: app.origin, loginPath: '/idp-login?auto=1', defaultCheckPath: '/dashboard',
      settleTimeoutMs: 300, loginTimeoutMs: 3000,
    };
    project.setConfig({ ...config, authenticatedText: 'Not on any page' });
    const missing = await runScript('login-once.mjs', [], { env: project.env });
    assert.equal(missing.code, 5, missing.output);
    assert.match(missing.stderr, /authenticatedText/);
    assert.equal(readFileSync(file, 'utf8'), before);

    project.setConfig({ ...config, authenticatedText: 'Sign out' });
    const shown = await runScript('login-once.mjs', [], { env: project.env });
    assert.equal(shown.code, 0, shown.output);
  });

  test('captureOrigins drops the identity provider and says so', async () => {
    project.setConfig({
      appName: 'fixture', baseUrl: app.origin, loginPath: '/idp-login?auto=1', defaultCheckPath: '/dashboard',
      authenticatedSelector: '[data-testid=account-menu]', settleTimeoutMs: 300, captureOrigins: ['127.0.0.1'],
    });
    const result = await runScript('login-once.mjs', [], { env: project.env });
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /Dropped \(not in captureOrigins\): localhost \(1 cookie\)/);
    const state = JSON.parse(readFileSync(join(dir, 'storageState.json'), 'utf8'));
    assert.deepEqual(state.cookies.map((c) => c.domain), ['127.0.0.1']);
  });

  test('a malformed captureOrigins is a configuration error (exit 4)', async () => {
    project.setConfig({ appName: 'fixture', baseUrl: app.origin, loginPath: '/login', captureOrigins: [] });
    const result = await runScript('auth-check.mjs', [], { env: project.env });
    assert.equal(result.code, 4, result.output);
    assert.match(result.stderr, /captureOrigins/);
  });
});

describe('a session directory inside a Git repository', () => {
  let app;
  let project;
  let repo;

  before(async () => {
    app = await startApp();
    project = makeProject(app.origin, { settleTimeoutMs: 300 });
    repo = join(project.root, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['-C', repo, 'init', '-q']);
    project.env.DOORMAN_SESSION_DIR = join(repo, 'sessions');
  });
  after(async () => {
    project?.cleanup();
    await app?.close();
  });

  test('capture refuses before opening a browser when the files are not ignored', async () => {
    const result = await runScript('login-once.mjs', [], { env: project.env });
    assert.equal(result.code, 4, result.output);
    assert.match(result.stderr, /Refusing to save a session[\s\S]*could be committed/);
    assert.doesNotMatch(result.stdout, /WAITING FOR SIGN-IN/);
  });

  test('once ignored, capture saves and Git sees nothing to stage', async () => {
    writeFileSync(join(repo, '.gitignore'), 'storageState*.json\nsessionStorage*.json\n');
    const result = await runScript('login-once.mjs', [], { env: project.env });
    assert.equal(result.code, 0, result.output);
    const status = execFileSync('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
    assert.deepEqual(status.trim().split('\n'), ['?? .gitignore']);
  });
});
