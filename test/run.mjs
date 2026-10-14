// Run the test suite: every test/*.test.mjs, one file at a time.
//
//   node test/run.mjs            everything (npm test)
//   node test/run.mjs --unit     just the fast tests: no browser, no installers (npm run test:unit)
//
// Any other argument is passed to `node --test`, e.g. --test-name-pattern=profile.
//
// A runner rather than `node --test test/` because that would also execute test/fixtures/app.mjs —
// a server that never exits — and Node 20's --test can't take a glob. One file at a time because the
// end-to-end files each drive real browsers and the installers, and running them side by side makes
// timings, not code, decide the results.
import { spawnSync } from 'child_process';
import { readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const unitOnly = args.includes('--unit');
const passthrough = args.filter((arg) => arg !== '--unit');

const files = readdirSync(here)
  .filter((name) => name.endsWith('.test.mjs'))
  .filter((name) => !unitOnly || !/\.e2e\.test\.mjs$|^installers\./.test(name))
  .sort()
  .map((name) => join(here, name));

const { status } = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...passthrough, ...files], { stdio: 'inherit' });
process.exit(status ?? 1);
