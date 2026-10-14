// Screenshot a gated page using the saved session.
//
// Run:  node shot.mjs [path] [outfile.png] [--full] [--wait=<selector>] [--profile=<name>]
// e.g.  node shot.mjs /admin/reports
//       node shot.mjs /admin/reports before.png --full
//       node shot.mjs / home.png --wait="table tbody tr"
//       node shot.mjs /admin --profile=admin
//
// It verifies the session BEFORE writing anything, so a dead session can never leave you
// looking at a screenshot of the login page and calling it the app. Browser console errors
// are reported too — that's usually where a silent CSP or JS failure shows up.
//
// Exit codes: 0 written | 1 session invalid | 2 no session yet
//             3 inconclusive: the route proved nothing (404/5xx/timeout) | 4 environment problem
//
// Git Bash on Windows rewrites a leading-slash arg into a Windows path; config.mjs undoes it.
import { isAbsolute, join } from 'path';
import { OUTPUT_DIR, OUTPUT_SUFFIX, flags, positionals, target } from './config.mjs';
import {
  EXIT, VERDICT, assessSession, describeSession, goto, launchBrowser, newSessionContext,
  requireSession, resolveTarget,
} from './session.mjs';
import { loginCommand } from './verify.mjs';

const fullPage = flags.full === true;
const waitFor = typeof flags.wait === 'string' ? flags.wait : null;

const targetUrl = resolveTarget(target);
const outPath = resolvePath(positionals[1] ?? defaultName(targetUrl));
requireSession();

function defaultName(url) {
  const slug = url.pathname.replace(/^\/+|\/+$/g, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  // OUTPUT_SUFFIX keeps profiles from overwriting each other's screenshots.
  return `shot-${slug || 'home'}${OUTPUT_SUFFIX}.png`;
}

// Relative names land in OUTPUT_DIR, never the working directory: as a plugin that keeps
// screenshots off the project's disk, where nothing gitignores them. Pass an absolute path to
// choose somewhere else. Either way the full path is printed.
function resolvePath(name) {
  const withExt = name.toLowerCase().endsWith('.png') ? name : `${name}.png`;
  return isAbsolute(withExt) ? withExt : join(OUTPUT_DIR, withExt);
}

const browser = await launchBrowser();
try {
  const context = await newSessionContext(browser);
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(e.message));

  const loaded = await goto(page, targetUrl.href);
  const { verdict, status, reasons } = await assessSession(page, loaded);

  if (verdict === VERDICT.INVALID) {
    const age = describeSession();
    console.error(`❌ Not authenticated: ${reasons.join('; ')}.`);
    if (age) console.error(`   Session ${age.text}.`);
    console.error('   No screenshot written — it would only show the login page.');
    console.error(`   Capture a session first: ${loginCommand()}`);
    process.exit(EXIT.UNAUTHENTICATED);
  }
  if (verdict === VERDICT.INCONCLUSIVE) {
    console.error(`⚠️  INCONCLUSIVE: ${target} ${reasons.join('; ')}, so it proves nothing about the session.`);
    console.error('   This is not an authentication failure — do NOT sign in again.');
    console.error("   No screenshot written. Check the URL against the app's routes.");
    process.exit(EXIT.INCONCLUSIVE);
  }

  if (waitFor !== null) {
    try {
      await page.locator(waitFor).first().waitFor({ state: 'visible', timeout: 15000 });
    } catch {
      console.error(`⚠️  Waited 15s but "${waitFor}" never became visible; capturing anyway.`);
    }
  }

  await page.screenshot({ path: outPath, fullPage });
  console.log(`✅ ${target} => HTTP ${status}. Screenshot: ${outPath}`);
  console.log('   Open it with the Read tool — do not assume success from this exit code.');

  if (consoleErrors.length) {
    console.log(`\n⚠️  ${consoleErrors.length} browser console error(s):`);
    for (const line of consoleErrors.slice(0, 10)) console.log(`   - ${line}`);
    if (consoleErrors.length > 10) console.log(`   ...and ${consoleErrors.length - 10} more.`);
  }
} finally {
  await browser.close();
}
