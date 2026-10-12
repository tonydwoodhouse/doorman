// Shared plumbing for the test suite: throwaway projects, isolated doorman state, and a way to run
// the real scripts as an agent would — as child processes, judged by exit code and output.
import { execFile } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SCRIPTS = join(REPO, 'scripts');

/** A fresh temporary directory, removed by the returned cleanup. */
export function tempDir(prefix = 'doorman-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * A throwaway project configured for `origin`, with doorman's home, data and project directories
 * all pointed inside it so nothing touches the developer's real state.
 */
export function makeProject(origin, config = {}) {
  const { dir, cleanup } = tempDir();
  const project = join(dir, 'project');
  mkdirSync(join(project, '.git'), { recursive: true });
  mkdirSync(join(project, '.doorman'), { recursive: true });
  writeConfig(project, { appName: 'fixture', baseUrl: origin, loginPath: '/login?auto=1', defaultCheckPath: '/dashboard', ...config });

  const env = { ...process.env };
  // A host's variables leaking in from the shell running the tests would redirect state.
  for (const name of ['CLAUDE_PLUGIN_DATA', 'PLUGIN_DATA', 'CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_ROOT',
    'PLUGIN_ROOT', 'DOORMAN_CONFIG', 'DOORMAN_BASE_URL', 'DOORMAN_PROFILE', 'DOORMAN_SESSION_DIR',
    'DOORMAN_OUTPUT_DIR', 'DOORMAN_DEPS_DIR', 'MSYSTEM_PREFIX', 'EXEPATH']) delete env[name];
  Object.assign(env, {
    DOORMAN_HOME: join(dir, 'home'),
    DOORMAN_DATA_DIR: join(dir, 'data'),
    DOORMAN_PROJECT_DIR: project,
    DOORMAN_CAPTURE_HEADLESS: '1',
    DOORMAN_SKIP_INSTALL: '1',
  });
  return { root: dir, project, env, cleanup, setConfig: (next) => writeConfig(project, next) };
}

function writeConfig(project, config) {
  writeFileSync(join(project, '.doorman', 'doorman.config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

/** Run one of doorman's scripts. Resolves { code, stdout, stderr, output } and never rejects. */
export function runScript(script, args = [], { env, cwd, timeout = 60000 } = {}) {
  return new Promise((done) => {
    execFile(process.execPath, [join(SCRIPTS, script), ...args], { env, cwd, timeout, windowsHide: true },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
        done({ code, stdout, stderr, output: `${stdout}\n${stderr}` });
      });
  });
}
