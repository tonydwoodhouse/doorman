// Shared configuration + CLI argument handling for the doorman toolkit.
//
// Precedence (later wins): built-in DEFAULTS < doorman.config.json < environment variable < flag.
// The only per-project file you should need to edit is doorman.config.json.
//
// A bad configuration exits 4 (environment), never 1 — telling an agent "your session expired"
// because of a typo in a regex would send it off asking the developer to sign in again.
//
// Where the config and the session files actually live depends on whether this is a plugin install
// or a vendored one; paths.mjs settles that, and everything here works from its answer.
import { isAbsolute, join, relative } from 'path';
import { existsSync, readFileSync } from 'fs';
import {
  CONFIG_EXISTS, CONFIG_PATH, OUTPUT_DIR as OUT_DIR, PLUGIN_MODE, PROJECT_DIR, SESSION_DIR,
  ensureDir, noteProjectPath,
} from './paths.mjs';

// Absolute paths in every validation message would be noise; a path relative to the project is
// enough to open the file, and still unambiguous when the config lives outside the project.
const rel = relative(PROJECT_DIR, CONFIG_PATH);
const configLabel = !rel || rel.startsWith('..') || isAbsolute(rel) ? CONFIG_PATH : rel;

// Exit codes are the contract with CLAUDE.md and the get-past-login skill. Keep them stable.
// Defined here (the lowest layer) so configuration failures can use them too; session.mjs
// re-exports them for convenience.
export const EXIT = {
  OK: 0,
  UNAUTHENTICATED: 1,  // a session exists but no longer works -> node login-once.mjs
  NO_SESSION: 2,       // nothing captured yet                 -> node login-once.mjs
  BAD_ROUTE: 3,        // session is fine, the route is not (404/500/...) -> fix the URL
  ENVIRONMENT: 4,      // dev server down, Chromium missing, bad config/argument -> not auth
  LOGIN_INCOMPLETE: 5, // login-once.mjs: the sign-in was never finished
};

/** Print a clean message (no stack trace) and exit as an environment problem. */
function fail(message, ...hints) {
  console.error(message);
  for (const hint of hints.flat()) console.error(hint);
  process.exit(EXIT.ENVIRONMENT);
}

// Sensible fallbacks. Everything here is overridable in doorman.config.json.
const DEFAULTS = {
  // Absent means configured, which is the normal case — detect.mjs fills the config in and only
  // writes "configured": false when it found nothing, so that failure keeps stopping every
  // script with instructions instead of testing some plausible default URL.
  configured: true,
  // Human-friendly name, used only in console messages.
  appName: 'the app',
  // Root URL the dev server listens on. May include a base path for apps hosted under a
  // sub-path (e.g. https://localhost:5001/myapp) — paths are then resolved beneath it.
  baseUrl: 'https://localhost:5001',
  // Path (relative to baseUrl) that kicks off the interactive sign-in.
  loginPath: '/Login',
  // Case-insensitive regex matched against the URL *pathname* to detect the login page.
  // Matched after any base path is stripped, so '^/login' works for /myapp/Login too.
  loginPathPattern: '^/login',
  // Optional case-insensitive regex matched against the URL *host* to detect an external
  // identity provider. Set this only when the provider has a known host pattern.
  idpHostPattern: null,
  // Optional case-insensitive regex matched against the final app pathname + query string.
  // Use it when a specific post-login route proves the session is established.
  authenticatedUrlPattern: null,
  // Optional Playwright selector that must be visible after login/check. Use an element that
  // exists only for an authenticated user, such as a profile menu or sign-out control.
  authenticatedSelector: null,
  // HTTP statuses that conclusively indicate the session cannot access the requested route.
  unauthenticatedStatusCodes: [401, 403],
  // Default gated route auth-check.mjs verifies when no path arg is passed.
  defaultCheckPath: '/',
  // Browser viewport for every script.
  viewport: { width: 1400, height: 900 },
  // How long login-once.mjs waits for you to finish sign-in + MFA (ms).
  loginTimeoutMs: 300000,
  // Grace period for JS-rendered content to settle before screenshotting (ms).
  settleTimeoutMs: 1500,
  // Also capture/replay sessionStorage. Playwright's storageState() covers cookies and
  // localStorage only, so MSAL.js / Entra ID SPAs (which default to sessionStorage) would
  // otherwise appear signed out on every headless run.
  captureSessionStorage: true,
  // Also capture/replay IndexedDB. Needed for SDKs that keep their tokens there — Firebase
  // Authentication is the common one. Off by default because it snapshots *all* of the
  // origin's IndexedDB, which for an app that caches data there can be large; the sign-in
  // tells you when the app has databases and this is switched off.
  captureIndexedDB: false,
  // Warn when the session's earliest cookie expiry is closer than this (ms).
  expiryWarningMs: 900000,
};

