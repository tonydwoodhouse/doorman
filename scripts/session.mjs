// Shared runtime helpers for the doorman toolkit.
//
// Every script that drives a browser goes through here, so auth-check.mjs, shot.mjs and
// ensure.mjs classify failures identically — an agent that can trust one can trust the rest.
//
// The rules for what a page load proves live in verdict.mjs: explicit evidence decides "valid" or
// "invalid", and everything else (404, 5xx, timeouts) is "inconclusive" — never a reason to sign in
// again, and never reported as a working session either.
import { chromium } from './playwright.mjs';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import {
  EXIT, SESSION_STORAGE_PATH, STATE_PATH, command, config, joinBasePath, profile,
  undoMsysPathConversion,
} from './config.mjs';
import { VERDICT, classify } from './verdict.mjs';

// Re-exported so a custom script only needs one import for the common case.
export { EXIT, STATE_PATH, VERDICT, profile };

const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Resolve a path (or absolute URL) beneath baseUrl, refusing to leave the app origin. */
export function resolveTarget(pathOrUrl) {
  const raw = undoMsysPathConversion(String(pathOrUrl));
  let url;
  try {
    url = ABSOLUTE_URL.test(raw)
      ? new URL(raw)
      : new URL(joinBasePath(raw.startsWith('/') ? raw : `/${raw}`), config.origin);
  } catch {
    console.error(`Not a valid path or URL: ${raw}`);
    process.exit(EXIT.ENVIRONMENT);
  }
  if (url.origin !== config.origin) {
    console.error(`The path must stay on ${config.origin}. Received: ${raw}`);
    process.exit(EXIT.ENVIRONMENT);
  }
  return url;
}

/** True when a session has been captured for the active profile. */
export function hasSession() {
  return existsSync(STATE_PATH);
}

/** Exit with NO_SESSION unless a captured session exists for the active profile. */
export function requireSession() {
  if (!existsSync(STATE_PATH)) {
    const forProfile = profile === 'default' ? '' : ` for profile "${profile}"`;
    console.error(`No session captured yet${forProfile}.`);
    console.error(`   Run: ${command('ensure.mjs')}   (opens a browser window for the developer to sign in)`);
    process.exit(EXIT.NO_SESSION);
  }
  return STATE_PATH;
}

export async function launchBrowser({ headless = true } = {}) {
  try {
    return await chromium.launch({ headless, args: ['--ignore-certificate-errors'] });
  } catch (e) {
    if (/Executable doesn't exist|playwright install/i.test(e.message)) {
      console.error('Chromium is not installed for this Playwright version.');
      console.error('Run from this folder:  npx playwright install chromium');
    } else {
      console.error(`Could not launch Chromium: ${e.message}`);
    }
    process.exit(EXIT.ENVIRONMENT);
  }
}

/**
 * Open a browser context that replays the saved session. Cookies, localStorage and (when it was
 * captured) IndexedDB are restored by Playwright from the state file; sessionStorage is replayed
 * from the sidecar below because storageState() cannot carry it.
 */
export async function newSessionContext(browser) {
  const context = await browser.newContext({
    storageState: STATE_PATH,
    ignoreHTTPSErrors: true,
    viewport: config.viewport,
  });
  context.setDefaultNavigationTimeout(config.navigationTimeoutMs);
  await replaySessionStorage(context);
  return context;
}

// ---------------------------------------------------------------------------
// sessionStorage (Playwright's storageState() covers cookies + localStorage only)
// ---------------------------------------------------------------------------

/**
 * Persist the page's sessionStorage next to storageState.json.
 *
 * MSAL.js — and therefore most Microsoft Entra ID SPAs — defaults to `cacheLocation:
 * 'sessionStorage'`, which storageState() silently drops. Without this the saved "session"
 * replays a signed-out app and every check looks like an expired login.
 *
 * Always writes (or clears) the file, so a stale sidecar can never inject old tokens.
 */
