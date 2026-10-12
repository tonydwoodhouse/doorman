// A tiny app with a sign-in wall, for exercising doorman end to end.
//
// Each route models one way real apps behave, so the test suite can prove what doorman does with
// it rather than claiming it in prose:
//
//   /login            forms login. With autoLogin the page submits itself, standing in for the
//                     human so the "interactive" capture can run unattended.
//   /dashboard        server-rendered, cookie session; 302 to /login without one
//   /api/me           401 without a session
//   /admin            403 for every user (signed in or not)
//   /missing          404
//   /boom             500
//   /slow             never answers (timeouts)
//   /spa              200 for everyone; renders a sign-in component client-side when signed out
//   /ls/*, /ss/*      tokens kept in localStorage / sessionStorage instead of a cookie
//   /idb/*            token kept in IndexedDB
//   /idp-login        sends the browser to a separate identity-provider origin and back
//
// Usage as a module: `const app = await startApp({ autoLogin: true })` -> { origin, idpOrigin,
// close(), sessions }. Usage as a CLI: `node app.mjs [--port N] [--auto-login]`.
import { createServer } from 'http';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import { resolve } from 'path';

const page = (title, body, script = '') => `<!doctype html><html><head><meta charset="utf-8">
<title>${title}</title></head><body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((p) => p.trim().split('=')).filter(([k]) => k));
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) data += chunk;
  return new URLSearchParams(data);
}

function listen(server, port) {
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => done(server.address().port));
  });
}

/**
 * Start the app (and its identity provider on a second origin).
 * @param {{ port?: number, idpPort?: number, autoLogin?: boolean, sessionTtlSeconds?: number }} options
 */
export async function startApp({ port = 0, idpPort = 0, autoLogin = false, sessionTtlSeconds = 3600 } = {}) {
  const sessions = new Map(); // sid -> expiry (ms)
  const tokens = new Set();   // bearer tokens for the storage-based routes
  const idpCodes = new Set();
  let origin;
  let idpOrigin;

  const valid = (req) => {
    const sid = parseCookies(req.headers.cookie).sid;
    const expiry = sid && sessions.get(sid);
    return Boolean(expiry && expiry > Date.now());
  };
  const newSession = (res, location) => {
    const sid = randomBytes(12).toString('hex');
    sessions.set(sid, Date.now() + sessionTtlSeconds * 1000);
    res.writeHead(302, {
      'Set-Cookie': `sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${sessionTtlSeconds}`,
      Location: location,
    });
    res.end();
  };
  const html = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  };
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const auto = (selector) => (autoLogin ? `setTimeout(() => document.querySelector('${selector}').click(), 300);` : '');

  // Client-side check for the storage-based routes: ask the server whether the token is good.
  const storageApp = (store, key) => page('App', '<div id="root">loading</div>', `
    (async () => {
      let token = null;
      try { token = await (${store}); } catch {}
      const ok = token && (await fetch('/api/token?t=' + encodeURIComponent(token))).ok;
      document.getElementById('root').innerHTML = ok
        ? '<a data-testid="account-menu" href="#">Sign out</a> signed in'
        : '<form data-testid="login-form">Please sign in</form>';
    })();`);
  const idbGet = `new Promise((ok, no) => { const r = indexedDB.open('auth', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('token');
        g.onsuccess = () => ok(g.result ?? null); g.onerror = no; }; r.onerror = no; })`;
  const idbPut = (token) => `new Promise((ok) => { const r = indexedDB.open('auth', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => { const t = r.result.transaction('kv', 'readwrite');
        t.objectStore('kv').put('${token}', 'token'); t.oncomplete = ok; }; })`;

  const app = createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    const path = url.pathname;

    if (path === '/login' && req.method === 'GET') {
      return html(res, 200, page('Sign in', `<form method="post" action="/login">
        <input name="user" value="dev"><button id="go" type="submit">Sign in</button></form>`, auto('#go')));
    }
    if (path === '/login' && req.method === 'POST') {
      await readBody(req);
      return newSession(res, '/dashboard');
    }
    if (path === '/dashboard') {
      if (!valid(req)) {
        res.writeHead(302, { Location: `/login?returnUrl=${encodeURIComponent(path)}` });
        return res.end();
      }
      return html(res, 200, page('Dashboard', '<a data-testid="account-menu" href="/logout">Sign out</a><h1>Dashboard</h1>'));
    }
    if (path === '/api/me') return valid(req) ? json(res, 200, { user: 'dev' }) : json(res, 401, { error: 'unauthenticated' });
    if (path === '/admin') return html(res, 403, page('Forbidden', 'Forbidden'));
    if (path === '/missing') return html(res, 404, page('Not found', 'Not found'));
    if (path === '/boom') return html(res, 500, page('Error', 'Server error'));
    if (path === '/slow') return; // never answer
    if (path === '/spa') {
      return html(res, 200, page('SPA', '<div id="root">loading</div>', `
        fetch('/api/me').then((r) => {
          document.getElementById('root').innerHTML = r.ok
            ? '<a data-testid="account-menu" href="#">Sign out</a>'
            : '<form data-testid="login-form">Please sign in</form>';
        });`));
    }

    // Token-in-browser-storage apps. The login page stores a token and moves on.
    const storage = { ls: ['localStorage', 'localStorage.getItem("token")'],
      ss: ['sessionStorage', 'sessionStorage.getItem("token")'], idb: ['indexedDB', idbGet] };
    const [kind, sub] = path.split('/').filter(Boolean);
    if (storage[kind] && sub === 'login') {
      const token = randomBytes(12).toString('hex');
      tokens.add(token);
      const store = kind === 'idb' ? idbPut(token) : `Promise.resolve(${storage[kind][0]}.setItem('token', '${token}'))`;
      return html(res, 200, page('Sign in', `<button id="go">Sign in</button>`, `
        document.getElementById('go').onclick = async () => { await ${store}; location.href = '/${kind}/app'; };
        ${auto('#go')}`));
    }
    if (storage[kind] && sub === 'app') return html(res, 200, storageApp(storage[kind][1], kind));
    if (path === '/api/token') return tokens.has(url.searchParams.get('t')) ? json(res, 200, {}) : json(res, 401, {});

    // A separate identity-provider origin, as with OAuth/OIDC/SAML.
    if (path === '/idp-login') {
      res.writeHead(302, { Location: `${idpOrigin}/authorize?redirect=${encodeURIComponent(`${origin}/callback`)}` });
      return res.end();
    }
    if (path === '/callback') {
      if (!idpCodes.delete(url.searchParams.get('code'))) return html(res, 400, page('Bad code', 'Bad code'));
      return newSession(res, '/dashboard');
    }

    if (path === '/') return html(res, 200, page('Home', '<h1>Welcome</h1><a href="/dashboard">Dashboard</a>'));
    return html(res, 404, page('Not found', 'Not found'));
  });

  const idp = createServer((req, res) => {
    const url = new URL(req.url, idpOrigin);
    if (url.pathname === '/authorize' && req.method === 'GET') {
      const redirect = url.searchParams.get('redirect') ?? '';
      return html(res, 200, page('IdP', `<form method="post" action="/authorize?redirect=${encodeURIComponent(redirect)}">
        <button id="go" type="submit">Approve</button></form>`, auto('#go')));
    }
    if (url.pathname === '/authorize' && req.method === 'POST') {
      const code = randomBytes(8).toString('hex');
      idpCodes.add(code);
      res.writeHead(302, {
        'Set-Cookie': 'idp_session=idp-secret; HttpOnly; Path=/; Max-Age=3600',
        Location: `${url.searchParams.get('redirect')}?code=${code}`,
      });
      return res.end();
    }
    return html(res, 404, page('Not found', 'Not found'));
  });

  // 127.0.0.1 and localhost are different origins to a browser, so the IdP really is cross-origin.
  origin = `http://127.0.0.1:${await listen(app, port)}`;
  idpOrigin = `http://localhost:${await listen(idp, idpPort)}`;

  return {
    origin,
    idpOrigin,
    sessions,
    /** Invalidate every server-side session, as an expiry or a server restart would. */
    expireAll() { sessions.clear(); tokens.clear(); },
    close() {
      app.closeAllConnections?.();
      idp.closeAllConnections?.();
      return Promise.all([new Promise((d) => app.close(d)), new Promise((d) => idp.close(d))]);
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const portArg = args.find((a) => a.startsWith('--port='));
  const app = await startApp({
    port: portArg ? Number(portArg.slice(7)) : Number(process.env.PORT ?? 0),
    autoLogin: args.includes('--auto-login'),
  });
  console.log(`app ${app.origin}  idp ${app.idpOrigin}`);
}