// ---------------------------------------------------------------------------
// CLI arguments (shared so every script accepts --profile the same way)
// ---------------------------------------------------------------------------

// Flags that may be written as `--flag value` as well as `--flag=value`.
const VALUE_FLAGS = new Set(['profile', 'wait', 'out']);

function parseArgs(argv) {
  const parsedFlags = {};
  const parsedPositionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      parsedPositionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      parsedFlags[body.slice(0, eq)] = body.slice(eq + 1);
    } else if (VALUE_FLAGS.has(body) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      parsedFlags[body] = argv[++i];
    } else {
      parsedFlags[body] = true;
    }
  }
  return { flags: parsedFlags, positionals: parsedPositionals };
}

const parsed = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// Profile (one saved session per role: default, admin, readonly, ...)
// ---------------------------------------------------------------------------

const rawProfile = parsed.flags.profile ?? process.env.DOORMAN_PROFILE ?? 'default';
if (rawProfile === true) {
  fail('--profile needs a name, e.g. --profile=admin');
}
if (!/^[a-z0-9][a-z0-9._-]{0,39}$/i.test(rawProfile) || rawProfile.includes('..')) {
  fail(
    `Invalid profile name: ${rawProfile}`,
    'Use letters, digits, dot, dash or underscore (max 40 chars), e.g. --profile=admin',
  );
}
const profileName = rawProfile;
// The default profile keeps the original filenames, so existing setups are untouched.
const stateSuffix = profileName === 'default' ? '' : `.${profileName}`;

// ---------------------------------------------------------------------------
// Configuration file
// ---------------------------------------------------------------------------

function loadFile() {
  if (!CONFIG_EXISTS) {
    // DOORMAN_BASE_URL alone is a supported way to run without a file at all, so only stop when
    // there is genuinely nothing to go on. Otherwise every script would test the placeholder URL.
    if (process.env.DOORMAN_BASE_URL) return {};
    fail(
      `No doorman configuration for this project yet (expected ${CONFIG_PATH}).`,
      'Run:  node detect.mjs --write     (finds baseUrl in this project\'s own files and creates it)',
      PLUGIN_MODE ? 'Or ask Claude to set up doorman for this project.' : [],
    );
  }
  try {
    const parsedJson = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    if (parsedJson === null || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
      fail(`${configLabel} must contain a JSON object.`);
    }
    return parsedJson;
  } catch (e) {
    if (e instanceof SyntaxError) {
      fail(`Could not parse ${configLabel}: ${e.message}`, 'Fix the JSON syntax and try again.');
    }
    throw e;
  }
}

const cfg = { ...DEFAULTS, ...loadFile() };

// Env override for one-off runs / CI without editing the file.
cfg.baseUrl = process.env.DOORMAN_BASE_URL ?? cfg.baseUrl;

requireConfigured(cfg);
validateConfig(cfg);

// Base path support: baseUrl may carry a path (https://host/myapp) for apps hosted under a
// sub-path. Everything else in the toolkit resolves beneath it.
const parsedBaseUrl = new URL(cfg.baseUrl);
cfg.origin = parsedBaseUrl.origin;
cfg.basePath = parsedBaseUrl.pathname.replace(/\/+$/, '');

/**
 * Resolve an app-relative path beneath the configured base path.
 * Already-prefixed paths are left alone, so both /dashboard and /myapp/dashboard work.
 */
export function joinBasePath(pathAndQuery) {
  if (!cfg.basePath) return pathAndQuery;
  if (pathAndQuery === cfg.basePath || pathAndQuery.startsWith(`${cfg.basePath}/`)) return pathAndQuery;
  return `${cfg.basePath}${pathAndQuery.startsWith('/') ? '' : '/'}${pathAndQuery}`;
}

/** Remove the base path from a pathname, so config regexes stay written app-relative. */
export function stripBasePath(pathname) {
  if (!cfg.basePath || !pathname.startsWith(cfg.basePath)) return pathname;
  const rest = pathname.slice(cfg.basePath.length);
  return rest.startsWith('/') ? rest : `/${rest}`;
}

