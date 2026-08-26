# doorman — the runtime

The scripts that get a browser past a sign-in wall and keep it there. Small and config-driven:
nothing in this folder is edited per project. It supports forms login, OAuth/OIDC, SAML, enterprise
SSO, Microsoft Entra ID, and other authentication systems that leave an authenticated session
cookie or browser storage behind.

This toolkit gets you past that **without automating the login** (which is impractical to script
and would mean handling passwords/MFA). Instead you sign in **once** in a real browser window,
your authenticated session is saved to `storageState.json`, and every later headless run
**replays** it — until it expires (~4–8h), when you sign in again.

> `storageState.json` (and `sessionStorage.json`, when your app uses it) contain a live session.
> They are personal to you, and anyone holding them is signed in as you. Never commit or share
> them. As a plugin they are kept outside your project entirely; vendored, they sit in this folder
> and the shipped `.gitignore` keeps them out of source control.

## Where the files live

There are two ways to run this, and they differ only in where things are kept:

| | Claude Code / Codex plugin | Vendored (`tools/doorman/`) |
|---|---|---|
| scripts | in the installed plugin | committed in your repo |
| config | `<project>/.claude/doorman/doorman.config.json` | `doorman.config.json` beside the scripts |
| session files | the host's plugin data directory, outside the project | beside the scripts, gitignored |
| screenshots | the host's plugin data directory | beside the scripts, gitignored |
| Playwright | installed once per machine | `node_modules` per project |

```bash
node paths.mjs      # prints every one of those, resolved, for the project you're standing in
```

`paths.mjs` decides which mode it's in from its own location — a full checkout of this repo has
`integrations/claude/.claude-plugin/plugin.json` or `integrations/codex/.codex-plugin/plugin.json`
one directory up, and the installer never copies `integrations/` — so a vendored install behaves
the same however it is invoked. Data directory resolution accepts `DOORMAN_DATA_DIR`, Codex's own
`PLUGIN_DATA`, and Claude Code's `CLAUDE_PLUGIN_DATA`, in that order. Every location can also be
overridden directly: `DOORMAN_CONFIG`, `DOORMAN_SESSION_DIR`, `DOORMAN_OUTPUT_DIR`,
`DOORMAN_DEPS_DIR`, `DOORMAN_PROJECT_DIR`.

Vendored, run the commands **from this folder**. As a plugin, run them from anywhere inside the
project (it is found from the working directory) using the plugin's path — Claude Code:
`node "$CLAUDE_PLUGIN_ROOT/../../scripts/ensure.mjs"`; Codex: `node "$PLUGIN_ROOT/../../scripts/ensure.mjs"`.
The examples below use the short form.

## Does this work with my app?

Almost certainly. The toolkit only ever talks to your app the way a browser does, so **nothing in
it knows or cares what the server is written in** — ASP.NET, Django, Flask, FastAPI, Rails,
Express, Next.js, Laravel, Spring, or a static SPA against an API all behave identically. Three
requirements:

1. The app is reachable over HTTP(S) at a URL you can put in `baseUrl`.
2. Signing in happens **in a browser** — a login form, OAuth/OIDC redirect, SAML, enterprise SSO.
3. The result is kept **in browser storage** — a cookie, `localStorage`, `sessionStorage` or
   IndexedDB (see the table below).

Node 20+ is needed to run *the toolkit*, not to build your app. Its one dependency (Playwright) is
installed in its own tree and is never a dependency of the app under test. The placeholder config
values (`https://localhost:5001`, `/Login`) are ASP.NET-shaped and nothing more — `node detect.mjs
--write` replaces them with your project's real URL (see below).

What genuinely doesn't work, because none of it leaves anything in browser storage to replay:

| Auth style | Why not |
|---|---|
| HTTP Basic / Digest | A browser-level credential prompt, not storage. Playwright can do this via `httpCredentials`; the toolkit doesn't set it. |
| Windows Integrated / NTLM / Kerberos | Negotiated per connection, nothing persisted. |
| Client certificates / mTLS | Needs Playwright's `clientCertificates` option. |
| Tokens held only in memory | MSAL `cacheLocation: 'memory'`, or a token in a JS variable — there is nothing on disk to save. |

Passkeys/WebAuthn are fine in the normal case: what gets replayed is the session cookie the passkey
sign-in produces, not the passkey.

## The one command

```bash
node ensure.mjs
```

