# doorman

**Browser automation stops at the login page. Doorman gets your agent past it.**

An AI agent driving a browser can do nearly anything — until a page bounces it to a sign-in form.
It can't type a password, it shouldn't be handed one, and MFA ends the argument there. So the agent
stops, and asks you to go and look yourself.

Doorman removes that roadblock and then gets out of the way. The developer signs in **once**, in a
real browser window; the authenticated session is saved and **replayed** on every later headless
run, until it expires (~4–8h). No password or MFA response is ever automated, stored, or seen by
the agent — the one interactive step stays human. What *is* stored, the saved session, is a bearer
credential while it lasts, and is handled like one (see [Session data](#session-data)).

It is deliberately **not** a testing tool. It doesn't assert, drive flows, or decide what "correct"
looks like. It gets you to the page; what you do once you're there is your business.

It works with forms login, OAuth/OIDC, SAML, enterprise SSO, Microsoft Entra ID, or anything else
that leaves a session cookie or browser storage behind, and it is **stack-agnostic**: it only speaks
HTTP and drives a browser, so the server can be ASP.NET, Django, Flask, Rails, Express, Next.js,
Laravel or Spring without any difference. Node 20+ is needed to run the toolkit, not to build the
app under test. See [Does this work with my app?](scripts/README.md#does-this-work-with-my-app) for
the few auth styles that genuinely can't work.

Doorman is one runtime with two thin plugin adapters, for whichever agent you use — **Claude Code**
and **Codex** are both first-class; there's also a vendored mode for CI and everyone else.

## Install as a plugin (recommended)

**Claude Code:**
```
/plugin marketplace add tonydwoodhouse/doorman
/plugin install doorman
```

**Codex:**
```
/plugin marketplace add tonydwoodhouse/doorman
/plugin install doorman
```

Either way, that's the whole installation. Nothing is copied into your projects, and Playwright
installs itself in the background on your next session start (see
[the execution boundary](#one-thing-that-cannot-be-automated) below for the one thing this can't do
for you).

Then, in any project:

- **"set up doorman for this project"** — the `setup` skill finds the dev server URL in the
  project's own files, works out the login and gated routes, and proves a session can be captured.
- Nothing at all — the `get-past-login` skill fires on its own the moment the agent hits a
  login redirect, a 401, or a page that renders signed-out. It verifies the session, asks you to
  sign in at a browser window if it needs one, and then continues what it was doing. Asking for it
  by name (**"screenshot the admin dashboard"**, **"check my CSS change on the settings page"**)
  works too.
- **"vendor doorman into this repo"** — the `vendor` skill sets up the committed copy described
  below, for CI.

(Claude Code addresses these as `doorman:setup` / `doorman:get-past-login` / `doorman:vendor`;
Codex matches them by description automatically, or you can mention them with `$setup` etc. — same
skills, same behavior, different addressing convention.)

### Where the plugin keeps things

| | |
|---|---|
| config | `<project>/.doorman/doorman.config.json` — per project, safe to commit |
| session files | the host's plugin data directory, **outside every project** |
| screenshots | the host's plugin data directory, per project |
| Playwright | the host's plugin data directory, once per machine |

Keeping the session out of the repository is deliberate: `storageState.json` is a live session, and
the surest way to stop it being committed is for it never to be on the project's disk. Run
`node <plugin>/scripts/paths.mjs` to print exactly where everything resolved (the skills know the
plugin's path; `<plugin>` is the installed copy under `~/.claude/plugins/cache/` or
`~/.codex/plugins/cache/`).

The `SessionStart` hook that installs Playwright is guarded by a hash of `scripts/package.json` +
`package-lock.json`: it acts once, does nothing on every later session, and picks up a version bump
automatically. It runs detached, so it never delays a session. `DOORMAN_SKIP_INSTALL=1` disables it.
Concurrent sessions share one install through a lock; a lock left by an install that was killed is
recognized (its process is gone, or it is hours old), cleared with a one-line note, and retried.
Both hosts support plugin-bundled `SessionStart` hooks; if yours hasn't trusted/enabled it yet, the
skills fall back to telling you to run `node install-deps.mjs --sync` by hand.

### Session data

Doorman never captures a password or an MFA response, but the session it saves — cookies and
browser storage for the app, and usually for its identity provider too — works like a password
until it expires. Anyone who can read the file can replay the sign-in. So:

- Session files are written **owner-only** (`0600` in a `0700` directory on macOS/Linux; an ACL
  naming only your account on Windows), atomically, via a temporary file and a rename.
- Every capture starts from an **empty browser**, so nothing from your own browsing is ever in it.
- The sign-in prints **which sites** it saved data for — host and count, never a value — and points
  out anything that is neither the app nor its identity provider. `captureOrigins` can restrict the
  saved session to a list of hosts.
- Doorman **refuses to save a session** where Git could commit it: inside a repository, the files
  must be ignored (the vendored copy ships that `.gitignore`), or it stops before the browser opens.

### One thing that cannot be automated

Interactive sign-in opens a real, visible browser window and waits for a human to use it. That
needs a local desktop — it will not work in a remote or cloud sandbox where nobody can see or click
through the window that opens. Everything else in doorman works headlessly; this one step doesn't,
by design (see the top of this README). That includes CI — see
[Getting a session into CI](#getting-a-session-into-ci) for how a captured session gets there
without one.

## Vendored mode (a committed copy, for CI)

For a CI job, or teammates without a plugin installed, install a self-contained copy into the
project instead. Clone this repo once, then:

**Windows / PowerShell 7+:**
```powershell
cd path\to\doorman
./installers/install.ps1 -Workspace C:\src\my-app -InstallSkill -Bootstrap
```

**macOS / Linux / Git Bash:**
```bash
cd path/to/doorman
./installers/install.sh --workspace ~/src/my-app --install-skill --bootstrap
```

Flags (both installers):

| PowerShell | bash | Effect |
|---|---|---|
| `-Workspace <path>` | `--workspace <path>` | Target repo root (default: current dir). |
| `-ToolsDir <rel>` | `--tools-dir <rel>` | Where to put it (default `tools/doorman`). |
| `-InstallSkill` | `--install-skill` | Also drop per-project skills — `.claude/skills/get-past-login/SKILL.md` and `.agents/skills/get-past-login/SKILL.md`. Only useful if some contributors don't have a plugin. |
| `-Bootstrap` | `--bootstrap` | Run `npm install` + `npx playwright install chromium` after copying. |
| `-Force` | `--force` | Overwrite existing files (otherwise existing files are skipped). |
| `-Uninstall` | `--uninstall` | Remove what was installed (see below). |

Vendored, everything lives together in `tools/doorman/`: the scripts, the config, and the session
files — which the shipped `.gitignore` keeps out of source control. That last point is the trade-off
against the plugin, so make it knowingly.

### Getting a session into CI

Vendoring installs the toolkit; it does not capture a session for you. Capture is still the one
interactive step from [above](#one-thing-that-cannot-be-automated), and a CI runner has no visible
desktop to do it on — so it has to happen somewhere that does, then be carried into CI out of band:

1. On a machine with a real desktop — a developer's, most likely — run the vendored copy's
   `ensure.mjs` once, signed in as whatever account CI should use.
2. Take `storageState.json` (and `sessionStorage.json`, if it exists) out of `tools/doorman/` and
   store them as CI secrets. Never commit them — they're a live, replayable session, not config.
3. In the CI job, before any doorman script runs, write those secrets back to the same filenames
   inside `tools/doorman/`, then call only the headless scripts — `auth-check.mjs`, `shot.mjs`, or
   your own script importing `session.mjs`. Never call `ensure.mjs` or `login-once.mjs` in CI; both
   try to open a browser window for a human who isn't there.

There's no human in CI to redo this when the session expires (~4–8h, or whatever the app actually
does), so budget for re-capturing and re-uploading the secret on a schedule, or accept that the job
starts failing until someone does.

The installer never copies per-developer artifacts (`node_modules/`, session files, `*.png`) and
**skips files that already exist** unless `-Force`/`--force`, so re-running to pick up an update
won't clobber a customized `doorman.config.json`. When it creates the config it runs
`node detect.mjs --write` to fill in `baseUrl`; that needs only Node builtins, so it happens before
any `npm install`, and it never fails the install.

Every vendored install also writes a clearly marked `doorman` section into the workspace's
`CLAUDE.md` **and** `AGENTS.md` (from [`installers/CLAUDE.section.md`](installers/CLAUDE.section.md)
and [`installers/AGENTS.section.md`](installers/AGENTS.section.md) — near-identical text, since
neither references anything plugin-specific). It gives agents the exit-code contract, tells them to
run the sign-in **themselves in the background** and simply ask the developer to sign in at the
window that appears, and states that the session files must never be committed or shared.
Re-running replaces only the marked section in each file. Both are written *after* the payload
copies, so a failure never leaves a workspace advertising a toolkit whose scripts didn't land.

An existing `.doorman/doorman.config.json` is picked up by a vendored copy too, so a project
that already used a plugin doesn't get configured twice.

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
the app's routes — the `setup` skill does that, or fill them in yourself.

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
under a plugin with the installed plugin's `scripts/` directory as the prefix:

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
doorman/                          # the repository root IS the plugin, for both hosts
├── .claude-plugin/
│   ├── plugin.json               # Claude Code plugin manifest
│   └── marketplace.json          # Claude Code marketplace -> this directory
├── .codex-plugin/
│   └── plugin.json               # Codex plugin manifest (points at the same skills/ and hooks/)
├── .agents/
│   └── plugins/
│       └── marketplace.json      # Codex marketplace -> this directory
├── skills/{get-past-login,setup,vendor}/SKILL.md   # one set of skills, shared by both hosts
├── hooks/hooks.json              # SessionStart -> scripts/install-deps.mjs (both hosts)
├── scripts/                      # THE RUNTIME — used by both plugins and copied by the installers
│   ├── paths.mjs                 # plugin vs vendored: where the config/session/output live
│   ├── config.mjs                # config + CLI args (defaults < config file < env < flag)
│   ├── playwright.mjs            # loads Playwright from wherever it is installed
│   ├── session.mjs               # shared browser/verification logic + exit codes
│   ├── verdict.mjs               # valid / invalid / inconclusive, from what a page load showed
│   ├── origins.mjs               # which sites a saved session holds data for; captureOrigins
│   ├── secure-files.mjs          # owner-only atomic writes; refuses Git-trackable session paths
│   ├── verify.mjs                # the session check and its reporting
│   ├── capture.mjs               # the interactive sign-in
│   ├── ensure.mjs                # check, sign in if needed, re-verify — the one entry point
│   ├── detect.mjs                # find baseUrl in the target project's own files
│   ├── login-once.mjs            # interactive capture on its own
│   ├── auth-check.mjs            # headless: verify the saved session
│   ├── shot.mjs                  # headless: screenshot a gated page (verifies first)
│   ├── install-deps.mjs          # one-off, detached, hash-guarded Playwright install (SessionStart hook)
│   ├── package.json              # deps: playwright (pinned)
│   ├── package-lock.json         # committed on purpose — one Chromium for the whole team
│   ├── .gitignore                # ignores node_modules / session files / *.png
│   └── README.md                 # the full reference for every mode
├── config/
│   └── doorman.config.example.json   # the placeholder config a vendored install starts from
├── installers/                   # vendored install; not used by the plugin runtime
│   ├── install.ps1               # vendored install (PowerShell 7+)
│   ├── install.sh                # vendored install (macOS / Linux / Git Bash)
│   ├── CLAUDE.section.md         # the agent instructions both installers write to CLAUDE.md
│   ├── AGENTS.section.md         # same instructions, written to AGENTS.md
│   └── get-past-login.SKILL.template.md   # optional per-project skill (Claude Code and Codex)
├── test/                         # node:test suite — `npm test` (fixture app + end-to-end runs)
└── package.json                  # repository dev tasks only; the runtime's manifest is scripts/package.json
```

`scripts/` is the single source of truth for the runtime: both plugins execute it in place, and the
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
./installers/install.ps1 -Workspace C:\src\my-app -Uninstall
```
```bash
./installers/install.sh --workspace ~/src/my-app --uninstall
```

Removes only what the installer added: the files it shipped, the marked `CLAUDE.md` and `AGENTS.md`
sections (and either file itself if it held nothing else), the skills, and any saved session — those
hold live credentials, so leaving them behind would be worse than deleting them. `node_modules`,
your own scripts, and anything else in the folder are left in place and listed so you can decide.

## Notes

- Playwright is pinned exactly and `scripts/package-lock.json` is committed, so every developer
  installs the same version and shares one cached Chromium download. Only Chromium is installed,
  never Firefox or WebKit. To upgrade: bump the version in `scripts/package.json`, run
  `npm install` there, and commit both files.
- Only point this at local or test environments, never production, and prefer a dedicated test
  account — the whole design persists a live session to disk.
- Interactive sign-in needs a local, visible desktop — see
  [One thing that cannot be automated](#one-thing-that-cannot-be-automated) above.

## License

MIT — see [LICENSE](LICENSE).