export async function saveSessionStorage(page) {
  if (!config.captureSessionStorage) return 0;
  let entries = [];
  try {
    entries = await page.evaluate(() => Object.entries(window.sessionStorage));
  } catch {
    // A closed page or a document that forbids storage access — nothing to save.
  }
  if (entries.length === 0) {
    if (existsSync(SESSION_STORAGE_PATH)) rmSync(SESSION_STORAGE_PATH, { force: true });
    return 0;
  }
  const payload = { origin: new URL(page.url()).origin, entries };
  writeFileSync(SESSION_STORAGE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return entries.length;
}

/**
 * Names of the origin's IndexedDB databases, or [] if there are none / it can't be asked.
 *
 * Some auth SDKs keep their tokens in IndexedDB (Firebase Authentication is the common one),
 * and storageState() only includes it when explicitly asked. The sign-in uses this to point at
 * `captureIndexedDB` instead of leaving a saved session that replays as signed out.
 */
export async function listIndexedDBNames(page) {
  try {
    return await page.evaluate(async () => {
      if (typeof indexedDB?.databases !== 'function') return [];
      return (await indexedDB.databases()).map((db) => db.name).filter(Boolean);
    });
  } catch {
    return []; // storage access denied or the page is gone — nothing worth reporting.
  }
}

function readSessionStorage() {
  if (!config.captureSessionStorage || !existsSync(SESSION_STORAGE_PATH)) return null;
  try {
    const data = JSON.parse(readFileSync(SESSION_STORAGE_PATH, 'utf8'));
    if (!data?.origin || !Array.isArray(data.entries) || data.entries.length === 0) return null;
    return data;
  } catch {
    return null;
  }
}

async function replaySessionStorage(context) {
  const saved = readSessionStorage();
  if (!saved) return;
  // Runs before any page script on every navigation. Guarded by origin so a redirect to an
  // identity provider never receives the app's storage, and existing keys are left alone so
  // live values written by the app itself are not clobbered by stale ones.
  await context.addInitScript((data) => {
    if (window.location.origin !== data.origin) return;
    try {
      for (const [key, value] of data.entries) {
        if (window.sessionStorage.getItem(key) === null) window.sessionStorage.setItem(key, value);
      }
    } catch {
      // Storage disabled for this document; nothing useful to do.
    }
  }, saved);
}

/** Remove every artefact of the active profile's session. */
export function clearSession() {
  const removed = [];
  for (const path of [STATE_PATH, SESSION_STORAGE_PATH]) {
    if (existsSync(path)) {
      rmSync(path, { force: true });
      removed.push(path);
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Session age / expiry
// ---------------------------------------------------------------------------

function formatDuration(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes < 1) return `${Math.max(0, Math.round(ms / 1000))}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/**
 * Describe how old the saved session is and when its cookies run out, so "it worked five
 * minutes ago" has an answer other than guesswork.
 * Returns null when no session file exists.
 */
export function describeSession() {
  if (!existsSync(STATE_PATH)) return null;

  const ageMs = Date.now() - statSync(STATE_PATH).mtimeMs;
  const host = new URL(config.baseUrl).hostname;
  let expiresInMs = null;
  let expiredCount = 0;

  try {
    const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    const now = Date.now();
    const relevant = (state.cookies ?? []).filter((cookie) => {
      const domain = String(cookie.domain ?? '').replace(/^\./, '');
      return domain === host || host.endsWith(`.${domain}`);
    });
    // expires is seconds-since-epoch; -1 marks a browser-session cookie with no expiry.
    const expiries = relevant
      .map((cookie) => cookie.expires)
      .filter((value) => typeof value === 'number' && value > 0)
      .map((value) => value * 1000);
    expiredCount = expiries.filter((value) => value <= now).length;
    const future = expiries.filter((value) => value > now);
    if (future.length) expiresInMs = Math.min(...future) - now;
  } catch {
    // Unreadable state file: the age alone is still useful.
  }

  const parts = [`captured ${formatDuration(ageMs)} ago`];
  if (expiresInMs !== null) {
    parts.push(`earliest cookie expiry in ${formatDuration(expiresInMs)}`);
  } else if (expiredCount > 0) {
    parts.push(`${expiredCount} cookie(s) already expired`);
  } else {
    parts.push('no cookie expiry recorded (browser-session cookies)');
  }

  return {
    ageMs,
    expiresInMs,
    expiredCount,
    expiringSoon: expiresInMs !== null && expiresInMs < config.expiryWarningMs,
    text: parts.join(' · '),
  };
}

/**
 * Navigate, then let JS-rendered content settle.
 *
 * Deliberately NOT waitUntil:'networkidle' — an app holding a connection open (SignalR,
 * Blazor Server, websockets, long-polling, EventSource) never reaches network idle, so a
 * perfectly good session would time out and look like an auth failure.
 *
 * Nothing answering at all is an environment problem and exits 4 here. Any other failure — a
 * timeout, a redirect loop, an aborted load — is returned as `{ response: null, navigationError }`
 * so the caller can report it as inconclusive rather than crash or guess.
 */
export async function goto(page, url, { settle = true } = {}) {
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (settle) await page.waitForTimeout(config.settleTimeoutMs);
    return { response, navigationError: null };
  } catch (e) {
    if (/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_NAME_NOT_RESOLVED|ERR_EMPTY_RESPONSE|ERR_SSL|ERR_ADDRESS_UNREACHABLE/i.test(e.message)) {
      console.error(`Nothing answered at ${url}`);
      console.error(`Start ${config.appName} so it listens on ${config.baseUrl}, then try again.`);
      process.exit(EXIT.ENVIRONMENT);
    }
    if (e.name === 'TimeoutError') return { response: null, navigationError: 'timeout' };
    const code = e.message.match(/net::ERR_[A-Z_]+/)?.[0];
    if (code) return { response: null, navigationError: code };
    throw e;
  }
}

async function visible(locator) {
  try {
    // .first() keeps a selector that matches several elements from tripping strict mode.
    return await locator.first().isVisible();
  } catch {
    return false; // an invalid selector or a page that went away: not visible
  }
}

/**
 * Decide what the page we landed on proves about the session.
 * `loaded` is what goto() returned. Returns
 * { verdict: 'valid' | 'invalid' | 'inconclusive', evidence, status, finalUrl, reasons }.
 */
export async function assessSession(page, loaded) {
  const { response = null, navigationError = null } = loaded ?? {};
  let finalUrl;
  try {
    finalUrl = new URL(page.url());
  } catch {
    finalUrl = new URL(config.baseUrl);
  }
  const status = response?.status() ?? null;
  const check = async (setting, probe) => (setting == null || navigationError ? null : probe());
  const facts = {
    status,
    finalUrl,
    navigationError,
    authenticatedSelectorVisible: await check(config.authenticatedSelector,
      () => visible(page.locator(config.authenticatedSelector))),
    authenticatedTextVisible: await check(config.authenticatedText,
      () => visible(page.getByText(config.authenticatedText))),
    unauthenticatedSelectorVisible: await check(config.unauthenticatedSelector,
      () => visible(page.locator(config.unauthenticatedSelector))),
  };
  return { ...classify(facts, config), status, finalUrl };
}