Checks the saved session, and if it's missing or expired opens a browser window for you to sign
in, then re-verifies. Exit 0 means a gated page is reachable right now. Everything below is the
detail behind that.

## Configuration (`doorman.config.json`)

This is **the only file you edit** for a given app; the scripts never need changing. It holds just
the five fields that are genuinely project-specific — everything else in the table below is
optional and falls back to a built-in default, so you only add a field when you need to change it.
It contains URLs and selectors, never secrets, so commit it and the rest of the team gets it free.
(See [Where the files live](#where-the-files-live) for which directory it goes in; `detect.mjs`
creates it if it isn't there yet.)

```json
{
  "appName": "My App",
  "baseUrl": "https://localhost:5001",
  "loginPath": "/Login",
  "defaultCheckPath": "/",
  "authenticatedSelector": null
}
```

### Filling in `baseUrl` automatically

```bash
node detect.mjs            # show what it found, change nothing
node detect.mjs --write    # write the best candidate into doorman.config.json
```

`detect.mjs` reads the project's own files — `Properties/launchSettings.json`,
`.vscode/launch.json`, `vite.config.*`, `angular.json`, `next.config.*`, `docker-compose.yml`,
`package.json` scripts, `.env*`, `appsettings*.json` — and ranks what it finds. It then **TCP-probes
each candidate**, so a port that is actually listening beats one that a config file merely claims;
that turns a guess into a fact when your dev server is already up. It also picks up a base path
(Vite's `base`, Next's `basePath`) and suggests `appName` and `defaultCheckPath` where the project
states them. The installers run it for you on a fresh install.

Two things it deliberately will not do:

- **Non-local URLs are discarded, not ranked.** `.env` and `appsettings.*.json` routinely hold
  staging and production URLs, and this whole design persists a live session to disk — so anything
  that isn't loopback, a private range, or a `.local`/`.test` domain is reported and dropped, and
  never even probed. `--allow-remote` overrides that, deliberately.
- **It never writes silently.** Every value it sets is printed with the file and field it came from.
  A wrong `baseUrl` then fails as exit 4 naming the URL it tried, which is cheap to spot and fix.

If it finds nothing usable it writes `"configured": false` instead, so every script stops with
instructions rather than quietly testing the shipped placeholder. Run it again (or set `baseUrl` by
hand and delete that line) once you know the URL. Values you have already set are left alone unless
you pass `--force`; `--root <path>` points it at a different project, and `--json` gives machine-readable
output.

### Field reference

| Field | What it is |
|---|---|
| `appName` | Friendly name, used only in console messages. |
| `baseUrl` | Root URL the dev server listens on (e.g. `https://localhost:5001`). May include a base path for apps hosted under a sub-path — see below. |
| `loginPath` | Path (relative to `baseUrl`) that starts the interactive sign-in. |
| `loginPathPattern` | Case-insensitive regex matched against the URL **pathname** to detect the login page (used to notice an expired session). |
| `idpHostPattern` | Optional case-insensitive regex matched against the URL **host** to detect an external identity provider. Set it to the known provider host pattern, or leave it `null`. |
| `authenticatedUrlPattern` | Optional case-insensitive regex matched against the final app **pathname + query string**. Use it when a known post-login URL proves the session is established; otherwise leave it `null`. |
| `authenticatedSelector` | Optional Playwright selector that must be visible after login and during checks. Choose an element that appears only for an authenticated user (for example, a profile menu or sign-out control); otherwise leave it `null`. |
| `unauthenticatedStatusCodes` | HTTP response statuses treated as an unauthenticated session. Default: `[401, 403]`. |
| `defaultCheckPath` | Gated route checked when you pass no path argument. |
| `viewport` | Browser viewport `{ width, height }`. |
| `loginTimeoutMs` | How long the interactive sign-in waits for you to finish sign-in + MFA. |
| `settleTimeoutMs` | Grace period for JS-rendered content before screenshotting. |
| `captureSessionStorage` | Also capture/replay `sessionStorage` (default `true`). Required for MSAL / Entra ID SPAs — see below. |
| `captureIndexedDB` | Include IndexedDB in the session snapshot (default `false`). Turn on for Firebase Authentication and other SDKs that store tokens there — see below. |
| `expiryWarningMs` | Warn when the earliest cookie expiry is closer than this. Default 15 min. |
| `configured` | Set to `false` only by `detect.mjs` when it found no URL, or by the installer when Node wasn't available. Every script then stops with exit 4 and instructions. Delete the line once `baseUrl` is right. Absent means configured, which is the normal case. |

Any field can be omitted; the built-in default in `config.mjs` is used — which is why the shipped
file lists only five. `baseUrl` can also be overridden per run with the `DOORMAN_BASE_URL` env var. Configuration is validated at startup:
malformed JSON, invalid regular expressions, or invalid values stop the script with **exit 4**
(an environment problem) rather than silently using a potentially wrong target.

## First-time setup (a few minutes, once per machine)

You need [Node.js](https://nodejs.org/) 20+ installed.

**As a plugin** there is nothing to do: a `SessionStart` hook (Claude Code and Codex both support
it — see `integrations/claude/hooks/hooks.json` and `integrations/codex/hooks/hooks.json`) installs
Playwright and Chromium into the host's plugin data directory the first time, in the background,
and does nothing on every session after that. It is guarded by a hash of `package.json` +
`package-lock.json`, so bumping the pinned version is all it takes to have every machine update
itself. `DOORMAN_SKIP_INSTALL=1` turns it off, and `node install-deps.mjs --sync` runs it in the
foreground when you want to watch it (or if plugin-bundled hooks aren't enabled/trusted yet on your
host — the skills also point here as a fallback).

**Vendored**, from this folder:

```bash
npm install                       # installs the pinned Playwright version
npx playwright install chromium   # installs the browser (cached after first time)
```

`package-lock.json` is committed on purpose, and `package.json` pins Playwright exactly: every
developer resolves the same version and shares one cached Chromium instead of downloading another
~100MB. To upgrade, bump the version, run `npm install`, and commit both files.

Only Chromium is installed, never Firefox or WebKit — the toolkit launches nothing else, and the
other two are a few hundred megabytes for no benefit.

## Capture your session

1. **Start the app** if it isn't already running. It must listen on `baseUrl` (self-signed dev
   cert is expected and handled).
2. **Sign in**, from this folder:
   ```bash
   node ensure.mjs        # or: node login-once.mjs, to capture without checking first
   ```
   A browser window opens on the login page. Complete the sign-in and any MFA prompt yourself.
   As soon as you land back in the app, the window closes and your session is saved. You're done.

`node ensure.mjs --clear` throws the saved session away and signs in again; add `--no-login` to
just discard it (a local "sign out").

## Reuse / verify

Confirm the saved session still reaches a gated page (writes `auth-check.png`):

```bash
node auth-check.mjs                       # checks config.defaultCheckPath
node auth-check.mjs /some/other/route     # or an explicit path
```

Every success line reports how old the session is and when its cookies run out, so "it worked
five minutes ago" has an answer:

```
✅ Authenticated. /dashboard => HTTP 200. Landed on https://localhost:5001/dashboard
   Session: captured 2h 14m ago · earliest cookie expiry in 3h 46m
```

## Screenshot a gated page

```bash
node shot.mjs /admin/reports              # -> shot-admin-reports.png
node shot.mjs / home.png --full           # explicit name, full-page capture
node shot.mjs /grid --wait="tbody tr"     # wait for late-rendering content
```

`shot.mjs` verifies the session **before** writing anything, so it never leaves you looking at a
screenshot of the login page and calling it the app. It prints the output path and any browser
console errors it saw — which is usually where a silent CSP or JS failure shows up.

A relative filename lands in the screenshot directory, never the working directory, which is how a
plugin run keeps PNGs off your project's disk where nothing would gitignore them. Pass an absolute
path to put one somewhere specific.

## Testing more than one role

Every script takes `--profile=<name>`, and each profile keeps its own session file and its own
output files. You sign in once per profile.

```bash
node ensure.mjs --profile=admin           # -> storageState.admin.json
node shot.mjs /admin/users --profile=admin  # -> shot-admin-users.admin.png
node auth-check.mjs --profile=readonly
```

`DOORMAN_PROFILE=admin` works too. The unnamed default profile keeps the original filenames
(`storageState.json`), so nothing changes if you never use profiles.

## Apps hosted under a sub-path

If the app is served from a base path, put it in `baseUrl`:

```json
{ "baseUrl": "https://localhost:5001/myapp", "defaultCheckPath": "/dashboard" }
```

Paths are then resolved beneath it (`/dashboard` → `https://localhost:5001/myapp/dashboard`), and
`loginPathPattern` / `authenticatedUrlPattern` are matched against the path with the base path
**stripped** — so you write them app-relative and they keep working if the base path changes. A
path that already includes the base path is not prefixed twice.

## What a "session" actually is here

A sign-in leaves its evidence in up to four places, and they are **not** all captured the same way:

| Where the app keeps it | Who uses it | Captured? |
|---|---|---|
| Cookies | Server-rendered sessions everywhere — ASP.NET, Django, Rails, Express, Laravel, PHP | ✅ Always |
| `localStorage` | SPAs holding a JWT; MSAL with `cacheLocation: 'localStorage'` | ✅ Always |
| `sessionStorage` | **MSAL.js / Entra ID by default**, some OIDC libraries | ✅ `captureSessionStorage` (default **on**) |
| IndexedDB | **Firebase Authentication**, some offline-first SDKs | ⚠️ `captureIndexedDB` (default **off**) |

### `captureSessionStorage` — why it defaults to `true`

Playwright's `storageState()` saves cookies and `localStorage` only; `sessionStorage` is dropped
silently. MSAL.js defaults to `cacheLocation: 'sessionStorage'`, so for a Microsoft Entra ID SPA a
naive capture succeeds, writes a state file, and then **replays a signed-out app** — every later
check reports an expired login. The failure mode is the expensive kind: it looks like a session
problem, so the obvious response is to sign in again, which produces exactly the same result. You
can lose an afternoon to it. Defaulting this **on** means Entra apps work without anyone having to
know this paragraph exists.

**What it costs.** One extra file, `sessionStorage.json`, alongside `storageState.json`. For an
Entra app that file holds the ID/access tokens, so it is exactly as sensitive as the state file:
it's gitignored, `ensure.mjs --clear` deletes it, and the repo installer's `--uninstall` deletes it
too. Never commit it, print it, or copy it off your machine. Two practical limits: it covers a
single origin (the one you land on at the end of sign-in), and it is replayed only into that
origin, so a redirect to the identity provider never receives it. Existing keys are never
overwritten, so live values the app writes itself win over stale saved ones.

If your app doesn't use `sessionStorage`, the file is simply never created — and an existing one is
removed on the next capture, so a stale sidecar can't inject old tokens. Cookie-based apps are
unaffected either way. Set `"captureSessionStorage": false` to turn it off; for an MSAL/Entra SPA,
expect exit 1 on every check if you do.

### `captureIndexedDB` — why it defaults to `false`

Firebase Authentication (and a few offline-first SDKs) keep tokens in IndexedDB, which
`storageState()` includes only when asked. This is off by default because it snapshots **all** of
the origin's IndexedDB — for an app that caches data there, that can be megabytes on every capture,
which most apps would pay for nothing.

You don't have to guess. When the app has IndexedDB databases and this is off, the sign-in says so:

```
✅ Session saved to .../storageState.json
   Note: this app uses IndexedDB (firebaseLocalStorageDb), which was NOT saved.
   If checks now fail as unauthenticated, its tokens are probably in there —
   set "captureIndexedDB": true in doorman.config.json and sign in again.
```

With it on, IndexedDB rides inside `storageState.json` and Playwright restores it automatically —
no extra file, no extra flag anywhere else.

## Exit codes

Every script shares one scheme, so tooling (and agents) can branch on it:

| Code | Meaning |
|---|---|
| `0` | Authenticated, page served HTTP 200. ✅ |
| `1` | Session invalid: redirected to login or the identity provider, left the app origin, returned a configured unauthenticated status, or failed an authentication marker. Sign in again. |
| `2` | No session captured yet → `node ensure.mjs`. |
| `3` | Session is **fine**; the route returned non-200. A wrong URL or an app bug — re-authenticating will not help. |
| `4` | Environment problem: not configured, dev server down, Chromium not installed, invalid argument. Not an authentication failure. |
| `5` | The interactive sign-in was never completed — window closed or timed out. |

The `1` / `3` split matters: a 404 page has no authenticated marker on it either, so treating a
missing marker as an auth failure is exactly how you end up signing in repeatedly to fix a typo in
a URL. Only a conclusive signal (login redirect, identity provider, off-origin, 401/403) yields `1`.

## Writing your own scripts

Prefer `ensure.mjs`, `auth-check.mjs` and `shot.mjs`. If you need something custom, import
`session.mjs` so it fails the same way. Vendored, put the script in this folder and the relative
imports below work as written; as a plugin, import by absolute path
(`file:///.../plugin/scripts/session.mjs`) and keep your script wherever you like.

```js
import { config } from './config.mjs';
import { assessSession, goto, launchBrowser, newSessionContext, requireSession } from './session.mjs';

requireSession();                                    // exits 2 if no session captured
const browser = await launchBrowser();               // exits 4 if Chromium is missing
const page = await (await newSessionContext(browser)).newPage();   // replays the session
const response = await goto(page, new URL('/some/route', config.baseUrl).href);
const { verdict, status, finalUrl, reasons } = await assessSession(page, response);
await browser.close();
```

`runCheck()` / `reportCheck()` in `verify.mjs` give you the whole check-and-explain step in one
call, and `captureSession()` in `capture.mjs` is the interactive sign-in.

`goto()` deliberately waits for `domcontentloaded` (not `networkidle`) then pauses for
`settleTimeoutMs` — an app holding a connection open (SignalR, Blazor Server, websockets,
long-polling) never reaches network idle, so `networkidle` would time out on a perfectly good
session and look like an auth failure.

Loading the session by hand also works, but skips the `sessionStorage` replay. Take the path from
`STATE_PATH` rather than hardcoding a filename — it is the one thing that moves between the two
modes:

```js
import { STATE_PATH } from './config.mjs';

const ctx = await browser.newContext({
  storageState: STATE_PATH,            // wherever this install keeps it
  ignoreHTTPSErrors: true,             // required: the dev cert is self-signed
  viewport: { width: 1400, height: 900 },
});
```

## Letting an agent drive it

As a plugin, the `get-past-login` and `setup` skills tell the agent everything below. Vendored, the
installer writes a `doorman` section into the workspace's `CLAUDE.md` and `AGENTS.md` instead.
Either way the flow is:

1. Run `node ensure.mjs` **in the background** and branch on the exit code.
2. When it prints `=== WAITING FOR SIGN-IN ===`, ask you to sign in at the window that just
   opened. You never have to open a terminal.
3. On `=== SESSION READY ===`, use `shot.mjs` and read the PNGs.

The marker lines (`=== SIGN-IN REQUIRED ===`, `=== WAITING FOR SIGN-IN ===`,
`=== SIGN-IN COMPLETE ===`, `=== SESSION READY ===`) exist for exactly this purpose and are
stable. `ensure.mjs --no-login` is the "check but don't interrupt me" variant.

## Skills (Claude Code and Codex)

Each plugin ships three skills with identical behavior, addressed the way its host expects
(`doorman:get-past-login` / `doorman:setup` / `doorman:vendor` on Claude Code, mentioned as
`$get-past-login` / `$setup` / `$vendor` or matched automatically on Codex):
**`get-past-login`** (verify and screenshot gated pages), **`setup`** (configure a project) and
**`vendor`** (make a committed copy like this one). Nothing to install — see
`integrations/claude/skills/` and `integrations/codex/skills/`.

For a vendored install the toolkit repo has `installers/get-past-login.SKILL.template.md` (Claude)
and `installers/get-past-login.codex.SKILL.template.md` (Codex), which the installer drops at
`.claude/skills/get-past-login/SKILL.md` and `.agents/skills/get-past-login/SKILL.md` with
`--install-skill`. Both read `doorman.config.json` at runtime, so they need no substitutions. Worth
doing only if some contributors won't have a plugin installed, since it duplicates what the plugin
already provides.

## Notes / gotchas

- **Route ≠ folder path.** A gated page's URL is whatever its framework routes it to, *not* the
  source-folder path. A 404 is not an auth failure.
- **Git Bash on Windows** mangles a leading-slash argument into a Windows path. Simplest fix: drop
  the leading slash (`node shot.mjs dashboard`) — the scripts add it back. `MSYS_NO_PATHCONV=1`
  works too, but it disables path conversion for the whole command, including any absolute paths
  and path-like environment variables in it.
- **Let content settle.** JS-rendered grids/tables fill *after* load; `settleTimeoutMs` covers
  this, but bump it (or pass `--wait="<selector>"`) if pages look blank.
- **Use a strong success marker when possible.** `authenticatedSelector` is more reliable than
  inferring authentication only from a URL; choose a visible element unavailable to anonymous users.
- **Local and test environments only.** This persists a live session to disk; prefer a dedicated
  test account and never point it at production.
- **Interactive sign-in needs a local, visible desktop.** It opens a real browser window and waits
  for a human to use it — this will not work in a remote or cloud sandbox where nobody can see or
  click through that window.
