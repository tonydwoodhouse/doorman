# doorman

**Browser automation stops at the login page. Doorman gets your agent past it.**

An AI agent driving a browser can do nearly anything — until a page bounces it to a sign-in form.
It can't type a password, it shouldn't be handed one, and MFA ends the argument there. So the agent
stops, and asks you to go and look yourself.

Doorman removes that roadblock and then gets out of the way. The developer signs in **once**, in a
real browser window; the authenticated session is saved and **replayed** on every later headless
run, until it expires (~4–8h). No password or MFA prompt is ever automated, stored, or seen by the
agent — the one interactive step stays human.

It is deliberately **not** a testing tool. It doesn't assert, drive flows, or decide what "correct"
looks like. It gets you to the page; what you do once you're there is your business.

It works with forms login, OAuth/OIDC, SAML, enterprise SSO, Microsoft Entra ID, or anything else
that leaves a session cookie or browser storage behind, and it is **stack-agnostic**: it only speaks
HTTP and drives a browser, so the server can be ASP.NET, Django, Flask, Rails, Express, Next.js,
Laravel or Spring without any difference. Node 20+ is needed to run the toolkit, not to build the
app under test. See [Does this work with my app?](scripts/README.md#does-this-work-with-my-app) for
the few auth styles that genuinely can't work.

## Install as a plugin (recommended)

```
/plugin marketplace add tonydwoodhouse/doorman
/plugin install doorman
```

That's the whole installation. Nothing is copied into your projects, and Playwright installs itself
in the background on your next session start.

Then, in any project:

- **"set up doorman for this project"** — the `doorman:setup` skill finds the dev server URL in the
  project's own files, works out the login and gated routes, and proves a session can be captured.
- Nothing at all — the `doorman:get-past-login` skill fires on its own the moment the agent hits a
  login redirect, a 401, or a page that renders signed-out. It verifies the session, asks you to
  sign in at a browser window if it needs one, and then continues what it was doing. Asking for it
  by name (**"screenshot the admin dashboard"**, **"check my CSS change on the settings page"**)
  works too.
- **"vendor doorman into this repo"** — the `doorman:vendor` skill sets up the committed copy
  described below, for CI.

### Where the plugin keeps things

| | |
|---|---|
| config | `<project>/.claude/doorman/doorman.config.json` — per project, safe to commit |
| session files | the plugin's data directory, **outside every project** |
| screenshots | the plugin's data directory, per project |
| Playwright | the plugin's data directory, once per machine |

Keeping the session out of the repository is deliberate: `storageState.json` is a live session, and
the surest way to stop it being committed is for it never to be on the project's disk. Run
`node "$CLAUDE_PLUGIN_ROOT/scripts/paths.mjs"` to print exactly where everything resolved.

The `SessionStart` hook that installs Playwright is guarded by a hash of `scripts/package.json` +
`package-lock.json`: it acts once, does nothing on every later session, and picks up a version bump
automatically. It runs detached, so it never delays a session. `DOORMAN_SKIP_INSTALL=1` disables it.

## Vendored mode (a committed copy, for CI)

For a CI job, or teammates who don't use Claude Code, install a self-contained copy into the project
instead. Clone this repo once, then:

**Windows / PowerShell 7+:**
```powershell
cd path\to\doorman
./install.ps1 -Workspace C:\src\my-app -InstallSkill -Bootstrap
```

**macOS / Linux / Git Bash:**
```bash
cd path/to/doorman
./install.sh --workspace ~/src/my-app --install-skill --bootstrap
```

Flags (both installers):

| PowerShell | bash | Effect |
|---|---|---|
| `-Workspace <path>` | `--workspace <path>` | Target repo root (default: current dir). |
| `-ToolsDir <rel>` | `--tools-dir <rel>` | Where to put it (default `tools/doorman`). |
| `-InstallSkill` | `--install-skill` | Also drop a Claude Code skill at `.claude/skills/get-past-login/SKILL.md`. Only useful if some contributors don't have the plugin. |
| `-Bootstrap` | `--bootstrap` | Run `npm install` + `npx playwright install chromium` after copying. |
| `-Force` | `--force` | Overwrite existing files (otherwise existing files are skipped). |
| `-Uninstall` | `--uninstall` | Remove what was installed (see below). |

Vendored, everything lives together in `tools/doorman/`: the scripts, the config, and the session
files — which the shipped `.gitignore` keeps out of source control. That last point is the trade-off
against the plugin, so make it knowingly.

The installer never copies per-developer artifacts (`node_modules/`, session files, `*.png`) and
**skips files that already exist** unless `-Force`/`--force`, so re-running to pick up an update
won't clobber a customized `doorman.config.json`. When it creates the config it runs
`node detect.mjs --write` to fill in `baseUrl`; that needs only Node builtins, so it happens before
any `npm install`, and it never fails the install.

Every vendored install also writes a clearly marked `doorman` section into the workspace's
`CLAUDE.md` (from [`installer/CLAUDE.section.md`](installer/CLAUDE.section.md), so both installers
emit identical text). It gives agents the exit-code contract, tells them to run the sign-in
**themselves in the background** and simply ask the developer to sign in at the window that appears,
and states that the session files must never be committed or shared. Re-running replaces only that
marked section. It is written *after* the payload copies, so a failure never leaves a workspace
advertising a toolkit whose scripts didn't land.

An existing `.claude/doorman/doorman.config.json` is picked up by a vendored copy too, so a project
that already used the plugin doesn't get configured twice.

## Configure it (per project)

`doorman.config.json` holds only the five fields that are genuinely project-specific — `appName`,
`baseUrl`, `loginPath`, `defaultCheckPath`, `authenticatedSelector`. Everything else has a built-in
default in `config.mjs`, so you add a field only to change it. Full reference:
[`scripts/README.md`](scripts/README.md#field-reference).

**`baseUrl` fills itself in.** `node detect.mjs --write` reads the project's own files —
`Properties/launchSettings.json`, `.vscode/launch.json`, `vite.config.*`, `angular.json`,
`next.config.*`, `docker-compose.yml`, `package.json` scripts, `.env*`, `appsettings*.json` — ranks
the candidates, and **TCP-probes each one** so a port that is actually listening beats one a config
file merely claims. It also picks up base-path hosting (Vite's `base`, Next's `basePath`) and
suggests `appName` and `defaultCheckPath` where the project states them. Run it any time
(`node detect.mjs` to look, `--write` to apply, `--json` for machine-readable output).

Two guardrails, both deliberate:

- **Non-local URLs are discarded, not ranked, and never probed.** `.env` and `appsettings.*.json`
  routinely hold staging and production URLs; since the whole design persists a live session to
  disk, pointing it at production is the one genuinely damaging mistake available. Anything that
  isn't loopback, a private range, or a `.local`/`.test` domain is reported and dropped.
  `--allow-remote` overrides it explicitly.
- **Nothing is written silently.** Every value it sets is printed with the file and field it came
  from, and existing values are left alone without `--force`. A wrong `baseUrl` then fails as exit 4
  naming the URL it tried.

When it finds nothing usable it writes `"configured": false`, so every script stops with
instructions instead of quietly testing the placeholder. The installers do the same if Node isn't on
`PATH` and detection can't run at all. `loginPath` and `authenticatedSelector` still need a look at
the app's routes — the `doorman:setup` skill does that, or fill them in yourself.

Two fields decide how much browser storage a capture keeps. `captureSessionStorage` defaults to
**on** because MSAL.js / Microsoft Entra ID keep their tokens in `sessionStorage`, which Playwright
otherwise drops — the capture then succeeds but replays a signed-out app, which reads as an expired
session no amount of re-signing-in fixes. The cost is one extra file holding live tokens.
`captureIndexedDB` defaults to **off** (it snapshots the origin's whole IndexedDB, which can be
large); turn it on for Firebase Authentication, and the sign-in tells you when it looks like you
should. Both are explained in
[`scripts/README.md`](scripts/README.md#what-a-session-actually-is-here).

## Use it directly

You never have to, but every script is a plain CLI. From `tools/doorman/` in a vendored install, or
with `$CLAUDE_PLUGIN_ROOT/scripts/` as the prefix under the plugin:

```bash
node paths.mjs                                   # where is the config, the session, the browser?
node detect.mjs                                  # what baseUrl did it find, and is it listening?
node ensure.mjs                                  # verify, and sign in if needed
node shot.mjs /some/route                        # screenshot a gated page
```

See [`scripts/README.md`](scripts/README.md) for the full workflow, exit codes, profiles for
multiple roles, base-path hosting, MSAL/Entra `sessionStorage` and Firebase IndexedDB support, and
how to load the saved session in your own Playwright scripts.

## What's in here

```
doorman/
├── .claude-plugin/
│   ├── plugin.json               # plugin manifest
│   └── marketplace.json          # so this repo can be added as a marketplace
├── skills/
│   ├── get-past-login/SKILL.md   # get through a login, then screenshot/inspect
│   ├── setup/SKILL.md            # configure doorman for a project
│   └── vendor/SKILL.md           # make a committed copy, for CI
├── hooks/
│   ├── hooks.json                # SessionStart -> install-deps.mjs
│   └── install-deps.mjs          # one-off, detached, hash-guarded Playwright install
├── scripts/                      # THE RUNTIME — used by the plugin, copied by the installers
│   ├── paths.mjs                 # plugin vs vendored: where the config/session/output live
│   ├── config.mjs                # config + CLI args (defaults < config file < env < flag)
│   ├── playwright.mjs            # loads Playwright from wherever it is installed
│   ├── session.mjs               # shared browser/verification logic + exit codes
│   ├── verify.mjs                # the session check and its reporting
│   ├── capture.mjs               # the interactive sign-in
│   ├── ensure.mjs                # check, sign in if needed, re-verify — the one entry point
│   ├── detect.mjs                # find baseUrl in the target project's own files
│   ├── login-once.mjs            # interactive capture on its own
│   ├── auth-check.mjs            # headless: verify the saved session
│   ├── shot.mjs                  # headless: screenshot a gated page (verifies first)
│   ├── package.json              # deps: playwright (pinned)
│   ├── package-lock.json         # committed on purpose — one Chromium for the whole team
│   ├── .gitignore                # ignores node_modules / session files / *.png
│   └── README.md                 # the full reference for both modes
├── installer/                    # inputs the installers use; not part of the plugin runtime
│   ├── doorman.config.json       # the placeholder config a vendored install starts from
│   ├── CLAUDE.section.md         # the agent instructions both installers write to CLAUDE.md
│   └── get-past-login.SKILL.template.md
│                                 # optional per-project skill for non-plugin users
├── install.ps1                   # vendored install (PowerShell 7+)
├── install.sh                    # vendored install (macOS / Linux / Git Bash)
├── LICENSE                       # MIT
└── README.md                     # you are here
```

`scripts/` is the single source of truth for the runtime: the plugin executes it in place, and the
installers copy it. There is no second copy to keep in step.

## Prerequisites

- [Node.js](https://nodejs.org/) 20 or newer (the pinned Playwright requires it).
- For `install.ps1` only: [**PowerShell 7+**](https://aka.ms/powershell) on *every* platform.
  Windows ships with Windows PowerShell **5.1**, which is not enough — the script declares
  `#Requires -Version 7.0` and stops with a clear message rather than half-installing. Run
  `install.sh` from Git Bash if you'd rather not install PowerShell 7.

## Updating

**Plugin:** `/plugin update doorman`. A pinned-version bump reinstalls Playwright on the next
session automatically.

**Vendored:** pull this repo, then re-run the installer against each project with the same flags.
Existing files are skipped, so only new toolkit files land; add `-Force`/`--force` to overwrite the
scripts while leaving your config alone.

## Uninstalling a vendored copy

```powershell
./install.ps1 -Workspace C:\src\my-app -Uninstall
```
```bash
./install.sh --workspace ~/src/my-app --uninstall
```

Removes only what the installer added: the files it shipped, the marked `CLAUDE.md` section (and the
file itself if it held nothing else), the skill, and any saved session — those hold live
credentials, so leaving them behind would be worse than deleting them. `node_modules`, your own
scripts, and anything else in the folder are left in place and listed so you can decide.

## Notes

- Playwright is pinned exactly and `scripts/package-lock.json` is committed, so every developer
  installs the same version and shares one cached Chromium download. Only Chromium is installed,
  never Firefox or WebKit. To upgrade: bump the version in `scripts/package.json`, run
  `npm install` there, and commit both files.
- Only point this at local or test environments, never production, and prefer a dedicated test
  account — the whole design persists a live session to disk.

## License

MIT — see [LICENSE](LICENSE).
