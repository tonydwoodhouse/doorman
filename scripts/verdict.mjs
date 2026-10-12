// What a page load proves about a saved session — and, as importantly, what it doesn't.
//
// Three outcomes, never two:
//
//   valid         explicit positive evidence (a configured authenticated signal was present), or —
//                 when none is configured — a 2xx response on the requested route with no failure
//                 signal. The second is the practical default, and is reported as weaker evidence.
//   invalid       explicit evidence of no session: the login page, the identity provider, leaving
//                 the app's origin, a configured unauthenticated status (401/403), a configured
//                 unauthenticated selector, or a 2xx page missing a configured authenticated signal.
//   inconclusive  anything that establishes neither: 404, 5xx, other non-2xx statuses, no response,
//                 a navigation that timed out or failed. Re-authenticating can't fix any of these,
//                 and calling them "valid" would be claiming something nobody checked.
//
// Pure on purpose — no browser, no config import — so every rule here is unit-tested directly.
// session.mjs gathers the facts from a real page and hands them to classify().

/** Verdicts, as stable strings for scripts and JSON output. */
export const VERDICT = Object.freeze({
  VALID: 'valid',
  INVALID: 'invalid',
  INCONCLUSIVE: 'inconclusive',
});

/**
 * Strip a base path from a pathname, so config regexes stay written app-relative.
 * @param {string} pathname
 * @param {string} basePath  '' or '/myapp' (no trailing slash)
 */
export function stripBase(pathname, basePath) {
  if (!basePath || !pathname.startsWith(basePath)) return pathname;
  const rest = pathname.slice(basePath.length);
  return rest.startsWith('/') ? rest : `/${rest}`;
}

/**
 * Classify one page load.
 *
 * @param {object} facts
 * @param {number|null} facts.status        final HTTP status, or null when there was no response
 * @param {URL|string} facts.finalUrl       where the browser ended up
 * @param {string|null} [facts.navigationError]  'timeout' or a short description when the load failed
 * @param {boolean|null} [facts.authenticatedSelectorVisible]   null when not configured / not checked
 * @param {boolean|null} [facts.authenticatedTextVisible]       null when not configured / not checked
 * @param {boolean|null} [facts.unauthenticatedSelectorVisible] null when not configured / not checked
 * @param {object} config  the resolved doorman config (origin, basePath, patterns, status codes)
 * @returns {{ verdict: string, evidence: 'explicit'|'status-only'|null, reasons: string[] }}
 */
export function classify(facts, config) {
  const finalUrl = facts.finalUrl instanceof URL ? facts.finalUrl : new URL(facts.finalUrl);
  const status = facts.status ?? null;
  const appPath = stripBase(finalUrl.pathname, config.basePath ?? '');
  const pathAndQuery = `${appPath}${finalUrl.search}`;

  // A load that never completed can't say anything about the session.
  if (facts.navigationError) {
    return {
      verdict: VERDICT.INCONCLUSIVE,
      evidence: null,
      reasons: [facts.navigationError === 'timeout'
        ? 'the page did not finish loading in time'
        : `the navigation failed (${facts.navigationError})`],
    };
  }

  // Conclusive evidence the session is not usable. Checked first: a login page that happens to
  // return 404 is still a login page.
  const invalid = [
    new RegExp(config.loginPathPattern, 'i').test(appPath) &&
      'redirected to the configured login page',
    config.idpHostPattern != null && new RegExp(config.idpHostPattern, 'i').test(finalUrl.host) &&
      'redirected to the configured identity-provider host',
    finalUrl.origin !== config.origin &&
      `landed outside the app origin (${finalUrl.origin})`,
    status !== null && (config.unauthenticatedStatusCodes ?? []).includes(status) &&
      `returned HTTP ${status}`,
    facts.unauthenticatedSelectorVisible === true &&
      `showed unauthenticatedSelector (${config.unauthenticatedSelector})`,
  ].filter(Boolean);
  if (invalid.length) return { verdict: VERDICT.INVALID, evidence: 'explicit', reasons: invalid };

  // Anything but a 2xx establishes neither validity nor invalidity. An error page won't carry the
  // authenticated signals either, and blaming that on authentication is what sends a developer
  // off to sign in again over a URL typo.
  if (status === null || status < 200 || status > 299) {
    return {
      verdict: VERDICT.INCONCLUSIVE,
      evidence: null,
      reasons: [status === null ? 'no HTTP response was received' : `returned HTTP ${status}`],
    };
  }

  // A 2xx page: the configured positive signals decide it.
  const configured = [];
  const missing = [];
  if (config.authenticatedUrlPattern != null) {
    configured.push('authenticatedUrlPattern');
    if (!new RegExp(config.authenticatedUrlPattern, 'i').test(pathAndQuery)) {
      missing.push(`did not match authenticatedUrlPattern (was ${pathAndQuery})`);
    }
  }
  if (config.authenticatedSelector != null) {
    configured.push('authenticatedSelector');
    if (facts.authenticatedSelectorVisible !== true) {
      missing.push(`did not show authenticatedSelector (${config.authenticatedSelector})`);
    }
  }
  if (config.authenticatedText != null) {
    configured.push('authenticatedText');
    if (facts.authenticatedTextVisible !== true) {
      missing.push(`did not show authenticatedText (${JSON.stringify(config.authenticatedText)})`);
    }
  }

  if (missing.length) return { verdict: VERDICT.INVALID, evidence: 'explicit', reasons: missing };
  if (configured.length) {
    return { verdict: VERDICT.VALID, evidence: 'explicit', reasons: configured.map((c) => `matched ${c}`) };
  }
  return {
    verdict: VERDICT.VALID,
    evidence: 'status-only',
    reasons: [`returned HTTP ${status} with no sign of a login page (no authenticated signal configured)`],
  };
}
