// The Stop hook that asks the agent to look at UI it changed before reporting the work as done.
// Driven as the host drives it: SessionStart, then Stop, with the host's JSON on stdin, in a real git
// repository whose file times are set explicitly so nothing depends on filesystem timestamp
// granularity.
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { makeProject, runScript } from './helpers.mjs';

const SESSION = '0b6f1c1e-5d0a-4d8e-9b1a-3f2a1c9e7d10';

let project;

beforeEach(() => {
  project = makeProject('http://127.0.0.1:9');
  rmSync(join(project.project, '.git'), { recursive: true, force: true });
  execFileSync('git', ['init', '-q'], { cwd: project.project });
});
afterEach(() => project.cleanup());

const startSession = (id = SESSION) =>
  runScript('session-context.mjs', [], { env: project.env, input: { session_id: id, source: 'startup' } });

const stop = (extra = {}, id = SESSION) =>
  runScript('verify-nudge.mjs', [], { env: project.env, input: { session_id: id, stop_hook_active: false, ...extra } });

/** Write a project file, dated `offsetSeconds` from now. */
function touch(relPath, offsetSeconds) {
  const path = join(project.project, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'x\n');
  const at = Date.now() / 1000 + offsetSeconds;
  utimesSync(path, at, at);
}

/** Pretend shot.mjs wrote a screenshot `offsetSeconds` from now. */
function shotAt(offsetSeconds) {
  const projects = join(project.root, 'data', 'projects');
  const [slug] = readdirSync(projects);
  writeFileSync(join(projects, slug, 'last-shot.json'), JSON.stringify({ at: Date.now() + offsetSeconds * 1000 }));
}

function blocked(result) {
  assert.equal(result.code, 0, result.output);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, 'block');
  return decision.reason;
}

function quiet(result) {
  assert.equal(result.code, 0, result.output);
  assert.equal(result.stdout.trim(), '');
}

describe('verify-nudge Stop hook', () => {
  test('a UI file changed this session and never screenshotted gets one nudge naming it', async () => {
    await startSession();
    touch('src/pages/Settings.tsx', 5);
    const reason = blocked(await stop());
    assert.match(reason, /src\/pages\/Settings\.tsx/);
    assert.match(reason, /get-past-login/);
    assert.match(reason, /say so in one line and stop/);
  });

  test('the same changes are never raised twice; a newer change is', async () => {
    await startSession();
    touch('src/site.css', 5);
    blocked(await stop());
    quiet(await stop());
    touch('src/site.css', 10);
    blocked(await stop());
  });

  test('a screenshot taken after the change satisfies it; one taken before does not', async () => {
    await startSession();
    touch('Views/Home/Index.cshtml', 5);
    shotAt(2);
    blocked(await stop());

    touch('Views/Home/Index.cshtml', 8);
    shotAt(10);
    quiet(await stop());
  });

  test('files changed before the session started do not count', async () => {
    touch('src/App.vue', -60);
    await startSession();
    quiet(await stop());
  });

  test('non-UI files, tests and stories do not count', async () => {
    await startSession();
    touch('src/api/client.ts', 5);
    touch('src/Button.test.tsx', 5);
    touch('src/Button.stories.tsx', 5);
    touch('tests/fixtures/page.html', 5);
    touch('README.md', 5);
    quiet(await stop());
  });

  test('uiFilePattern widens what counts', async () => {
    project.setConfig({ baseUrl: 'http://127.0.0.1:9', uiFilePattern: '\\.(ts|tsx)$' });
    await startSession();
    touch('src/app.component.ts', 5);
    assert.match(blocked(await stop()), /app\.component\.ts/);
  });

  test('a stop already continued by a Stop hook is never blocked again', async () => {
    await startSession();
    touch('src/App.jsx', 5);
    quiet(await stop({ stop_hook_active: true }));
  });

  test('"verifyNudge": false switches it off', async () => {
    project.setConfig({ baseUrl: 'http://127.0.0.1:9', verifyNudge: false });
    await startSession();
    touch('src/App.jsx', 5);
    quiet(await stop());
  });

  test('"configured": false keeps it quiet', async () => {
    project.setConfig({ baseUrl: 'http://127.0.0.1:9', configured: false });
    await startSession();
    touch('src/App.jsx', 5);
    quiet(await stop());
  });

  test('outside a git repository it says nothing', async () => {
    await startSession();
    rmSync(join(project.project, '.git'), { recursive: true, force: true });
    // Something to mark the root, so the project is still found without .git.
    writeFileSync(join(project.project, 'package.json'), '{}\n');
    touch('src/App.jsx', 5);
    const env = { ...project.env, GIT_CEILING_DIRECTORIES: dirname(project.project) };
    const result = await runScript('verify-nudge.mjs', [], { env, input: { session_id: SESSION } });
    quiet(result);
  });

  test('an unrecorded session with no transcript to date it says nothing', async () => {
    touch('src/App.jsx', 5);
    quiet(await stop({}, 'never-started'));
  });

  test('a session that began before this version falls back to its transcript\'s creation time', async (t) => {
    const transcript = join(project.root, 'transcript.jsonl');
    writeFileSync(transcript, '');
    if (!(statSync(transcript).birthtimeMs > 0)) return t.skip('this filesystem keeps no creation times');
    touch('src/App.jsx', 5);
    const reason = blocked(await stop({ transcript_path: transcript }, 'pre-upgrade'));
    assert.match(reason, /src\/App\.jsx/);
  });

  test('no stdin at all is not an error', async () => {
    await startSession();
    touch('src/App.jsx', 5);
    quiet(await runScript('verify-nudge.mjs', [], { env: project.env, input: '' }));
  });

  test('a project without doorman hears nothing', async () => {
    rmSync(join(project.project, '.doorman'), { recursive: true, force: true });
    await startSession();
    touch('src/App.jsx', 5);
    const result = await stop();
    quiet(result);
    assert.equal(result.stderr.trim(), '');
  });
});
