---
name: "get-past-login"
description: "Get past a sign-in wall that is blocking you, using this workspace's vendored doorman toolkit. Use whenever a page redirects to a login, returns 401 or 403, renders as signed-out, or a saved session has expired — get a working session, then carry on with whatever you were already doing. Also use for any browser check, screenshot or CSS/layout inspection of a page that needs a signed-in user."
---

# Getting past a sign-in wall

At the start of every task, locate `doorman.config.json` in the workspace (normally
`tools/doorman/doorman.config.json`) and read it. Its containing directory is the **toolkit
directory**. Use its `appName`, `baseUrl`, `loginPath`, and `defaultCheckPath`; never edit this
skill or ask the developer for values that are already in the configuration.

The configured authentication may be forms login, OAuth/OIDC, SAML, enterprise SSO, or another
system that leaves a session in browser storage. A few apps still refuse a replayed session
(device-bound or IP-bound sessions, anti-automation); if a fresh sign-in is rejected straight away,
say so rather than asking for another. `chromium-cli` is **not** assumed to be installed —
don't try it first. Go straight to the toolkit.

Run every toolkit command **from the toolkit directory** (it has its own `package.json` /
`node_modules` and resolves its session files relative to itself).

## Exit codes — branch on these, don't guess from output

| Code | Meaning | Do this |
|---|---|---|
| 0 | Session works | Continue. |
| 1 | Session expired or invalid | Get a new session (§3). |
| 2 | No session captured yet | Get one (§3). |
| 3 | Inconclusive: the route proved nothing (404, 5xx, timeout) | Wrong URL or unhealthy app. **Do not re-authenticate.** |
| 4 | Environment problem (not configured, server down, Chromium missing, bad argument, crash) | Read the message. Not auth. |
| 5 | The interactive sign-in was never completed | Window closed or timed out; ask the developer. |

A code of 3 or 4 means re-running the sign-in is pointless — it will not help, and asking the
developer to sign in again wastes their time.

## 0. Is it configured?

If `doorman.config.json` has `"configured": false`, every script exits 4 with instructions — it
means URL detection found nothing. Start with the detector rather than reading files yourself:

```bash
node detect.mjs            # ranked candidates + the file and field each came from
node detect.mjs --write    # write the best one into doorman.config.json
```

It reads `Properties/launchSettings.json`, `.vscode/launch.json`, `vite.config.*`, `angular.json`,
`next.config.*`, `docker-compose.yml`, `package.json` scripts, `.env*` and `appsettings*.json`,
then TCP-probes each candidate — `LISTENING` means that one is real, which beats any file's claim.
It discards non-local URLs by design; **don't** pass `--allow-remote` to reach past that, and never
point this at staging or production. Add `--root <path>` if it guessed the wrong project root
(it says when it guessed).

Fill in the rest by reading the repo: the login route, a gated route for `defaultCheckPath`, and
ideally an `authenticatedSelector` such as a sign-out control. Delete the `"configured": false`
line once `baseUrl` is right. Only ask the developer about values the repo genuinely doesn't
contain.

## 1. Check if the dev server is already running — don't assume you need to start it

The developer often already has the app running in another terminal. If you just ran
`node detect.mjs`, it already told you — `LISTENING` next to the chosen URL. Otherwise probe it
from the toolkit directory (works on every platform, no PowerShell required):

```bash
node -e "import('./config.mjs').then(async ({config}) => {
  try { const r = await fetch(config.baseUrl); console.log('OK', r.status); }
  catch (e) { console.log('DOWN:', e.message); }
})" --no-warnings
```

If the dev cert is self-signed, add `NODE_TLS_REJECT_UNAUTHORIZED=0` to that probe only.
Playwright already handles self-signed certs via `ignoreHTTPSErrors`.

If nothing answers, start the app in the background per the project's run instructions; it must
listen on the configured `baseUrl`. A plain `fetch` is often enough to confirm server-rendered
markup — only reach for a browser when you need computed styles, layout, or JS behaviour.

## 2. Get a working session, then screenshot

```bash
node ensure.mjs                            # check, and sign in if needed (see §3)
node shot.mjs /admin/reports               # -> shot-admin-reports.png
node shot.mjs / home.png --full            # explicit name, full-page capture
node shot.mjs /grid --wait="tbody tr"      # wait for late-rendering content
```

`node ensure.mjs` is the single entry point: it verifies the saved session and, only if that
fails, opens the sign-in window. Use `node ensure.mjs --no-login` when you want a check but must
not interrupt the developer, and `node auth-check.mjs` when you only care about the exit code.

`shot.mjs` verifies the session **before** writing anything, so it can never hand you a
screenshot of the login page to mistake for the app. It prints the PNG path and any browser
console errors it saw.

**Always open the resulting PNG with the Read tool.** Never report a UI as correct because a
command exited 0.

Testing a second role? Every script takes `--profile=<name>`, each with its own session file:
`node ensure.mjs --profile=admin`, then `node shot.mjs /admin/users --profile=admin`. The
developer signs in once per profile, so don't invent profiles they didn't ask for.

