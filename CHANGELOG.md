# Changelog

## 0.2.0

The first release meant to be installed by people other than its author. Every change below has
tests (`npm test`; CI on Linux, Windows and macOS).

### Plugin

- **The repository root is the plugin**, for Claude Code and Codex alike: one set of skills, one
  `hooks/hooks.json`, one `scripts/` runtime. Both hosts copy only the plugin directory into their
  cache, so the old `integrations/` subfolders could not have worked once installed.
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
  `.bak` of anything it overwrites that doorman didn't write. Uninstall removes only unchanged files
  from the receipt, keeps changed ones, restores `.bak`s, and with no receipt removes nothing.
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
