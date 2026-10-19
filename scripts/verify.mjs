// Session verification, shared by auth-check.mjs and ensure.mjs so both branch and speak
// identically. Import this (rather than re-implementing a check) in custom scripts.
import { join } from 'path';
import { EXIT, OUTPUT_DIR, OUTPUT_SUFFIX, STATE_PATH, command, config, profile } from './config.mjs';
import {
  VERDICT, assessSession, describeSession, goto, hasSession, launchBrowser, newSessionContext,
  resolveTarget,
} from './session.mjs';

/** Default screenshot auth-check.mjs leaves behind (per profile). */
export const CHECK_SHOT_PATH = join(OUTPUT_DIR, `auth-check${OUTPUT_SUFFIX}.png`);

/** The exact command to re-capture a session for the active profile. */
export function loginCommand() {
  return command('login-once.mjs');
}

const VERDICT_CODES = {
  [VERDICT.VALID]: EXIT.OK,
  [VERDICT.INCONCLUSIVE]: EXIT.INCONCLUSIVE,
  [VERDICT.INVALID]: EXIT.UNAUTHENTICATED,
};

/**
 * Load a gated route with the saved session and judge the result.
 * Returns { code, verdict, evidence, status, finalUrl, reasons, target, screenshotPath, age }.
 * Never exits on an auth verdict; environment failures still exit 4 from session.mjs.
 */
export async function runCheck(target, { screenshotPath: requestedShot = null } = {}) {
  let screenshotPath = requestedShot;
  const targetUrl = resolveTarget(target);

  if (!hasSession()) {
    return {
      code: EXIT.NO_SESSION, verdict: 'no-session', status: 0, finalUrl: targetUrl,
      reasons: ['no session file for this profile'], target, screenshotPath: null, age: null,
    };
  }

  const browser = await launchBrowser();
  try {
    const context = await newSessionContext(browser);
    const page = await context.newPage();
    const loaded = await goto(page, targetUrl.href);

    // Screenshot before judging — on failure it's the fastest way to see why. A page that never
    // loaded may refuse (or hang until the timeout); that's no reason to lose or delay the verdict.
    if (screenshotPath) {
      await page.screenshot({ path: screenshotPath, timeout: 5000 }).catch(() => { screenshotPath = null; });
    }

    const assessment = await assessSession(page, loaded);
    return {
      ...assessment,
      code: VERDICT_CODES[assessment.verdict],
      target,
      screenshotPath,
      age: describeSession(),
    };
  } finally {
    await browser.close();
  }
}

/**
 * Print the standard human/agent-readable outcome for a runCheck() result.
 * Pass showFix:false when the caller is about to give better advice of its own.
 */
export function reportCheck(result, { showFix = true } = {}) {
  const { verdict, evidence, status, finalUrl, reasons, target, screenshotPath, age } = result;
  const shotNote = screenshotPath ? `      (screenshot: ${screenshotPath})` : '';
  // ensure.mjs does check-then-sign-in in one go, so it's the lowest-friction fix to suggest.
  const fix = `${command('ensure.mjs')}   (checks, then opens a sign-in window if needed)`;
  const httpText = status === null ? 'no HTTP response' : `HTTP ${status}`;

  if (verdict === 'no-session') {
    console.error(`No session captured yet${profile === 'default' ? '' : ` for profile "${profile}"`}.`);
    if (showFix) console.error(`   Capture one: ${fix}`);
    return;
  }

  if (verdict === VERDICT.INVALID) {
    console.error(`❌ Session is not authenticated: ${reasons.join('; ')}.`);
    // The landing URL is what you check the config patterns against, so always show it.
    console.error(`   Landed on ${finalUrl.href} (${httpText}).`);
    if (age) console.error(`   Session ${age.text}.`);
    if (showFix) console.error(`   Re-run: ${fix}`);
    if (screenshotPath) console.error(`   Screenshot: ${screenshotPath}`);
    return;
  }

  if (verdict === VERDICT.INCONCLUSIVE) {
    console.error(`⚠️  INCONCLUSIVE: ${target} ${reasons.join('; ')}, so it proves nothing about the session.`);
    console.error('   This is not an authentication failure — do NOT sign in again. Check the URL against');
    console.error(`   the app's routes, or that the app is healthy.${shotNote}`);
    return;
  }

  console.log(`✅ Authenticated. ${target} => ${httpText}. Landed on ${finalUrl.href}`);
  if (evidence === 'status-only') {
    console.log('   Evidence: the page loaded without a login redirect. Set authenticatedSelector (or');
    console.log('   authenticatedText) in doorman.config.json to prove a signed-in user positively.');
  }
  if (profile !== 'default') console.log(`   Profile: ${profile}`);
  if (age) {
    console.log(`   Session: ${age.text}`);
    if (age.expiringSoon) {
      console.log(`   ⚠️  Expiring soon — if it fails mid-task, re-run: ${command('ensure.mjs')}`);
    }
  }
  if (screenshotPath) console.log(`   Screenshot: ${screenshotPath}`);
  console.log(`   State file: ${STATE_PATH}`);
}

/** Convenience for scripts that only need the code: check, report, return the exit code. */
export async function checkAndReport(target = config.defaultCheckPath, options = {}) {
  const result = await runCheck(target, options);
  reportCheck(result);
  return result.code;
}
