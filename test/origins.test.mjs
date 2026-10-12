// Unit tests for what a captured session keeps (scripts/origins.mjs) and how it is written
// (scripts/secure-files.mjs).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { allowEntryHost, describeRow, filterState, originWarnings, summarizeState } from '../scripts/origins.mjs';
import { gitExposure, writePrivateFile } from '../scripts/secure-files.mjs';
import { tempDir } from './helpers.mjs';

const cookie = (domain, name = 'c') => ({ name, value: 'SECRET', domain, path: '/' });
const origin = (url, keys = 1) => ({
  origin: url,
  localStorage: Array.from({ length: keys }, (_, i) => ({ name: `k${i}`, value: 'SECRET' })),
});

const state = {
  cookies: [cookie('app.example.com'), cookie('.example.com'), cookie('login.idp.test'), cookie('tracker.test')],
  origins: [origin('https://app.example.com', 2), origin('https://login.idp.test')],
};

describe('captureOrigins', () => {
  test('normalizes hosts, wildcards and full origins', () => {
    assert.equal(allowEntryHost('App.Example.com'), 'app.example.com');
    assert.equal(allowEntryHost('*.Example.com'), '*.example.com');
    assert.equal(allowEntryHost('https://login.idp.test:8443/path'), 'login.idp.test');
    assert.equal(allowEntryHost('localhost:5001'), 'localhost');
  });

  test('"flow" keeps everything', () => {
    const { state: kept, dropped } = filterState(state, 'flow', 'app.example.com');
    assert.equal(kept, state);
    assert.deepEqual(dropped, []);
  });

  test('an allowlist keeps the app, cookies the app receives, and listed hosts only', () => {
    const { state: kept, dropped } = filterState(state, ['https://login.idp.test'], 'app.example.com');
    assert.deepEqual(kept.cookies.map((c) => c.domain), ['app.example.com', '.example.com', 'login.idp.test']);
    assert.deepEqual(kept.origins.map((o) => o.origin), ['https://app.example.com', 'https://login.idp.test']);
    assert.deepEqual(dropped, [{ host: 'tracker.test', cookies: 1, localStorageKeys: 0, indexedDB: 0 }]);
  });

  test('a wildcard entry matches the domain and its subdomains', () => {
    const { state: kept } = filterState(state, ['*.idp.test'], 'app.example.com');
    assert.ok(kept.cookies.some((c) => c.domain === 'login.idp.test'));
    assert.ok(!kept.cookies.some((c) => c.domain === 'tracker.test'));
  });
});

describe('summaries never carry values', () => {
  test('counts per host', () => {
    const summary = summarizeState(state);
    assert.deepEqual(summary.find((r) => r.host === 'app.example.com'),
      { host: 'app.example.com', cookies: 1, localStorageKeys: 2, indexedDB: 0 });
    assert.ok(!JSON.stringify(summary).includes('SECRET'));
    assert.equal(describeRow(summary[0]), '1 cookie, 2 localStorage keys');
  });

  test('warns about unrelated hosts and parent-domain cookies, not the app or a configured IdP', () => {
    const notes = originWarnings(summarizeState(state), { appHost: 'app.example.com', idpHostPattern: 'idp\\.test$' });
    assert.equal(notes.length, 2, notes.join('\n'));
    assert.match(notes[0], /example\.com are sent to every \*\.example\.com site/);
    assert.match(notes[1], /Also saved: tracker\.test/);
  });
});

describe('writePrivateFile', () => {
  test('writes atomically, leaves no temp file, and restricts access to the owner', () => {
    const { dir, cleanup } = tempDir();
    try {
      const file = join(dir, 'storageState.json');
      writeFileSync(file, 'old');
      assert.equal(writePrivateFile(file, '{"new":true}'), true);
      assert.equal(readFileSync(file, 'utf8'), '{"new":true}');
      assert.deepEqual(readdirSync(dir), ['storageState.json']);
      if (process.platform === 'win32') {
        const acl = execFileSync('icacls', [file], { encoding: 'utf8' });
        assert.doesNotMatch(acl, /Everyone|BUILTIN|Authenticated Users|NT AUTHORITY/i, acl);
        assert.match(acl, /:\(F\)/);
      } else {
        assert.equal(statSync(file).mode & 0o777, 0o600);
      }
    } finally {
      cleanup();
    }
  });
});

describe('gitExposure', () => {
  test('outside a repository, ignored, unignored and tracked', () => {
    const { dir, cleanup } = tempDir();
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
    try {
      assert.equal(gitExposure(join(dir, 'storageState.json')).exposed, false);
      git('init', '-q');
      assert.equal(gitExposure(join(dir, 'storageState.json')).exposed, true);
      writeFileSync(join(dir, '.gitignore'), 'storageState*.json\n');
      assert.equal(gitExposure(join(dir, 'storageState.json')).exposed, false);
      // Already tracked: an ignore rule doesn't protect it.
      writeFileSync(join(dir, 'storageState.json'), '{}');
      git('add', '-f', 'storageState.json');
      assert.equal(gitExposure(join(dir, 'storageState.json')).exposed, true);
    } finally {
      cleanup();
    }
  });
});