Prefer these scripts over hand-written Playwright. If you genuinely need a custom script, put it
in a scratch directory, run it from the toolkit directory, and import `./session.mjs` so it
classifies failures the same way:

```js
import { config } from './config.mjs';
import { assessSession, goto, launchBrowser, newSessionContext, requireSession } from './session.mjs';

requireSession();
const browser = await launchBrowser();
const page = await (await newSessionContext(browser)).newPage();
const loaded = await goto(page, new URL(config.defaultCheckPath, config.baseUrl).href);
console.log(await assessSession(page, loaded));   // { verdict: 'valid'|'invalid'|'inconclusive', ... }
await browser.close();
```

## 3. When a sign-in is needed (exit 1 or 2)

This is the one step you cannot do yourself — but you *can* start it, and you should. Don't hand
the developer a list of commands to type.

Launch it **in the background** (it blocks for minutes waiting for a human and will exceed a
foreground command timeout):

```bash
node ensure.mjs
```

Watch its output for these stable markers:

- `=== SIGN-IN REQUIRED ===` — no usable session; a browser window is opening.
- `=== WAITING FOR SIGN-IN ===` — the window is up. Now tell the developer:
  > A browser window just opened on the sign-in page — please sign in and approve any MFA prompt.
  > I'll pick up automatically once you're through. I never see your password.
- `=== SESSION READY ===` — verified against the gated route; carry on.

Exit 5 means the sign-in never finished (window closed, or timed out) — the log says which; ask
the developer before retrying. Exit 1 *after* a completed sign-in is a configuration problem, not
a developer problem: check `authenticatedSelector`, `authenticatedUrlPattern` and
`loginPathPattern` against the URL the log reports.

**Never** ask for, type, store, or log their credentials. Never print the contents of
`storageState*.json` or `sessionStorage*.json`, and never copy them outside the workspace — they
are a live session.

This step needs a local, visible desktop to open a browser window in — it will not work in a
remote or cloud sandbox where nobody can see or click through the window that opens.

### Not-set-up machine

Work through these in order; only escalate the interactive sign-in.

1. **`node_modules` missing in the toolkit directory** — run `npm install`, then
   `npx playwright install chromium`. If `npm`/`node` isn't found, tell the developer: *"Install
   Node.js 20+ from https://nodejs.org, reopen the terminal, and I'll continue."*
2. **Not configured** (exit 4 saying so) — §0.
3. **Chromium missing** (exit 4 saying so) — `npx playwright install chromium`.
4. **Dev server down** (exit 4) — start it per the project's run instructions.
5. **No session / expired** (exit 2 or 1) — §3 above.

### Gotchas proven in-session

- **Get the route right before blaming auth.** A gated page's URL is its framework route (see
  `defaultCheckPath`), *not* the source-folder path. Exit 3 (a 404 or 500) is usually telling you
  exactly this.
- **Git Bash rewrites leading-slash args** into Windows paths; the scripts detect and undo it. If
  one ever exits 4 with "Not an app route", drop the leading slash — `node shot.mjs dashboard` —
  and the scripts add it back. Avoid `MSYS_NO_PATHCONV=1`: it affects every argument in the command.
- **Let JS-rendered content settle.** Grids and tables fill late; use `--wait="<selector>"`
  rather than screenshotting a blank page and guessing.
- **A sign-in that succeeds but still checks as unauthenticated is a config problem**, not a
  developer problem. If the capture noted that the app uses IndexedDB, set
  `"captureIndexedDB": true` (Firebase Authentication stores tokens there) and
  `node ensure.mjs --clear`; otherwise check `authenticatedSelector` and the patterns against the
  URL it reported. Don't ask for a second sign-in until the config is right.
- **A session that just worked can expire mid-task.** Success lines report the session's age and
  earliest cookie expiry; if you see the "expiring soon" warning, expect exit 1 next and be ready
  to run `node ensure.mjs` again rather than reporting a UI bug.

<!-- ────────────────────────────────────────────────────────────────────────
     OPTIONAL — keep this section ONLY if the target app ships a strict
     Content-Security-Policy with `style-src 'self'` (no unsafe-inline).
     Delete the whole section otherwise.
     ──────────────────────────────────────────────────────────────────────── -->
## OPTIONAL: strict CSP silently kills inline `style="..."`

If this app's security headers set `style-src 'self'` with no `unsafe-inline`/`unsafe-hashes`,
any markup using inline `style="..."` gets **silently dropped by the browser** — no visible error,
layout otherwise correct, only the styled property missing. Whenever a page "looks unstyled" or
"the wrong colour" despite the markup looking right, check the console errors `shot.mjs` reports
before suspecting the CSS pipeline. A violation reads like:

`Applying inline style violates the following Content Security Policy directive 'style-src 'self''...`

Fix by moving the value into a real CSS class (rebuild the stylesheet) and referencing the class
from the markup — don't weaken the CSP by adding `unsafe-inline`/`unsafe-hashes`.

## Cleanup

Scratch scripts and screenshots belong in a temp/scratch directory, never in the repo. `*.png` in
the toolkit directory is gitignored, but still delete what you no longer need unless the
developer asked you to keep it.
