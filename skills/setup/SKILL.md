---
name: "setup"
description: "Configure doorman for this project: detect the dev server URL, work out the login and gated routes, and prove a session can be captured. Use once per project, or whenever a doorman script exits 4 saying it is not configured."
---

# Setting doorman up for this project

One config file, five fields, most of them derivable from the repo. Aim to finish without asking
the developer anything except to sign in at the end.

```bash
DOORMAN="${CLAUDE_PLUGIN_ROOT}/scripts"
node "$DOORMAN/paths.mjs"                  # where the config will go, and whether one exists
```

Claude Code fills in that path when it loads this skill. If the first line still reads literally
`${CLAUDE_PLUGIN_ROOT}` (as under Codex), use the absolute path of the `scripts` directory two
levels above this SKILL.md instead.

The config lands at `<project>/.doorman/doorman.config.json`. It holds URLs and selectors,
never secrets, so it is meant to be committed — the saved session lives outside the project
entirely and is never at risk of being committed with it.

## 1. Detect the URL — don't read files yourself first

```bash
node "$DOORMAN/detect.mjs" --write
```

That creates the config and fills in `baseUrl` from the project's own files, plus `appName` and
`defaultCheckPath` when the project states them. It prints every value with the file and field it
came from, so check that the choice makes sense rather than trusting it blindly.

- `LISTENING` next to a candidate means a port really is open there. That beats any config file's
  claim, which is why it wins the ranking.
- Non-local candidates are **discarded and reported, never probed** — `.env` and `appsettings.*.json`
  routinely hold staging and production URLs, and this toolkit persists a live session to disk.
  Don't reach for `--allow-remote`.
- If it says it guessed the project root, re-run with `--root <path>`.
- If it found nothing it writes `"configured": false`, and every script will stop with instructions
  until you set `baseUrl` by hand and delete that line.

## 2. Fill in what detection can't know

Read the repo for these. They are in the code, so don't ask the developer:

- **`loginPath`** — the route that starts the sign-in (e.g. `/Login`, `/auth/signin`,
  `/Identity/Account/Login`). Check the router, the controllers, or the auth middleware config.
- **`loginPathPattern`** — only if the login route doesn't start with `/login`. A case-insensitive
  regex matched against the pathname; the default is `^/login`.
- **`defaultCheckPath`** — a route that genuinely requires a signed-in user. An `[Authorize]`
  attribute, a route guard, or a `login_required` decorator is the evidence you want. The home page
  is usually the wrong choice, because it often renders for anonymous users too.
- **`authenticatedSelector`** — a selector for something only a signed-in user sees: a sign-out
  link, a profile menu, a user avatar. **Worth the effort.** Without it, every check relies on "we
  weren't redirected to the login page", which quietly passes on apps that render a signed-out
  version of the same URL. If there's no stable selector, `authenticatedText` (e.g. `"Sign out"`)
  does the same job.
- **`unauthenticatedSelector`** — only for SPAs that answer 200 on every route and render a sign-in
  component client-side: a selector for that component (e.g. the login form).
- **`idpHostPattern`** — only for an external identity provider with a stable host (Entra ID,
  Auth0, Okta). It lets a redirect to the provider be recognised as "not signed in" rather than
  a mysterious off-origin failure.

Everything else has a built-in default; add a field only to change it. The full reference is in the
plugin's `scripts/README.md`.

**If the app has no sign-in at all** (no login route, no auth middleware, nothing gated), there is
nothing for doorman to do yet. Keep the detected `baseUrl`, add `"configured": false` to the config
so no script mistakes a public page for a valid session, skip step 3, and tell the developer that
plainly — including that once authentication exists, asking to set doorman up again picks up from
there.
Don't write notes or any other file beyond the config (and, under Codex, the `AGENTS.md` line in
step 5).

## 3. Prove it works

The app has to be running. Then, **in the background** (it waits for a human):

```bash
node "$DOORMAN/ensure.mjs"
```

At `=== WAITING FOR SIGN-IN ===`, tell the developer a browser window is open and to sign in and
approve any MFA prompt — and that you never see their password. `=== SESSION READY ===` means the
config is right.

Then confirm it end to end and **open the PNG with the Read tool**:

```bash
node "$DOORMAN/shot.mjs"
```

If the sign-in completes but the check still fails, that is a configuration problem, not a
developer problem — fix `authenticatedSelector` or the patterns against the URL the log reports
rather than asking for a second sign-in. If the capture mentions IndexedDB, the app likely keeps
its tokens there (Firebase Authentication does): set `"captureIndexedDB": true` and run
`ensure.mjs --clear`.

## 4. Tell the developer what you set

Show them the finished config, where the session file lives, and which fields you inferred versus
found stated. If you had to guess `authenticatedSelector`, say so — it's the one field a human can
correct in seconds and the one that most improves reliability.

Suggest committing `.doorman/doorman.config.json` so the rest of the team gets it for free.

## 5. Under Codex only: leave a pointer in `AGENTS.md`

Claude Code runs a session-start hook that reminds every later session that doorman is set up, so
skip this step there. A Codex marketplace install doesn't run plugin hooks, so without a pointer a
later session won't think of doorman until a login wall has already stopped it. If `$DOORMAN`
above still read literally `${CLAUDE_PLUGIN_ROOT}` (you are under Codex), add this one line to the
project's root `AGENTS.md`, creating the file if needed. If a line beginning
`<!-- doorman -->` is already there, replace it rather than adding a second:

```
<!-- doorman --> If you have the doorman plugin: when a page you need to check requires a signed-in user, or redirects to a login, returns 401/403 or renders signed-out, use its `get-past-login` skill rather than skipping the check or stopping at the login (config: `.doorman/doorman.config.json`).
```

It says "if you have the doorman plugin" on purpose: teammates without it read the same file. Tell
the developer you added it, and that it's one line they can delete.

## Rules

- Never ask for, type, store, or log the developer's credentials.
- Local and test environments only, never production.
- Never print the contents of `storageState*.json` / `sessionStorage*.json`, or copy them into the
  project.
