---
name: "vendor"
description: "Copy the doorman toolkit into this project as a self-contained tools/doorman folder, for CI or for teammates who don't use Claude Code. Only use when asked for a vendored or committed copy."
user-invocable: true
disable-model-invocation: false
---

# Vendoring doorman into this project

Normally the plugin *is* the runtime and nothing needs to be copied into the project. Vendoring is
for the cases where something other than Claude Code has to run these checks:

- a CI job, or any script that can't assume the plugin is installed;
- teammates who don't use Claude Code but want the same commands;
- pinning an exact copy of the toolkit alongside the app it tests.

**Ask before doing this if the developer only asked for a UI test.** It adds a committed directory
and moves the saved session back inside the project, which is a real trade-off, not a detail.

## What changes

| | Plugin (default) | Vendored |
|---|---|---|
| scripts | in the plugin, shared, updated with it | committed at `tools/doorman/` |
| config | `.claude/doorman/doorman.config.json` | `tools/doorman/doorman.config.json` |
| session files | plugin data directory, outside the repo | `tools/doorman/`, gitignored |
| dependencies | installed once per machine | `tools/doorman/node_modules` per project |

The session moving back inside the repo is the part that matters: a vendored install relies on the
shipped `.gitignore` to keep `storageState.json` out of source control. Say that plainly.

An existing `.claude/doorman/doorman.config.json` is reused automatically by the vendored copy's
`detect.mjs` run, so configuring twice isn't necessary.

## Doing it

From the project root, with `$PLUGIN` as the plugin directory (`$CLAUDE_PLUGIN_ROOT`, or `../..`
relative to this file):

```bash
# macOS / Linux / Git Bash
"$PLUGIN/install.sh" --workspace . --bootstrap

# Windows PowerShell 7+
& "$PLUGIN/install.ps1" -Workspace . -Bootstrap
```

Add `--install-skill` / `-InstallSkill` to also write `.claude/skills/get-past-login/SKILL.md` into the
project — worth it only if some contributors won't have the plugin, since it duplicates what the
plugin's own `get-past-login` skill already provides.

The installer also writes a marked `doorman` section into the project's `CLAUDE.md`, skips files
that already exist unless `--force`, and runs URL detection when it creates the config. `--uninstall`
removes exactly what it added, including any saved session.

Afterwards, run the commands from `tools/doorman/` (`node ensure.mjs`, `node shot.mjs /route`) —
the vendored copy resolves its config and session files beside itself.

## Rules

- Never commit `storageState*.json` or `sessionStorage*.json`. Check the shipped `.gitignore`
  survived, and check `git status` before telling the developer they're done.
- Local and test environments only, never production.
