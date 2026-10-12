<!-- doorman:start -->
## Getting past the sign-in wall (`{{TOOLS_DIR}}`)

**Reach for this whenever a page blocks you with a login** — it redirects to a sign-in form, returns
401 or 403, or renders as though nobody is signed in. `{{TOOLS_DIR}}` gets you through by replaying a
browser session the developer signed in for once; you then carry on with whatever you were doing. It
does no testing of its own.

Read `{{TOOLS_DIR}}/doorman.config.json` first — it defines the app URL, the login path, and the
markers that prove a session is live. Run every command below from `{{TOOLS_DIR}}`.

Exit codes are the interface — branch on them, don't guess from output:

| Code | Meaning | Do this |
|---|---|---|
| 0 | Session works | Continue. |
| 1 | Session expired or invalid | Get a new one (below). |
| 2 | No session captured yet | Get one (below). |
| 3 | Inconclusive: the route proved nothing either way (404, 5xx, timeout) | A wrong URL or an unhealthy app. **Do not re-authenticate.** |
| 4 | Environment problem (not configured, dev server down, Chromium missing, bad argument, crash) | Read the message. Not an auth problem. |
| 5 | The interactive sign-in was never completed | Ask the developer what happened. |

### First run: configure it

The installer already ran `node detect.mjs --write`, which fills in `baseUrl` from this repo's own
files. Fill in the rest yourself — the values are in this repo, so don't ask the developer for them:

- `baseUrl` — where the dev server listens. Re-run `node detect.mjs` to see what it found and
  which file each candidate came from; it TCP-probes them, so `LISTENING` means that one is real.
  If it found nothing it wrote `"configured": false` (every script then stops with exit 4): check
  `Properties/launchSettings.json` (ASP.NET), `.vscode/launch.json`, `vite.config.*`,
  `angular.json`, `next.config.*`, `docker-compose.yml`, or the README, set the value, and delete
  that line. Include the sub-path if the app is hosted under one (e.g.
  `https://localhost:5001/myapp`). Non-local URLs are discarded on purpose — never point this at
  staging or production, whatever a `.env` file offers.
- `loginPath` — the route that starts the sign-in, and `loginPathPattern` to recognise it.
- `defaultCheckPath` — a route that requires a signed-in user.
- `authenticatedSelector` — ideally a sign-out or profile element that only appears when signed
  in. It makes every later check far more reliable.

Only the five fields in the file are project-specific; everything else has a built-in default, so
add a field only when you need to change it. `{{TOOLS_DIR}}/README.md` lists them all.

### Verify, then work

1. `cd {{TOOLS_DIR}} && node ensure.mjs` — one command: it checks the saved session and, if it's
   missing or expired, opens the sign-in window itself. Exit 0 means you can proceed.
   **Launch it in the background** — it may block for minutes waiting for a human. Add
   `--no-login` if you only want a check and must not interrupt the developer.
2. Screenshot any gated page: `node shot.mjs /some/route`. It refuses to write a file unless the
   session is valid, then prints the PNG path and any browser console errors. Use `--full` for a
   full-page capture and `--wait="<selector>"` when content renders late.
3. **Always open the PNG with the Read tool.** Never report a UI as working based on exit 0 alone.

Prefer these scripts over hand-writing Playwright. If you do need a custom script, run it from
`{{TOOLS_DIR}}` and import `./session.mjs` so it fails the same way these do.

### When a sign-in is needed

`ensure.mjs` handles it — don't hand the developer a list of commands to type. Watch its output
for these stable markers:

- `=== SIGN-IN REQUIRED ===` — no usable session; a browser window is opening.
- `=== WAITING FOR SIGN-IN ===` — the window is up. Now tell the developer something like:
  > A browser window just opened on the sign-in page — please sign in and approve any MFA prompt.
  > I'll pick up automatically once you're through. I never see your password.
- `=== SESSION READY ===` — verified; carry on.

Exit 5 means the sign-in was never finished (window closed or timed out). Exit 1 *after* a
completed sign-in points at `doorman.config.json`, not at the developer — check
`authenticatedSelector` and the patterns against the URL it reports. If the sign-in also noted that
the app uses IndexedDB, that's the likelier cause (Firebase Authentication keeps tokens there):
set `"captureIndexedDB": true` and run `node ensure.mjs --clear`. Either way, fix the config and
re-run rather than asking them to sign in twice.

`node ensure.mjs --clear` discards the saved session and signs in fresh; add `--no-login` to just
discard it.

### Testing more than one role

Each role gets its own saved session via `--profile`:

```
node ensure.mjs --profile=admin        # sign in as admin (separate session file)
node shot.mjs /admin/users --profile=admin
```

The developer has to sign in once per profile. Don't create profiles they didn't ask for.

### Rules

- Never ask for, type, store, or log the developer's credentials. The interactive sign-in is the
  one step that must stay human.
- `storageState*.json` / `sessionStorage*.json` hold a live session — anyone holding them is
  signed in as the developer. Never commit them, print their contents, or copy them outside the
  workspace.
- Point this at local or test environments only, never production.
- Interactive sign-in needs a local, visible desktop to open a browser window in. It will not
  work in a remote or cloud sandbox where nobody can see or click through the window that opens.
<!-- doorman:end -->
