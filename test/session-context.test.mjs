// The SessionStart note that tells an agent doorman is set up, so it reaches for get-past-login
// before a login wall stops it rather than after. It must stay silent anywhere doorman isn't in use.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'fs';
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
