---
name: "get-past-login"
description: "Get past a sign-in wall that is blocking you. Use whenever a page redirects to a login, returns 401 or 403, renders as signed-out, or a saved session has expired — get a working session, then carry on with whatever you were already doing. Also use for any browser check, screenshot or CSS/layout inspection of a page that needs a signed-in user."
---

# Getting past a sign-in wall

You hit a page that needs a signed-in user. This toolkit gets you through it by replaying a browser
session the developer established once, interactively — then you carry on with whatever you were
doing. You never handle their credentials, and the toolkit does no testing of its own.

The authentication can be forms login, OAuth/OIDC, SAML, enterprise SSO or Microsoft Entra ID —
anything that ends with a session in browser storage. A few apps still refuse a replayed session
(device-bound or IP-bound sessions, anti-automation); see the gotchas below. `chromium-cli` is
**not** assumed to be installed — don't try it first.

## Where things are

The scripts live in the installed plugin, not in the project. Set this once per session and use it
in every command below:

```bash
DOORMAN="${CLAUDE_PLUGIN_ROOT}/scripts"
```

Claude Code fills in that path when it loads this skill. If what you see above is still the literal
text `${CLAUDE_PLUGIN_ROOT}` (Codex doesn't substitute it, and the variable is not set in your
shell), use the `scripts` directory two levels above this SKILL.md instead — this file is
`<plugin>/skills/get-past-login/SKILL.md`. Either way use an absolute path, and confirm it with
`node "$DOORMAN/paths.mjs"`, which prints every location it resolved:

| | |
|---|---|
| config | `<project>/.doorman/doorman.config.json` — per project, committed, no secrets |
| session | the plugin's data directory, **outside the project** — a live session, never committed |
| screenshots | the plugin's data directory; `shot.mjs` prints the absolute path of each one |

Run the commands from anywhere; they work out the project from the working directory, so stay in
the project you are testing. Read `doorman.config.json` before you start — `appName`, `baseUrl`,
`loginPath` and `defaultCheckPath` are all there, so don't ask the developer for them.

## Exit codes — branch on these, don't guess from output

| Code | Meaning | Do this |
|---|---|---|
| 0 | Session works | Continue. |
| 1 | Session expired or invalid | Get a new session (§3). |
| 2 | No session captured yet | Get one (§3). |
| 3 | Inconclusive: the route proved nothing (404, 5xx, timeout) | Wrong URL or unhealthy app. **Do not re-authenticate.** |
| 4 | Environment problem (not configured, server down, Chromium missing, bad argument, crash) | Read the message. Not auth. |
| 5 | The interactive sign-in was never completed | Window closed or timed out; ask the developer. |

3 or 4 means re-running the sign-in is pointless. Asking the developer to sign in again over a
route typo wastes their time and teaches them to distrust the tool.

A success line that adds "Evidence: the page loaded without a login redirect" means no positive
signal is configured, so the check only knows it wasn't bounced to a login page. Setting
`authenticatedSelector` (or `authenticatedText`) in the config turns that into real proof.

## 0. Is this project configured yet?

If `doorman.config.json` doesn't exist, or a script exits 4 saying it isn't configured, run the
doorman `setup` skill (`/doorman:setup` in Claude Code, `$setup` in Codex) — it does the whole job.
In short:

```bash
node "$DOORMAN/detect.mjs"            # ranked candidates + the file and field each came from
node "$DOORMAN/detect.mjs" --write    # create/fill the config with the best one
```

`detect.mjs` reads the project's own files (`Properties/launchSettings.json`, `.vscode/launch.json`,
`vite.config.*`, `angular.json`, `next.config.*`, `docker-compose.yml`, `package.json` scripts,
`.env*`, `appsettings*.json`) and TCP-probes each candidate — `LISTENING` means that one is real,
which beats any file's claim. It discards non-local URLs by design; **don't** pass `--allow-remote`
to get past that, and never point this at staging or production.

## 1. Check whether the dev server is already running

The developer often has it running already. `node "$DOORMAN/detect.mjs"` tells you — `LISTENING`
next to the chosen URL. If nothing answers, start the app per the project's own run instructions in
the background; it has to listen on the configured `baseUrl`.

A plain `fetch` is often enough to confirm server-rendered markup. Only reach for a browser when
you need computed styles, layout, or JS behaviour.

## 2. Get a working session, then screenshot

```bash
node "$DOORMAN/ensure.mjs"                          # check, and sign in if needed (§3)
node "$DOORMAN/shot.mjs" /admin/reports             # -> shot-admin-reports.png
node "$DOORMAN/shot.mjs" / home.png --full          # explicit name, full-page capture
node "$DOORMAN/shot.mjs" /grid --wait="tbody tr"    # wait for late-rendering content
```

`ensure.mjs` is the single entry point: it verifies the saved session and, only if that fails,
opens the sign-in window. `--no-login` gives you a check that will never interrupt the developer;
`auth-check.mjs` gives you the exit code alone.

`shot.mjs` verifies the session **before** writing anything, so it can never hand you a screenshot
of the login page to mistake for the app. It prints the PNG path and any browser console errors.

**Always open the resulting PNG with the Read tool.** Never report a UI as correct because a
command exited 0.

