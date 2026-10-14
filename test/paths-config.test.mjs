// Where things resolve (scripts/paths.mjs) and how configuration is validated (scripts/config.mjs).
// Both run at import time, so each case runs a real script in a child process with its own env.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { SCRIPTS, makeProject, runScript, tempDir } from './helpers.mjs';

/** The value printed on a `node paths.mjs` line, e.g. layout(out, 'plugin data'). */
const layout = (stdout, label) => stdout.match(new RegExp(`^${label}\\s+(.+)$`, 'm'))?.[1].trim();

function hostEnv(project, extra = {}) {
  const env = { ...project.env, ...extra };
  delete env.DOORMAN_DATA_DIR; // these tests are about what happens without it
  return env;
}

describe('plugin data directory', () => {
  test('DOORMAN_DATA_DIR wins and is never recorded', async () => {
    const project = makeProject('http://127.0.0.1:9');
    try {
      const out = await runScript('paths.mjs', [], { env: { ...project.env, CLAUDE_PLUGIN_DATA: join(project.root, 'host') } });
      assert.equal(layout(out.stdout, 'plugin data'), join(project.root, 'data'));
      assert.ok(!existsSync(join(project.root, 'home', 'plugin-roots')));
    } finally {
      project.cleanup();
    }
  });

  test("the host's directory is recorded by the first run and wins over the environment after", async () => {
    const project = makeProject('http://127.0.0.1:9');
    try {
      const first = join(project.root, 'claude-data');
      const out1 = await runScript('paths.mjs', [], { env: hostEnv(project, { CLAUDE_PLUGIN_DATA: first }) });
      assert.equal(layout(out1.stdout, 'plugin data'), first);
      const records = readdirSync(join(project.root, 'home', 'plugin-roots'));
      assert.equal(records.length, 1);
      const record = JSON.parse(readFileSync(join(project.root, 'home', 'plugin-roots', records[0]), 'utf8'));
      assert.equal(record.dataDir, first);

      // The agent's shell has no host variable at all, or a different one: the record decides.
      for (const extra of [{}, { CLAUDE_PLUGIN_DATA: join(project.root, 'other') }]) {
        const out = await runScript('paths.mjs', [], { env: hostEnv(project, extra) });
        assert.equal(layout(out.stdout, 'plugin data'), first);
      }
    } finally {
      project.cleanup();
    }
  });

  test("Codex's PLUGIN_DATA is preferred over CLAUDE_PLUGIN_DATA", async () => {
    const project = makeProject('http://127.0.0.1:9');
    try {
      const codex = join(project.root, 'codex-data');
      const out = await runScript('paths.mjs', [], {
        env: hostEnv(project, { PLUGIN_DATA: codex, CLAUDE_PLUGIN_DATA: join(project.root, 'claude-data') }),
      });
      assert.equal(layout(out.stdout, 'plugin data'), codex);
    } finally {
      project.cleanup();
    }
  });

  test("with no host variable it falls back to doorman's own home", async () => {
    const project = makeProject('http://127.0.0.1:9');
    try {
      const out = await runScript('paths.mjs', [], { env: hostEnv(project) });
      assert.equal(layout(out.stdout, 'plugin data'), join(project.root, 'home', 'plugin-data'));
    } finally {
      project.cleanup();
    }
  });
});

describe('project and config location', () => {
  test('two checkouts with the same folder name get separate sessions', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const sessions = [];
      for (const parent of ['a', 'b']) {
        const project = join(dir, parent, 'app');
        mkdirSync(join(project, '.git'), { recursive: true });
        const out = await runScript('paths.mjs', [], { env: { ...process.env, DOORMAN_PROJECT_DIR: project, DOORMAN_DATA_DIR: join(dir, 'data'), DOORMAN_HOME: join(dir, 'home') } });
        sessions.push(layout(out.stdout, 'session'));
      }
      assert.notEqual(sessions[0], sessions[1]);
      assert.match(sessions[0], /app-[0-9a-f]{8}/);
    } finally {
      cleanup();
    }
  });

  test('.doorman/ is preferred, the 0.1.0 location is still read, DOORMAN_CONFIG wins', async () => {
    const project = makeProject('http://127.0.0.1:9');
    try {
      const current = join(project.project, '.doorman', 'doorman.config.json');
      const legacy = join(project.project, '.claude', 'doorman', 'doorman.config.json');
      mkdirSync(join(legacy, '..'), { recursive: true });
      writeFileSync(legacy, '{}');
      assert.equal(layout((await runScript('paths.mjs', [], { env: project.env })).stdout, 'config'), current);

      const { rmSync } = await import('fs');
      rmSync(current);
      assert.equal(layout((await runScript('paths.mjs', [], { env: project.env })).stdout, 'config'), legacy);

      const elsewhere = join(project.root, 'shared.json');
      writeFileSync(elsewhere, '{}');
      const out = await runScript('paths.mjs', [], { env: { ...project.env, DOORMAN_CONFIG: elsewhere } });
      assert.equal(layout(out.stdout, 'config'), elsewhere);
    } finally {
      project.cleanup();
    }
  });
});

