// The interactive sign-in capture, shared by login-once.mjs and ensure.mjs.
//
// This is the one step that must stay human: a real browser opens, the developer signs in
// (including MFA), and only the resulting session is saved. No password or MFA response is ever
// read, typed or stored by the toolkit — but the saved session is itself a bearer credential while
// it lasts, so it is written owner-only, kept out of Git, and trimmed to `captureOrigins`.
import { relative } from 'path';
import {
  SESSION_DIR_IS_PRIVATE, SESSION_PATH_DIR, SESSION_STORAGE_PATH, STATE_PATH, config, profile, stripBasePath,
} from './config.mjs';
import { describeRow, filterState, originWarnings, summarizeState } from './origins.mjs';
import { gitExposure, restrictToOwner, writePrivateFile } from './secure-files.mjs';
import {
  EXIT, describeSession, goto, launchBrowser, listIndexedDBNames, resolveTarget, saveSessionStorage,
} from './session.mjs';

/**
 * Refuse to save a session where Git could pick it up. Checked before the browser opens, so the
 * developer never signs in only to have the result thrown away.
 */
function refuseIfTrackable() {
  for (const path of [STATE_PATH, SESSION_STORAGE_PATH]) {
    const { exposed, repo } = gitExposure(path);
    if (!exposed) continue;
    const shown = repo ? relative(repo, path) : path;
    console.error(`Refusing to save a session to ${path}:`);
    console.error(`it is inside the Git repository${repo ? ` at ${repo}` : ''} and not ignored, so it could be committed.`);
    console.error('A saved session works like a password until it expires. Either:');
    console.error(`  - ignore it: add "${shown.replace(/\\/g, '/')}" (or storageState*.json and sessionStorage*.json)`);
    console.error('    to that repository\'s .gitignore — and if it is already tracked, git rm --cached it; or');
    console.error('  - set DOORMAN_SESSION_DIR to a directory outside the repository.');
    return true;
  }
  return false;
}

/** Print what the saved session holds, by host and count. Never a value. */
function reportSavedOrigins(state, dropped, sessionStorage) {
  const appHost = new URL(config.baseUrl).hostname;
  // The app first; the rest (usually the identity provider) in the order the sign-in visited them.
  const summary = summarizeState(state, sessionStorage).sort((a, b) => (b.host === appHost) - (a.host === appHost));
  const width = Math.max(...summary.map((r) => r.host.length), 4);
  console.log('   Saved for (values not shown):');
  if (summary.length === 0) console.log('     nothing — the sign-in left no cookies or storage');
  for (const r of summary) console.log(`     ${r.host.padEnd(width)}  ${describeRow(r)}`);
  for (const r of dropped) console.log(`   Dropped (not in captureOrigins): ${r.host} (${describeRow(r)})`);
  for (const note of originWarnings(summary, { appHost, idpHostPattern: config.idpHostPattern })) {
    console.log(`   Note: ${note}`);
  }
}

function humanTimeout(ms) {
  return ms >= 60000 ? `${Math.round(ms / 60000)} minute(s)` : `${Math.round(ms / 1000)} second(s)`;
}

/**
 * Open a visible browser, wait for the developer to finish signing in, and save the session.
 * Prints stable marker lines an agent can watch for. Returns an exit code; never throws for
 * the two expected human failures (window closed, timed out).
 */
