// The vendored installers, run for real against throwaway workspaces — install.sh under bash and
// install.ps1 under PowerShell 7, whichever this machine has. Each scenario runs under both, since
// the two are maintained side by side and must behave the same.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { REPO, tempDir } from './helpers.mjs';

/** bash to run install.sh with. On Windows that must be Git Bash, not WSL's System32 bash.exe. */
function findBash() {
  if (process.platform !== 'win32') return 'bash';
  try {
    const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(); // …/Git/mingw64/libexec/git-core
    const bash = resolve(execPath, '..', '..', '..', 'bin', 'bash.exe');
    return existsSync(bash) ? bash : null;
  } catch {
    return null;
  }
}

function has(command, args) {
  try {
    execFileSync(command, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const bash = findBash();
const SHELLS = [
  {
    name: 'install.sh',
    available: Boolean(bash) && has(bash, ['-c', 'true']),
    run: (ws, flags) => [bash, [join(REPO, 'installers', 'install.sh').replace(/\\/g, '/'),
      '--workspace', ws.replace(/\\/g, '/'), ...flags.map((f) => f.sh)]],
  },
  {
    name: 'install.ps1',
    available: has('pwsh', ['-NoProfile', '-Command', 'exit 0']),
    run: (ws, flags) => ['pwsh', ['-NoProfile', '-NonInteractive', '-File', join(REPO, 'installers', 'install.ps1'),
      '-Workspace', ws, ...flags.map((f) => f.ps)]],
  },
];

const FORCE = { sh: '--force', ps: '-Force' };
const SKILL = { sh: '--install-skill', ps: '-InstallSkill' };
const RESET = { sh: '--reset-config', ps: '-ResetConfig' };
const UNINSTALL = { sh: '--uninstall', ps: '-Uninstall' };

function install(shell, ws, flags = []) {
  const [command, args] = shell.run(ws, flags);
  const env = { ...process.env };
  for (const name of ['DOORMAN_CONFIG', 'DOORMAN_PROJECT_DIR', 'DOORMAN_DATA_DIR', 'CLAUDE_PROJECT_DIR']) delete env[name];
  return new Promise((done) => {
    execFile(command, args, { env, timeout: 120000, windowsHide: true }, (error, stdout, stderr) => {
      done({ code: error ? (error.code ?? -1) : 0, stdout, stderr, output: `${stdout}\n${stderr}` });
    });
  });
}

/** The receipt's hash: SHA-256 with carriage returns ignored, as both installers compute it. */
const receiptHash = (text) => createHash('sha256').update(text.replace(/\r/g, '')).digest('hex');
const receiptOf = (ws) => readFileSync(join(ws, '.doorman', 'install-manifest.json'), 'utf8');
const entryFor = (ws, path) => JSON.parse(receiptOf(ws)).files.find((f) => f.path === path);

/** A fresh workspace that looks like a project: a Git repo with a package.json. */
function workspace() {
  const { dir, cleanup } = tempDir('doorman-ws-');
  execFileSync('git', ['-C', dir, 'init', '-q']);
  writeFileSync(join(dir, 'package.json'), '{ "name": "acme", "private": true }\n');
  return { ws: dir, tools: join(dir, 'tools', 'doorman'), cleanup };
}

// Every setting, changed from its default, in an order and layout no tool would produce.
const CUSTOM_CONFIG = `{
    "appName": "Acme Portal",
  "baseUrl": "http://127.0.0.1:4999/portal",
  "loginPath": "/auth/signin",   "loginPathPattern": "^/auth",
  "idpHostPattern": "idp\\\\.acme\\\\.test$",
  "authenticatedUrlPattern": "^/home",
  "authenticatedSelector": "#account",
  "authenticatedText": "Sign out",
  "unauthenticatedSelector": "#login-form",
  "unauthenticatedStatusCodes": [401],
  "defaultCheckPath": "/home",
  "viewport": { "width": 1024, "height": 768 },
  "loginTimeoutMs": 60000,
  "settleTimeoutMs": 250,
  "navigationTimeoutMs": 9000,
  "captureSessionStorage": false,
  "captureIndexedDB": true,
  "captureOrigins": ["127.0.0.1", "*.acme.test"],
  "expiryWarningMs": 60000,
  "configured": true
}
`.replace(/\n/g, '\r\n'); // CRLF too: nothing may "normalize" it

for (const shell of SHELLS) {
  describe(shell.name, { skip: !shell.available && `${shell.name}'s shell is not available here` }, () => {
    test('a fresh install creates the config with detect.mjs and copies the example beside it', async () => {
      const { ws, tools, cleanup } = workspace();
      try {
        const result = await install(shell, ws);
        assert.equal(result.code, 0, result.output);
        assert.ok(existsSync(join(tools, 'ensure.mjs')));
        assert.ok(existsSync(join(tools, 'check-config.mjs')));
        assert.equal(readFileSync(join(tools, 'doorman.config.example.json'), 'utf8'),
          readFileSync(join(REPO, 'config', 'doorman.config.example.json'), 'utf8'));
        const config = JSON.parse(readFileSync(join(tools, 'doorman.config.json'), 'utf8'));
        assert.equal(config.configured, false, 'nothing to detect in an empty project');
        assert.match(result.stdout, /Creating tools\/doorman\/doorman\.config\.json/);
      } finally {
        cleanup();
      }
    });

    test("a fresh install starts from the project's plugin config when there is one", async () => {
      const { ws, tools, cleanup } = workspace();
      try {
        mkdirSync(join(ws, '.doorman'));
        writeFileSync(join(ws, '.doorman', 'doorman.config.json'), JSON.stringify({
          appName: 'Seeded', baseUrl: 'http://127.0.0.1:4321', loginPath: '/signin',
          defaultCheckPath: '/home', authenticatedSelector: '#me',
        }));
        const result = await install(shell, ws);
        assert.equal(result.code, 0, result.output);
        const config = JSON.parse(readFileSync(join(tools, 'doorman.config.json'), 'utf8'));
        assert.deepEqual(
          [config.appName, config.baseUrl, config.loginPath, config.defaultCheckPath, config.authenticatedSelector],
          ['Seeded', 'http://127.0.0.1:4321', '/signin', '/home', '#me']);
      } finally {
        cleanup();
      }
    });

    test('an upgrade with --force leaves a fully customized config byte-for-byte unchanged', async () => {
      const { ws, tools, cleanup } = workspace();
      try {
        assert.equal((await install(shell, ws)).code, 0);
        writeFileSync(join(tools, 'doorman.config.json'), CUSTOM_CONFIG);
        writeFileSync(join(tools, 'ensure.mjs'), '// edited\n');

        const result = await install(shell, ws, [FORCE]);
        assert.equal(result.code, 0, result.output);
        assert.equal(readFileSync(join(tools, 'doorman.config.json'), 'utf8'), CUSTOM_CONFIG);
        assert.match(result.stdout, /Keeping your tools\/doorman\/doorman\.config\.json/);
        assert.match(result.stdout, /Config OK/);
        assert.doesNotMatch(result.output, /doesn't recognize/, 'every customized key should be a real setting');
        // Managed files, on the other hand, are replaced by --force.
        assert.equal(readFileSync(join(tools, 'ensure.mjs'), 'utf8'), readFileSync(join(REPO, 'scripts', 'ensure.mjs'), 'utf8'));
      } finally {
        cleanup();
      }
    });

    test('without --force existing toolkit files are skipped', async () => {
      const { ws, tools, cleanup } = workspace();
      try {
        assert.equal((await install(shell, ws)).code, 0);
        writeFileSync(join(tools, 'ensure.mjs'), '// edited\n');
        const result = await install(shell, ws);
        assert.equal(result.code, 0, result.output);
        assert.match(result.stdout, /skip \(changed since installed[^\n]*\): tools\/doorman\/ensure\.mjs/);
        assert.equal(readFileSync(join(tools, 'ensure.mjs'), 'utf8'), '// edited\n');
      } finally {
        cleanup();
      }
    });

    test('an upgrade reports a problem in the config without changing it', async () => {
      const { ws, tools, cleanup } = workspace();
      try {
        assert.equal((await install(shell, ws)).code, 0);
        const typo = '{ "baseUrl": "http://127.0.0.1:4999", "authenticatedSelecter": "#me" }\n';
        writeFileSync(join(tools, 'doorman.config.json'), typo);
        const result = await install(shell, ws, [FORCE]);
        assert.equal(result.code, 0, result.output);
        assert.match(result.output, /doesn't recognize[^\n]*authenticatedSelecter/);
        assert.equal(readFileSync(join(tools, 'doorman.config.json'), 'utf8'), typo);
      } finally {
        cleanup();
      }
    });

    test('--reset-config replaces the config and keeps the old one as a .bak', async () => {
      const { ws, tools, cleanup } = workspace();
      try {
        assert.equal((await install(shell, ws)).code, 0);
        writeFileSync(join(tools, 'doorman.config.json'), CUSTOM_CONFIG);
        const result = await install(shell, ws, [RESET]);
        assert.equal(result.code, 0, result.output);
        const backups = readdirSync(tools).filter((f) => /^doorman\.config\.json\.\d{8}-\d{6}\.bak$/.test(f));
        assert.equal(backups.length, 1, readdirSync(tools).join(', '));
        assert.equal(readFileSync(join(tools, backups[0]), 'utf8'), CUSTOM_CONFIG);
        assert.notEqual(readFileSync(join(tools, 'doorman.config.json'), 'utf8'), CUSTOM_CONFIG);
      } finally {
        cleanup();
      }
    });

    test('uninstall removes the toolkit', async () => {
      const { ws, tools, cleanup } = workspace();
      try {
        assert.equal((await install(shell, ws)).code, 0);
        const result = await install(shell, ws, [UNINSTALL]);
        assert.equal(result.code, 0, result.output);
        assert.ok(!existsSync(join(ws, 'tools')), 'the toolkit directory (and its empty parent) should be gone');
        assert.ok(!existsSync(join(ws, 'CLAUDE.md')));
        assert.ok(!existsSync(join(ws, '.doorman')), 'the receipt (and its empty folder) should be gone');
      } finally {
        cleanup();
      }
    });

    test('the receipt records every installed file with the hash it was installed with', async () => {
      const { ws, tools, cleanup } = workspace();
      try {
        assert.equal((await install(shell, ws, [SKILL])).code, 0);
        const receipt = JSON.parse(receiptOf(ws));
        assert.equal(receipt.toolsDir, 'tools/doorman');
        const ensure = entryFor(ws, 'tools/doorman/ensure.mjs');
        assert.equal(ensure.sha256, receiptHash(readFileSync(join(tools, 'ensure.mjs'), 'utf8')));
        assert.equal(ensure.action, 'created');
        assert.equal(ensure.version, JSON.parse(readFileSync(join(REPO, '.claude-plugin', 'plugin.json'), 'utf8')).version);
        assert.ok(entryFor(ws, '.claude/skills/get-past-login/SKILL.md'));
        assert.ok(entryFor(ws, 'tools/doorman/doorman.config.json'), 'the config it created is recorded too');
      } finally {
        cleanup();
      }
    });

    test("uninstall keeps the project's own SKILL.md and a modified script (acceptance)", async () => {
      const { ws, tools, cleanup } = workspace();
      try {
        const ownSkill = join(ws, '.claude', 'skills', 'get-past-login', 'SKILL.md');
        mkdirSync(join(ownSkill, '..'), { recursive: true });
        writeFileSync(ownSkill, '# our own skill\n');

        const first = await install(shell, ws, [SKILL]);
        assert.equal(first.code, 0, first.output);
        assert.match(first.stdout, /skip \(exists, not installed by doorman[^\n]*\): \.claude\/skills\/get-past-login\/SKILL\.md/);
        assert.equal(readFileSync(ownSkill, 'utf8'), '# our own skill\n');
        writeFileSync(join(tools, 'shot.mjs'), '// my local tweak\n');

        const result = await install(shell, ws, [UNINSTALL]);
        assert.equal(result.code, 0, result.output);
        assert.equal(readFileSync(ownSkill, 'utf8'), '# our own skill\n', 'a file doorman never installed was touched');
        assert.equal(readFileSync(join(tools, 'shot.mjs'), 'utf8'), '// my local tweak\n');
        assert.match(result.stdout, /Kept[^\n]*\n[\s\S]*tools\/doorman\/shot\.mjs/);
        assert.ok(!existsSync(join(tools, 'ensure.mjs')), 'an unmodified installed file should be removed');
        // doorman's copy of the Codex skill was installed and unmodified, so it goes.
        assert.ok(!existsSync(join(ws, '.agents')));
      } finally {
        cleanup();
      }
    });

    test('--force backs up a file doorman did not write, and uninstall puts it back', async () => {
      const { ws, cleanup } = workspace();
      try {
        const ownSkill = join(ws, '.claude', 'skills', 'get-past-login', 'SKILL.md');
        mkdirSync(join(ownSkill, '..'), { recursive: true });
        writeFileSync(ownSkill, '# our own skill\n');

        const result = await install(shell, ws, [SKILL, FORCE]);
        assert.equal(result.code, 0, result.output);
        assert.match(result.stdout, /replaced: \.claude\/skills\/get-past-login\/SKILL\.md \(the previous file is kept as SKILL\.md\.\d{8}-\d{6}\.bak\)/);
        const entry = entryFor(ws, '.claude/skills/get-past-login/SKILL.md');
        assert.equal(entry.action, 'replaced');
        assert.equal(readFileSync(join(ws, entry.backup), 'utf8'), '# our own skill\n');

        const removal = await install(shell, ws, [UNINSTALL]);
        assert.equal(removal.code, 0, removal.output);
        assert.equal(readFileSync(ownSkill, 'utf8'), '# our own skill\n');
        assert.ok(!existsSync(join(ws, entry.backup)), 'the backup should have been moved back');
      } finally {
        cleanup();
      }
    });

    test('a re-run updates installed files nobody has changed, without --force', async () => {
      const { ws, tools, cleanup } = workspace();
      try {
        assert.equal((await install(shell, ws)).code, 0);
        // Pretend an older version was installed: different content, and a receipt that says so.
        const older = '// doorman 0.1.x\r\n';
        writeFileSync(join(tools, 'ensure.mjs'), older);
        const receiptPath = join(ws, '.doorman', 'install-manifest.json');
        const current = entryFor(ws, 'tools/doorman/ensure.mjs').sha256;
        writeFileSync(receiptPath, receiptOf(ws).replace(current, receiptHash(older)));

        const result = await install(shell, ws);
        assert.equal(result.code, 0, result.output);
        assert.match(result.stdout, /updated: tools\/doorman\/ensure\.mjs/);
        assert.equal(readFileSync(join(tools, 'ensure.mjs'), 'utf8'), readFileSync(join(REPO, 'scripts', 'ensure.mjs'), 'utf8'));
        assert.equal(entryFor(ws, 'tools/doorman/ensure.mjs').action, 'updated');
      } finally {
        cleanup();
      }
    });

    test('without a receipt, uninstall removes nothing and says why', async () => {
      const { ws, tools, cleanup } = workspace();
      try {
        mkdirSync(tools, { recursive: true });
        writeFileSync(join(tools, 'ensure.mjs'), '// installed by 0.1.0\n');
        const result = await install(shell, ws, [UNINSTALL]);
        assert.equal(result.code, 1, result.output);
        assert.match(result.stderr, /No install receipt/);
        assert.ok(existsSync(join(tools, 'ensure.mjs')));
      } finally {
        cleanup();
      }
    });
  });
}

const [sh, ps] = SHELLS;
describe('install.sh and install.ps1 together', { skip: !(sh.available && ps.available) && 'needs both bash and PowerShell 7' }, () => {
  test('write byte-identical receipts', async () => {
    const a = workspace();
    const b = workspace();
    try {
      assert.equal((await install(sh, a.ws, [SKILL])).code, 0);
      assert.equal((await install(ps, b.ws, [SKILL])).code, 0);
      // The config is detected per workspace, so its hash can differ; everything else must match.
      const strip = (text) => text.split('\n').filter((line) => !line.includes('doorman.config.json"')).join('\n');
      assert.equal(strip(receiptOf(b.ws)), strip(receiptOf(a.ws)));
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  test('either can uninstall what the other installed', async () => {
    for (const [installer, remover] of [[sh, ps], [ps, sh]]) {
      const { ws, cleanup } = workspace();
      try {
        assert.equal((await install(installer, ws, [SKILL])).code, 0);
        const result = await install(remover, ws, [UNINSTALL]);
        assert.equal(result.code, 0, result.output);
        assert.deepEqual(readdirSync(ws).filter((f) => f !== '.git'), ['package.json'], result.output);
      } finally {
        cleanup();
      }
    }
  });
});