describe('config validation', () => {
  const check = async (config, extraEnv = {}) => {
    const project = makeProject('http://127.0.0.1:9');
    try {
      project.setConfig(config);
      return await runScript('check-config.mjs', [], { env: { ...project.env, ...extraEnv } });
    } finally {
      project.cleanup();
    }
  };
  const valid = { baseUrl: 'http://127.0.0.1:4000', loginPath: '/login', defaultCheckPath: '/' };

  for (const [name, bad, message] of [
    ['an invalid regular expression', { loginPathPattern: '([' }, /loginPathPattern is not a valid regular expression/],
    ['a non-http baseUrl', { baseUrl: 'ftp://example.test' }, /baseUrl must be an http:\/\/ or https:\/\/ URL/],
    ['a path without a leading slash', { defaultCheckPath: 'dashboard' }, /defaultCheckPath must be a path starting with "\/"/],
    ['a non-boolean flag', { captureIndexedDB: 'yes' }, /captureIndexedDB must be true or false/],
    ['an unconfigured file', { configured: false }, /has not been configured for this project yet/],
  ]) {
    test(`${name} is an environment error (exit 4), not an auth result`, async () => {
      const result = await check({ ...valid, ...bad });
      assert.equal(result.code, 4, result.output);
      assert.match(result.stderr, message);
    });
  }

  test('malformed JSON says so', async () => {
    const project = makeProject('http://127.0.0.1:9');
    try {
      writeFileSync(join(project.project, '.doorman', 'doorman.config.json'), '{ "baseUrl": ');
      const result = await runScript('check-config.mjs', [], { env: project.env });
      assert.equal(result.code, 4, result.output);
      assert.match(result.stderr, /Could not parse/);
    } finally {
      project.cleanup();
    }
  });

  test('an unknown setting is reported but does not stop the run', async () => {
    const result = await check({ ...valid, authenticatedSelecter: '#me', $schema: 'x', _comment: 'y' });
    assert.equal(result.code, 0, result.output);
    assert.match(result.stderr, /doesn't recognize[^\n]*authenticatedSelecter/);
    assert.doesNotMatch(result.stderr, /\$schema|_comment/);
  });

  test('DOORMAN_BASE_URL overrides baseUrl for one run', async () => {
    const result = await check(valid, { DOORMAN_BASE_URL: 'http://127.0.0.1:5555' });
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /baseUrl\s+"http:\/\/127\.0\.0\.1:5555"/);
  });
});

describe('route arguments mangled by Git Bash', () => {
  // Git Bash rewrites `/dashboard` to `C:/Program Files/Git/dashboard` before node sees it.
  const printTarget = async (arg, env) => {
    const { dir, cleanup } = tempDir();
    try {
      const probe = join(dir, 'probe.mjs');
      writeFileSync(probe, `const m = await import(${JSON.stringify(pathToFileURL(join(SCRIPTS, 'config.mjs')).href)});\nconsole.log(m.target);\n`);
      const { execFile } = await import('child_process');
      return await new Promise((done) => execFile(process.execPath, [probe, arg], { env }, (error, stdout, stderr) =>
        done({ code: error ? error.code : 0, stdout: stdout.trim(), stderr })));
    } finally {
      cleanup();
    }
  };

  // Only a drive-letter path is treated as converted, and only Windows temp paths have one.
  test('is recovered when the Git install it was prefixed with is identifiable', {
    skip: process.platform !== 'win32' && 'Git Bash only rewrites arguments on Windows',
  }, async () => {
    const project = makeProject('http://127.0.0.1:9');
    const { dir: git, cleanup } = tempDir('fake-git-');
    try {
      mkdirSync(join(git, 'usr', 'bin'), { recursive: true });
      writeFileSync(join(git, 'usr', 'bin', 'bash.exe'), '');
      const mangled = `${git.replace(/\\/g, '/')}/dashboard`;
      const result = await printTarget(mangled, { ...project.env, EXEPATH: git });
      assert.equal(result.stdout, '/dashboard', result.stderr);
    } finally {
      cleanup();
      project.cleanup();
    }
  });

  test('is refused, with the fix, when it is not', async () => {
    const project = makeProject('http://127.0.0.1:9');
    try {
      const result = await printTarget('Z:/nowhere/dashboard', project.env);
      assert.equal(result.code, 4, result.stderr);
      assert.match(result.stderr, /Drop the\s+leading slash/);
    } finally {
      project.cleanup();
    }
  });
});