Testing a second role? Every script takes `--profile=<name>`, each with its own saved session:
`node "$DOORMAN/ensure.mjs" --profile=admin`, then
`node "$DOORMAN/shot.mjs" /admin/users --profile=admin`. The developer signs in once per profile,
so don't invent profiles they didn't ask for.

Prefer these scripts to hand-written Playwright. If you genuinely need a custom script, put it in a
scratch directory (never the repo) and import the toolkit's own modules by absolute path so it
classifies failures identically:

```js
import { config } from 'file:///abs/path/to/plugin/scripts/config.mjs';
import { assessSession, goto, launchBrowser, newSessionContext, requireSession }
  from 'file:///abs/path/to/plugin/scripts/session.mjs';

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

Launch it **in the background**: it blocks for minutes waiting for a human and would exceed a
foreground command timeout.

```bash
node "$DOORMAN/ensure.mjs"
```

Watch its output for these stable markers:

- `=== SIGN-IN REQUIRED ===` — no usable session; a browser window is opening.
- `=== WAITING FOR SIGN-IN ===` — the window is up. Now tell the developer:
  > A browser window just opened on the sign-in page — please sign in and approve any MFA prompt.
  > I'll pick up automatically once you're through. I never see your password.
- `=== SESSION READY ===` — verified against a gated route; carry on.

Exit 5 means the sign-in never finished (window closed, or timed out) — the log says which; ask
the developer before retrying. Exit 1 *after* a completed sign-in is a configuration problem, not a
developer problem: check `authenticatedSelector`, `authenticatedUrlPattern` and `loginPathPattern`
against the URL the log reports.

`node "$DOORMAN/ensure.mjs" --clear` discards the saved session and signs in fresh; add
`--no-login` to only discard it.

## Rules

- **Never** ask for, type, store, or log the developer's credentials. The interactive sign-in is
  the one step that must stay human.
- `storageState*.json` / `sessionStorage*.json` hold a live session — anyone holding them is signed
  in as the developer. They live outside the project on purpose. Never print their contents, and
  never copy them into the repo or anywhere else.
- Point this at local or test environments only, never production.
- Interactive sign-in needs a local, visible desktop to open a browser window in. It will not work
  in a remote or cloud sandbox where nobody can see or click through the window that opens.

## When something isn't set up

Work through these in order; only the interactive sign-in needs the developer.

1. **Playwright missing** (exit 4 saying so) — the plugin's session-start hook installs it where the
   host runs that hook (Claude Code does; a Codex marketplace install doesn't). If the message says
   it is still installing, wait and retry. Otherwise run
   `node "$DOORMAN/install-deps.mjs" --sync` and read the log path it prints.
2. **Not configured** (exit 4 saying so) — §0, or the doorman `setup` skill.
3. **Dev server down** (exit 4) — start it per the project's run instructions.
4. **No session / expired** (exit 2 or 1) — §3.

## Gotchas proven in use

- **Get the route right before blaming auth.** A gated page's URL is its framework route (see
  `defaultCheckPath`), *not* the source-folder path. Exit 3 (a 404 or 500) is usually telling you
  exactly this.
- **Git Bash on Windows rewrites leading-slash arguments** into Windows paths (`/dashboard` arrives
  as `C:/Program Files/Git/dashboard`). The scripts detect and undo that, so `/dashboard` is fine;
  if one ever exits 4 with "Not an app route", drop the leading slash — `dashboard` — and the
  scripts add it back. Don't reach for `MSYS_NO_PATHCONV=1`: it disables path conversion for the
  whole command, including `$DOORMAN` itself, which breaks the run in a much more confusing way.
- **Let JS-rendered content settle.** Grids and tables fill late; use `--wait="<selector>"` rather
  than screenshotting a blank page and guessing.
- **A sign-in that succeeds but still checks as unauthenticated is a config problem.** If the
  capture noted that the app uses IndexedDB, set `"captureIndexedDB": true` (Firebase
  Authentication keeps tokens there) and run `ensure.mjs --clear`; otherwise check
  `authenticatedSelector` and the patterns against the URL it reported. Don't ask for a second
  sign-in until the config is right. If the config is right and a fresh session is still rejected,
  the app may bind sessions to the original browser or IP, or block automation — tell the developer
  that, rather than looping on sign-ins (see "Does this work with my app?" in the scripts README).
- **A popup sign-in finishes without the URL changing.** If the app signs in through a popup, the
  capture relies on `authenticatedSelector` to know it's done — make sure it is set.
- **A session that just worked can expire mid-task.** Success lines report the session's age and
  earliest cookie expiry; if you see the "expiring soon" warning, expect exit 1 next and be ready
  to re-run `ensure.mjs` rather than reporting a UI bug.
- **Strict CSP silently drops inline `style="..."`.** If the app sets `style-src 'self'` with no
  `unsafe-inline`, inline styles are dropped by the browser with no visible error — the layout is
  right, one property is just missing. Check the console errors `shot.mjs` reports before suspecting
  the CSS pipeline, and fix it by moving the value into a real CSS class rather than weakening the
  policy.

## Cleanup

Scratch scripts belong in a temp directory, never in the repo. Screenshots already land outside the
project; still delete the ones you no longer need, unless the developer asked you to keep them.
