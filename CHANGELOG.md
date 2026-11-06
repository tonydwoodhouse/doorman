# Changelog

## 0.2.2

- **The agent now checks its UI changes in a browser instead of signing off without looking.** The
  session-start note used to say what to do "when you need to see a signed-in page" — but an agent
  assumes it has no browser, never decides it needs one, and finished with "I haven't checked it in
  a browser". The note now says it *can* open the app's pages as a signed-in user, and should
  screenshot whatever its change affects before reporting the work as done.
- **A `Stop` hook backs that up** (`scripts/verify-nudge.mjs`). If files that show on a page have
  changed since the session began and `shot.mjs` hasn't written a screenshot since, it asks the
  agent to look before finishing — or to say in a line why it can't or needn't. Once per set of
  changes, never in a loop, silent without git or a doorman config. New settings: `verifyNudge`
  (`false` turns it off), `uiFilePattern` and `uiFileIgnorePattern` (what counts as UI).
- `get-past-login`'s description now leads with checking a page, not with login walls, so it
  matches when the agent is finishing a feature. The vendored `CLAUDE.md`/`AGENTS.md` section and
  the Codex `AGENTS.md` pointer that `setup` writes say the same.

## 0.2.1

- **The agent now knows doorman is there before it hits a login wall.** A second `SessionStart`
  hook (`scripts/session-context.mjs`) tells it, in any project with a doorman config, to use
  `get-past-login` whenever a page it needs to check requires a signed-in user. Until now the
  plugin relied on the skill description alone, so an agent building a feature often skipped the
  browser check or stopped at the login. Nothing is written into the project.
- Under Codex, where a marketplace install runs no hooks, `setup` adds the same reminder as one
  marked line in the project's `AGENTS.md`, worded for teammates who don't have the plugin.

## 0.2.0

The first release meant to be installed by people other than its author. Every change below has
tests (`npm test`; CI on Linux, Windows and macOS).

### Plugin

- **The repository root is the plugin**, for Claude Code and Codex alike: one set of skills, one
  `hooks/hooks.json`, one `scripts/` runtime. Both hosts copy only the plugin directory into their
  cache, so the old `integrations/` subfolders could not have worked once installed.
- The Codex marketplace entry carries the `policy` Codex requires, and the README gives Codex's real
  install steps (`codex plugin marketplace add`, then `codex plugin add doorman@doorman`). Codex runs plugin hooks
  only for manual desktop installs, so after a Codex marketplace install Playwright is installed with
  one `install-deps.mjs --sync` the skills prompt for.
- The plugin data directory is recorded on first use (`~/.doorman/plugin-roots/`), because neither
  host exports it to the shell the agent runs commands in — without this the hook installed
  Playwright in one place and the scripts looked in another.
- The project config moved to `<project>/.doorman/doorman.config.json` (Claude Code treats
  `.claude/` as sensitive and won't let an agent edit it unprompted). 0.1.0's location is still read.

### Verification

- **Three outcomes instead of two.** A check is `valid` (exit 0), `invalid` (exit 1, sign in again)
  or `inconclusive` (exit 3: a 404, 5xx, timeout or redirect loop proves nothing either way). 0.1.0
  reported those as "session fine, bad route", claiming a valid session on no evidence. Exit 3 keeps
  its number; `EXIT.BAD_ROUTE` remains as an alias.
- A success with no positive signal configured says its evidence is status-only.
- New settings: `authenticatedText`, `unauthenticatedSelector` (for SPAs that answer 200 and render
  a sign-in form), `navigationTimeoutMs`.
- An unexpected crash exits 4 (environment), never 1, so it can't be mistaken for an expired session.
- Git Bash's rewriting of `/route` arguments into Windows paths is undone, or refused with the fix.

### Session data

- Saved sessions are described as what they are — bearer credentials — and handled that way:
  written owner-only (`0600` / an owner-only ACL on Windows) and atomically.
- A capture refuses to save a session anywhere Git could commit it.
- A capture lists the hosts it saved data for (counts, never values) and flags unexpected ones.
  New `captureOrigins` setting restricts the saved session to a host allowlist.

### Installers (vendored mode)

- **`doorman.config.json` is never overwritten**, `--force` included. It is created once by
  `detect.mjs` (seeded from the project's plugin config if there is one), checked on upgrade with
  the new `check-config.mjs`, and replaced only by the new `--reset-config` / `-ResetConfig`, which
  keeps a `.bak`.
- **Ownership-aware install and uninstall.** Every installed file is recorded with its hash in
  `.doorman/install-manifest.json`. Re-runs update only files nobody changed; `--force` keeps a
  `.bak` of anything it overwrites that doorman didn't write. A file it has no record of is never
  claimed without `--force`, even one identical to doorman's (a 0.1.0 copy, say). Uninstall removes
  only unchanged files from the receipt, keeps changed ones, restores `.bak`s, and with no receipt
  removes nothing.
- Every script warns about config settings it doesn't recognize.

### Dependency install

- The install lock records its PID, host and start time and is taken exclusively. A lock left by a
  killed install is detected and cleared instead of blocking every later install; `--sync` waits
  for a live install instead of failing.

### Documentation

- Session lifetime is no longer quoted as "~4–8h": it is whatever the app decides.
- "Works with anything that leaves browser storage" is replaced by what the suite proves, plus a list
  of what can still prevent replay (popup sign-in, device- or IP-bound sessions, anti-automation,
  in-memory refresh tokens) and what to do about each.

## 0.1.0

Initial version.
