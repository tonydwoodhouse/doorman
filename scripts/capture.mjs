// The interactive sign-in capture, shared by login-once.mjs and ensure.mjs.
//
// This is the one step that must stay human: a real browser opens, the developer signs in
// (including MFA), and only the resulting session is saved. No credentials are ever read,
// typed or stored by the toolkit.
import { SESSION_STORAGE_PATH, STATE_PATH, config, profile, stripBasePath } from './config.mjs';
import {
  EXIT, describeSession, goto, launchBrowser, listIndexedDBNames, resolveTarget, saveSessionStorage,
} from './session.mjs';

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

    await context.storageState({ path: STATE_PATH, indexedDB: config.captureIndexedDB });
    // Cookies and localStorage come from storageState(); sessionStorage does not, and MSAL
    // (Entra ID) keeps its tokens there by default.
    const sessionKeys = await saveSessionStorage(page);
    // IndexedDB is only in the snapshot if it was asked for, so say so while the app is still
    // open and we can see whether it uses any.
    const indexedDbNames = config.captureIndexedDB ? [] : await listIndexedDBNames(page);

    console.log('=== SIGN-IN COMPLETE ===');
    console.log(`✅ Session saved to ${STATE_PATH}`);
    if (sessionKeys > 0) {
      console.log(`   Plus ${sessionKeys} sessionStorage key(s) -> ${SESSION_STORAGE_PATH}`);
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
