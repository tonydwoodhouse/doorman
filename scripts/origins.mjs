// Which sites a captured session holds data for, and which of them to keep.
//
// A sign-in can touch more than the app: an identity provider almost always, sometimes an
// analytics or support widget. The snapshot comes from a fresh browser context, so it never holds
// unrelated personal browsing, but it does hold whatever the sign-in flow itself set. This module
// trims that to `captureOrigins` and describes what is kept, by host and count only. Values are
// never returned, so nothing here can print a cookie or a token.
//
// Pure: no I/O and no config import, so it is unit-tested directly.

/** Normalize one captureOrigins entry to a lowercase hostname, keeping a leading "*.". */
export function allowEntryHost(entry) {
  const text = entry.trim().toLowerCase();
  if (text.startsWith('*.')) return text;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(text)) return new URL(text).hostname;
  return text.replace(/:\d+$/, '');
}

/** Does `host` fall under the allow entry `entry` (a hostname or "*.suffix")? */
function hostMatches(host, entry) {
  if (entry.startsWith('*.')) {
    const suffix = entry.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === entry;
}

/**
 * Would the browser send a cookie set for `domain` to a host the allowlist names? Playwright
 * writes a domain cookie as ".example.com" and a host-only cookie as "example.com".
 * A cookie on a parent domain counts, since the browser sends it to the allowed host regardless.
 */
function cookieAllowed(domain, entries) {
  const d = domain.replace(/^\./, '').toLowerCase();
  return entries.some((entry) => {
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(2);
      return d === suffix || d.endsWith(`.${suffix}`) || suffix.endsWith(`.${d}`);
    }
    return entry === d || entry.endsWith(`.${d}`);
  });
}

/**
 * Apply captureOrigins to a Playwright storage state. "flow" keeps everything the sign-in set;
 * an array keeps only those hosts, plus `appHost`, without which the session would be useless.
 * Returns { state, dropped } where dropped is a summary (see summarizeState) of what was removed.
 */
export function filterState(state, captureOrigins, appHost) {
  if (captureOrigins === 'flow') return { state, dropped: [] };
  const entries = [...captureOrigins.map(allowEntryHost), appHost.toLowerCase()];
  const keptCookies = [];
  const droppedCookies = [];
  for (const cookie of state.cookies ?? []) {
    (cookieAllowed(cookie.domain, entries) ? keptCookies : droppedCookies).push(cookie);
  }
  const keptOrigins = [];
  const droppedOrigins = [];
  for (const entry of state.origins ?? []) {
    const host = new URL(entry.origin).hostname.toLowerCase();
    (entries.some((allowed) => hostMatches(host, allowed)) ? keptOrigins : droppedOrigins).push(entry);
  }
  return {
    state: { ...state, cookies: keptCookies, origins: keptOrigins },
    dropped: summarizeState({ cookies: droppedCookies, origins: droppedOrigins }),
  };
}

/**
 * Per-host counts for a storage state: [{ host, cookies, localStorageKeys, indexedDB }], in the
 * order hosts first appear. Never includes a value.
 */
export function summarizeState(state) {
  const byHost = new Map();
  const row = (host) => {
    if (!byHost.has(host)) byHost.set(host, { host, cookies: 0, localStorageKeys: 0, indexedDB: 0 });
    return byHost.get(host);
  };
  for (const cookie of state.cookies ?? []) row(cookie.domain.replace(/^\./, '').toLowerCase()).cookies++;
  for (const entry of state.origins ?? []) {
    const r = row(new URL(entry.origin).hostname.toLowerCase());
    r.localStorageKeys += entry.localStorage?.length ?? 0;
    r.indexedDB += entry.indexedDB?.length ?? 0;
  }
  return [...byHost.values()];
}

/** "2 cookies, 3 localStorage keys" for one summary row. */
export function describeRow(r) {
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const parts = [];
  if (r.cookies) parts.push(plural(r.cookies, 'cookie'));
  if (r.localStorageKeys) parts.push(plural(r.localStorageKeys, 'localStorage key'));
  if (r.indexedDB) parts.push(plural(r.indexedDB, 'IndexedDB database'));
  return parts.join(', ') || 'nothing';
}

const related = (a, b) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);

/**
 * Notes worth showing the developer about what was saved:
 * - a host that is neither the app nor a configured identity provider, and
 * - cookies scoped to a parent of the app's host, which every sibling site receives too.
 */
export function originWarnings(summary, { appHost, idpHostPattern = null }) {
  const app = appHost.toLowerCase();
  const idp = idpHostPattern ? new RegExp(idpHostPattern, 'i') : null;
  const notes = [];
  for (const r of summary) {
    if (r.host !== app && app.endsWith(`.${r.host}`) && r.cookies > 0) {
      notes.push(`Cookies scoped to ${r.host} are sent to every *.${r.host} site, not just ${app}.`);
    } else if (!related(r.host, app) && !(idp && idp.test(r.host))) {
      notes.push(`Also saved: ${r.host} (${describeRow(r)}). Expected if it's your identity provider` +
        ' (set idpHostPattern to say so); otherwise list the hosts you expect in captureOrigins.');
    }
  }
  return notes;
}