function requireConfigured(value) {
  if (value.configured !== false) return;
  fail(
    `${configLabel} has not been configured for this project yet.`,
    'Try:  node detect.mjs --write     (finds baseUrl in this project\'s own files)',
    'It clears this message when it succeeds. Otherwise set these by hand and remove',
    'the "configured": false line:',
    '  baseUrl           URL the dev server listens on (e.g. https://localhost:5001)',
    '  loginPath         path that starts the interactive sign-in (e.g. /Login)',
    '  defaultCheckPath  a gated route that requires a signed-in user',
    'The URL is usually in Properties/launchSettings.json (ASP.NET), .vscode/launch.json,',
    'vite.config.*, angular.json, next.config.*, docker-compose.yml, or the project README.',
  );
}

function validateConfig(value) {
  validateUrl(value.baseUrl, 'baseUrl');
  validatePath(value.loginPath, 'loginPath');
  validatePath(value.defaultCheckPath, 'defaultCheckPath');
  validatePattern(value.loginPathPattern, 'loginPathPattern', false);
  validatePattern(value.idpHostPattern, 'idpHostPattern', true);
  validatePattern(value.authenticatedUrlPattern, 'authenticatedUrlPattern', true);
  validateOptionalString(value.authenticatedSelector, 'authenticatedSelector');
  validateViewport(value.viewport);
  validatePositiveNumber(value.loginTimeoutMs, 'loginTimeoutMs');
  validatePositiveNumber(value.settleTimeoutMs, 'settleTimeoutMs');
  validatePositiveNumber(value.expiryWarningMs, 'expiryWarningMs');
  validateBoolean(value.captureSessionStorage, 'captureSessionStorage');
  validateBoolean(value.captureIndexedDB, 'captureIndexedDB');
  validateBoolean(value.configured, 'configured');

  if (!Array.isArray(value.unauthenticatedStatusCodes) ||
      value.unauthenticatedStatusCodes.some((status) => !Number.isInteger(status) || status < 100 || status > 599)) {
    fail(`${configLabel}: unauthenticatedStatusCodes must be an array of HTTP status codes.`);
  }
}

function validateUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${configLabel}: ${name} must be an absolute URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail(`${configLabel}: ${name} must be an http:// or https:// URL.`);
  }
}

function validatePath(value, name) {
  if (typeof value !== 'string' || !value.startsWith('/')) {
    fail(`${configLabel}: ${name} must be a path starting with "/".`);
  }
}

function validatePattern(value, name, optional) {
  if (value === null && optional) return;
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${configLabel}: ${name} must be ${optional ? 'null or ' : ''}a non-empty regular expression string.`);
  }
  try {
    new RegExp(value, 'i');
  } catch (e) {
    fail(`${configLabel}: ${name} is not a valid regular expression: ${e.message}`);
  }
}

function validateOptionalString(value, name) {
  if (value !== null && (typeof value !== 'string' || value.length === 0)) {
    fail(`${configLabel}: ${name} must be null or a non-empty selector string.`);
  }
}

function validateViewport(value) {
  if (!value || !Number.isInteger(value.width) || value.width <= 0 ||
      !Number.isInteger(value.height) || value.height <= 0) {
    fail(`${configLabel}: viewport must contain positive integer width and height values.`);
  }
}

function validatePositiveNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(`${configLabel}: ${name} must be a non-negative number.`);
  }
}

function validateBoolean(value, name) {
  if (typeof value !== 'boolean') {
    fail(`${configLabel}: ${name} must be true or false.`);
  }
}

/** The exact command to run one of the toolkit scripts under the active profile. */
export function command(script) {
  return profileName === 'default' ? `node ${script}` : `node ${script} --profile=${profileName}`;
}

export const config = cfg;
export const flags = parsed.flags;
export const positionals = parsed.positionals;
export const profile = profileName;

// Created up front so a capture or a screenshot never fails on a missing directory. Vendored, these
// already exist (they are the script directory); under the plugin they are made on first use.
export const OUTPUT_DIR = ensureDir(OUT_DIR);
export const SESSION_PATH_DIR = ensureDir(SESSION_DIR);
noteProjectPath();

export const STATE_PATH = join(SESSION_DIR, `storageState${stateSuffix}.json`);
// Companion file: Playwright's storageState() drops sessionStorage, which MSAL/Entra SPAs use.
export const SESSION_STORAGE_PATH = join(SESSION_DIR, `sessionStorage${stateSuffix}.json`);
/** Suffix for per-profile output files, e.g. auth-check.admin.png. */
export const OUTPUT_SUFFIX = stateSuffix;
/** Re-exported so a custom script can report where things are without a second import. */
export { CONFIG_PATH, PLUGIN_MODE, PROJECT_DIR };
