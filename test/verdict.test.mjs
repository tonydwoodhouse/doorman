// Unit tests for the verification rules (scripts/verdict.mjs): what each kind of page load proves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERDICT, classify, stripBase } from '../scripts/verdict.mjs';

const base = {
  origin: 'http://127.0.0.1:4000',
  basePath: '',
  loginPathPattern: '^/login',
  idpHostPattern: null,
  authenticatedUrlPattern: null,
  authenticatedSelector: null,
  authenticatedText: null,
  unauthenticatedSelector: null,
  unauthenticatedStatusCodes: [401, 403],
};
const at = (path) => `${base.origin}${path}`;
const verdictOf = (facts, config = base) => classify(facts, config).verdict;

test('200 on the requested route with no signal configured is valid, on status alone', () => {
  const result = classify({ status: 200, finalUrl: at('/dashboard') }, base);
  assert.equal(result.verdict, VERDICT.VALID);
  assert.equal(result.evidence, 'status-only');
});

test('any 2xx counts as a successful response', () => {
  assert.equal(verdictOf({ status: 204, finalUrl: at('/dashboard') }), VERDICT.VALID);
});

test('a redirect to the login page is invalid', () => {
  assert.equal(verdictOf({ status: 200, finalUrl: at('/login?returnUrl=%2Fdashboard') }), VERDICT.INVALID);
});

test('the login page is invalid even when it answers 404', () => {
  assert.equal(verdictOf({ status: 404, finalUrl: at('/Login') }), VERDICT.INVALID);
});

test('401 and 403 are invalid', () => {
  assert.equal(verdictOf({ status: 401, finalUrl: at('/api/me') }), VERDICT.INVALID);
  assert.equal(verdictOf({ status: 403, finalUrl: at('/admin') }), VERDICT.INVALID);
});

test('404 and 500 are inconclusive, never valid', () => {
  for (const status of [404, 500, 502, 503]) {
    const result = classify({ status, finalUrl: at('/missing') }, base);
    assert.equal(result.verdict, VERDICT.INCONCLUSIVE, `HTTP ${status}`);
    assert.match(result.reasons[0], new RegExp(`HTTP ${status}`));
  }
});

test('other non-2xx statuses (e.g. 304, 418) are inconclusive', () => {
  assert.equal(verdictOf({ status: 304, finalUrl: at('/dashboard') }), VERDICT.INCONCLUSIVE);
  assert.equal(verdictOf({ status: 418, finalUrl: at('/dashboard') }), VERDICT.INCONCLUSIVE);
});

test('a timeout or failed navigation is inconclusive', () => {
  assert.equal(verdictOf({ status: null, finalUrl: at('/slow'), navigationError: 'timeout' }), VERDICT.INCONCLUSIVE);
  assert.equal(verdictOf({ status: null, finalUrl: at('/loop'), navigationError: 'net::ERR_TOO_MANY_REDIRECTS' }),
    VERDICT.INCONCLUSIVE);
});

test('no response at all is inconclusive', () => {
  assert.equal(verdictOf({ status: null, finalUrl: at('/dashboard') }), VERDICT.INCONCLUSIVE);
});

test('a 401 status configured away is no longer treated as invalid', () => {
  const config = { ...base, unauthenticatedStatusCodes: [403] };
  assert.equal(verdictOf({ status: 401, finalUrl: at('/api/me') }, config), VERDICT.INCONCLUSIVE);
});

test('landing on another origin is invalid', () => {
  assert.equal(verdictOf({ status: 200, finalUrl: 'https://login.example.com/authorize' }), VERDICT.INVALID);
});

test('the identity provider host is invalid', () => {
  const config = { ...base, idpHostPattern: 'login\\.microsoftonline\\.com$' };
  const result = classify({ status: 200, finalUrl: 'https://login.microsoftonline.com/x' }, config);
  assert.equal(result.verdict, VERDICT.INVALID);
  assert.ok(result.reasons.some((r) => /identity-provider/.test(r)));
});

test('SPA shell: 200 with a visible sign-in component is invalid when unauthenticatedSelector is set', () => {
  const config = { ...base, unauthenticatedSelector: '[data-testid=login-form]' };
  const facts = { status: 200, finalUrl: at('/spa'), unauthenticatedSelectorVisible: true };
  assert.equal(verdictOf(facts, config), VERDICT.INVALID);
});

test('SPA shell: 200 without the authenticated selector is invalid when one is configured', () => {
  const config = { ...base, authenticatedSelector: '[data-testid=account-menu]' };
  const facts = { status: 200, finalUrl: at('/spa'), authenticatedSelectorVisible: false };
  assert.equal(verdictOf(facts, config), VERDICT.INVALID);
});

test('a configured authenticated signal that is present gives explicit evidence', () => {
  const config = { ...base, authenticatedSelector: '#me', authenticatedText: 'Sign out' };
  const result = classify({
    status: 200, finalUrl: at('/dashboard'), authenticatedSelectorVisible: true, authenticatedTextVisible: true,
  }, config);
  assert.equal(result.verdict, VERDICT.VALID);
  assert.equal(result.evidence, 'explicit');
});

test('every configured positive signal must be present', () => {
  const config = { ...base, authenticatedSelector: '#me', authenticatedText: 'Sign out' };
  const result = classify({
    status: 200, finalUrl: at('/dashboard'), authenticatedSelectorVisible: true, authenticatedTextVisible: false,
  }, config);
  assert.equal(result.verdict, VERDICT.INVALID);
  assert.match(result.reasons.join(), /authenticatedText/);
});

test('authenticatedUrlPattern is matched against the app-relative path and query', () => {
  const config = { ...base, basePath: '/app', authenticatedUrlPattern: '^/dashboard' };
  assert.equal(verdictOf({ status: 200, finalUrl: at('/app/dashboard?x=1') }, config), VERDICT.VALID);
  assert.equal(verdictOf({ status: 200, finalUrl: at('/app/welcome') }, config), VERDICT.INVALID);
});

test('the login pattern is matched beneath a base path', () => {
  const config = { ...base, basePath: '/app' };
  assert.equal(verdictOf({ status: 200, finalUrl: at('/app/Login') }, config), VERDICT.INVALID);
});

test('an error status is inconclusive even when a positive signal is missing', () => {
  const config = { ...base, authenticatedSelector: '#me' };
  assert.equal(verdictOf({ status: 500, finalUrl: at('/boom'), authenticatedSelectorVisible: false }, config),
    VERDICT.INCONCLUSIVE);
});

test('stripBase', () => {
  assert.equal(stripBase('/app/x', '/app'), '/x');
  assert.equal(stripBase('/app', '/app'), '/');
  assert.equal(stripBase('/other', '/app'), '/other');
  assert.equal(stripBase('/x', ''), '/x');
});
