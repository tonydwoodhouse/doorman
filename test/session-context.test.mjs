// The SessionStart note that tells an agent doorman is set up, so it reaches for get-past-login
// before a login wall stops it rather than after. It must stay silent anywhere doorman isn't in use.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makeProject, runScript } from './helpers.mjs';

const project = makeProject('http://127.0.0.1:9');
after(() => project.cleanup());

const context = () => runScript('session-context.mjs', [], { env: project.env });

describe('session-context hook', () => {
  test('a configured project gets the note, naming the skill and the config', async () => {
    const out = await context();
    assert.equal(out.code, 0);
    assert.match(out.stdout, /get-past-login/);
    assert.match(out.stdout, /\.doorman\/doorman\.config\.json/);
  });

  // An agent assumes it has no browser. A note that only says what to do at a login wall leaves it
  // reporting "I haven't checked it in a browser"; it has to state the capability and the
  // expectation.
  test('the note says the agent can check pages, and should before reporting UI work done', async () => {
    const out = await context();
    assert.match(out.stdout, /CAN open this app's pages in a real browser/);
    assert.match(out.stdout, /before you report the work as done/);
    assert.match(out.stdout, /dev server/);
  });

  test('it records when the session started, once, for the Stop hook', async () => {
    const id = 'a1b2c3d4-0000-4000-8000-000000000001';
    const run = () => runScript('session-context.mjs', [], { env: project.env, input: { session_id: id } });
    await run();
    const projects = join(project.root, 'data', 'projects');
    const file = join(projects, readdirSync(projects)[0], 'sessions', `${id}.json`);
    const first = JSON.parse(readFileSync(file, 'utf8')).startedAt;
    assert.equal(typeof first, 'number');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await run(); // a resume or a compaction: same session, same start
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).startedAt, first);
  });

  test('a session ID that is not a plain identifier is never used as a file name', async () => {
    const out = await runScript('session-context.mjs', [], { env: project.env, input: { session_id: '../../escape' } });
    assert.equal(out.code, 0);
    assert.match(out.stdout, /get-past-login/);
    assert.ok(!existsSync(join(project.root, 'data', 'escape.json')));
  });

  test('"configured": false keeps it quiet', async () => {
    project.setConfig({ baseUrl: 'http://127.0.0.1:9', configured: false });
    const out = await context();
    assert.equal(out.code, 0);
    assert.equal(out.stdout.trim(), '');
  });

  test('a config that does not parse still gets the note', async () => {
    project.setConfig({ baseUrl: 'http://127.0.0.1:9' });
    writeFileSync(join(project.project, '.doorman', 'doorman.config.json'), '{ not json');
    const out = await context();
    assert.equal(out.code, 0);
    assert.match(out.stdout, /get-past-login/);
  });

  test('a project without doorman hears nothing', async () => {
    rmSync(join(project.project, '.doorman'), { recursive: true, force: true });
    const out = await context();
    assert.equal(out.code, 0);
    assert.equal(out.stdout.trim(), '');
    assert.equal(out.stderr.trim(), '');
  });
});
