// Load Playwright from wherever it is actually installed.
//
// Vendored, that is node_modules beside these scripts and a plain `import 'playwright'` would do.
// As a plugin it is not: the plugin directory can be read-only and is replaced wholesale on update,
// so dependencies are installed into the plugin's data directory instead (scripts/install-deps.mjs).
// Node resolves bare specifiers by walking up from the importing *file*, which would never reach
// there, and NODE_PATH does not apply to ES modules — hence resolving the path ourselves.
//
// Kept in one file so every script still writes `import { chromium } from './playwright.mjs'` and
// nothing else has to know any of this.
import { existsSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { DEPS_DIR, PLUGIN_MODE, SCRIPT_DIR } from './paths.mjs';

const installed = join(DEPS_DIR, 'node_modules', 'playwright');

async function load() {
  // A bare import first: it is the normal case, and it lets Node's own resolution handle hoisted
  // or globally linked installs that a hardcoded path would miss.
  try {
    return await import('playwright');
  } catch (bareError) {
    if (existsSync(installed)) {
      try {
        return await import(pathToFileURL(join(installed, 'index.mjs')).href);
      } catch {
        // Fall through to the shared message: a half-installed copy is an install problem too.
      }
    }
    if (PLUGIN_MODE && existsSync(join(DEPS_DIR, '.installing'))) {
      // The SessionStart hook is mid-download. Saying so turns a puzzling failure into a wait.
      console.error('Playwright is still being installed for the doorman plugin.');
      console.error(`Give it a minute and try again — progress is in ${join(DEPS_DIR, 'install.log')}`);
      process.exit(4);
    }
    console.error('Playwright is not installed.');
    if (PLUGIN_MODE) {
      console.error(`Expected it at ${installed}`);
      console.error('Start a new session to let the plugin install it, or run it now:');
      console.error(`  node "${join(SCRIPT_DIR, 'install-deps.mjs')}" --sync`);
    } else {
      console.error('Run from the toolkit directory:  npm install && npx playwright install chromium');
    }
    // 4 = ENVIRONMENT. Hardcoded rather than imported: config.mjs validates the configuration on
    // import, and a missing dependency should not be reported as a configuration error.
    process.exit(4);
  }
}

const playwright = await load();

export const { chromium } = playwright;
export default playwright;