export async function captureSession() {
  const {
    appName, loginPath, loginPathPattern, idpHostPattern,
    authenticatedUrlPattern, authenticatedSelector, viewport, loginTimeoutMs,
  } = config;

  if (refuseIfTrackable()) return EXIT.ENVIRONMENT;
  // Every check makes sure the session directory exists, but on Windows only restricts one it
  // creates (icacls is a process per call). A directory left by an older version is narrowed here,
  // when a secret is about to be written into it.
  const dirRestricted = !SESSION_DIR_IS_PRIVATE || restrictToOwner(SESSION_PATH_DIR, { directory: true });

  const timeoutText = humanTimeout(loginTimeoutMs);
  const loginUrl = resolveTarget(loginPath).href;
  // DOORMAN_CAPTURE_HEADLESS=1 exists for the test suite, whose fixture app signs itself in. With a
  // real app nobody could complete a sign-in in a window that isn't shown.
  const browser = await launchBrowser({ headless: process.env.DOORMAN_CAPTURE_HEADLESS === '1' });
  let page;

  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport });
    page = await context.newPage();

    const loaded = await goto(page, loginUrl, { settle: false });
    if (loaded.navigationError) {
      console.error(`Could not load the sign-in page ${loginUrl}: ${loaded.navigationError === 'timeout'
        ? 'it did not finish loading in time' : loaded.navigationError}.`);
      console.error('This is not an authentication problem; check the app is healthy and loginPath is right.');
      return EXIT.ENVIRONMENT;
    }

    // Marker lines: an agent tailing this output keys off these, so keep them stable.
    console.log('=== WAITING FOR SIGN-IN ===');
    console.log(`A browser window is open on the ${appName} sign-in page (${loginUrl}).`);
    if (profile !== 'default') console.log(`Sign in as the "${profile}" role — this session is saved under that profile.`);
    console.log('Complete the sign-in and any MFA prompt in that window.');
    console.log(`Waiting up to ${timeoutText}. Nothing is typed for you.`);

    // Require a return to this app, rather than merely leaving the provider's page.
    await page.waitForFunction((options) => {
      const url = new URL(location.href);
      // Compare app-relative, so a base-path-hosted app matches the same patterns.
      let path = url.pathname;
      if (options.basePath && path.startsWith(options.basePath)) {
        path = path.slice(options.basePath.length) || '/';
        if (!path.startsWith('/')) path = `/${path}`;
      }
      const onLoginPage = new RegExp(options.loginPathPattern, 'i').test(path);
      const onIdp = options.idpHostPattern !== null &&
        new RegExp(options.idpHostPattern, 'i').test(url.host);
      const matchesAuthenticatedUrl = options.authenticatedUrlPattern === null ||
        new RegExp(options.authenticatedUrlPattern, 'i').test(`${path}${url.search}`);
      return url.origin === options.appOrigin && !onLoginPage && !onIdp && matchesAuthenticatedUrl;
    }, {
      appOrigin: config.origin, basePath: config.basePath,
      loginPathPattern, idpHostPattern, authenticatedUrlPattern,
    }, { timeout: loginTimeoutMs });

    if (authenticatedSelector !== null) {
      await page.locator(authenticatedSelector).first()
        .waitFor({ state: 'visible', timeout: loginTimeoutMs });
    }

    const captured = await context.storageState({ indexedDB: config.captureIndexedDB });
    const { state, dropped } = filterState(captured, config.captureOrigins, new URL(config.baseUrl).hostname);
    let restricted = writePrivateFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`) && dirRestricted;
    // Cookies and localStorage come from storageState(); sessionStorage does not, and MSAL
    // (Entra ID) keeps its tokens there by default.
    const sidecar = await saveSessionStorage(page);
    restricted &&= sidecar.restricted;
    // IndexedDB is only in the snapshot if it was asked for, so say so while the app is still
    // open and we can see whether it uses any.
    const indexedDbNames = config.captureIndexedDB ? [] : await listIndexedDBNames(page);

    console.log('=== SIGN-IN COMPLETE ===');
    console.log(`✅ Session saved to ${STATE_PATH}`);
    reportSavedOrigins(state, dropped, sidecar);
    if (sidecar.keys > 0) console.log(`   sessionStorage saved separately to ${SESSION_STORAGE_PATH}`);
    if (!restricted) {
      console.log('   ⚠️  Could not restrict the session files or their folder to your user account;');
      console.log('   other accounts on this machine may be able to read them. Check the folder\'s permissions.');
    }
    if (config.captureIndexedDB) console.log('   IndexedDB included in the snapshot.');
    else if (indexedDbNames.length > 0) {
      console.log(`   Note: this app uses IndexedDB (${indexedDbNames.join(', ')}), which was NOT saved.`);
      console.log('   If checks now fail as unauthenticated, its tokens are probably in there —');
      console.log('   set "captureIndexedDB": true in doorman.config.json and sign in again.');
    }
    const age = describeSession();
    if (age) console.log(`   ${age.text}`);
    console.log('Headless runs can now reuse it. Re-run this when it expires.');
    return EXIT.OK;
  } catch (e) {
    const windowClosed = /has been closed|Target closed|browser has disconnected/i.test(e.message);
    const timedOut = e.name === 'TimeoutError';
    if (!windowClosed && !timedOut) throw e;

    console.error('=== SIGN-IN INCOMPLETE ===');
    if (windowClosed) {
      console.error('❌ The browser window closed before the sign-in finished. No session was saved.');
    } else {
      console.error(`❌ Timed out after ${timeoutText}. No session was saved.`);
      let lastUrl = null;
      try { lastUrl = page?.url(); } catch { /* window already gone */ }
      if (lastUrl) {
        console.error(`   Last URL seen: ${lastUrl}`);
        console.error(`   App-relative path: ${stripBasePath(new URL(lastUrl).pathname)}`);
      }
      console.error('   If you DID sign in, the detection settings are probably wrong: check');
      console.error('   loginPathPattern, authenticatedUrlPattern and authenticatedSelector in');
      console.error('   doorman.config.json against that URL.');
    }
    return EXIT.LOGIN_INCOMPLETE;
  } finally {
    await browser.close();
  }
}
