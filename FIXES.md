# Fixes to make this a shippable plugin

## 1. Make uninstall ownership-aware

Problem: uninstall currently removes files based on their names, even if they existed before Doorman was installed or were subsequently replaced by the user.

Proposal: create an installation receipt such as `.doorman/install-manifest.json`. For every installed file, record:

- Relative path
- SHA-256 hash after installation
- Whether Doorman created or updated it
- Doorman version that installed it

During uninstall:

- Delete only files listed in the receipt.
- Delete them only if their current hash matches the installed hash.
- Preserve modified files and print a warning.
- Never delete directories unless they are empty.
- Remove the receipt last.

If `--force` replaces a pre-existing file, first create a backup and record that fact. Ideally, however, `--force` should not claim ownership of unrelated existing files.

Acceptance test: install over a project containing its own `SKILL.md`, modify an installed script, then uninstall. Both user-owned and modified files must remain.

## 2. Separate managed runtime files from user configuration

Problem: `--force` overwrites `doorman.config.json`, contradicting the documented promise that upgrades preserve configuration.

Proposal:

- Treat scripts, package metadata, and skill instructions as managed files.
- Treat `doorman.config.json` as permanently user-owned.
- On first install, create it only when it does not exist.
- On upgrades, install a new `doorman.config.example.json` or compare the current config schema and report suggested additions.
- Add a separate, explicit `--reset-config` option if replacing configuration is genuinely needed.
- Validate old configurations and warn about deprecated or missing fields without rewriting them.

If automatic migrations become necessary, preserve a timestamped backup and make migrations narrowly scoped rather than regenerating the entire file.

Acceptance test: customize every configuration value, run an upgrade with `--force`, and verify the config is byte-for-byte unchanged.

## 3. Harden and accurately describe stored session data

Problem: captured browser state can contain cookies and storage for identity-provider origins, and those artifacts can be as powerful as credentials while valid.

Proposal:

- Change the documentation from “no credentials stored” to something like: “Doorman does not capture passwords or MFA responses, but stored session artifacts are sensitive bearer credentials.”
- Ensure session directories and every written file have owner-only permissions:
  - Unix: directories `0700`, files `0600`.
  - Windows: an ACL granting access only to the current user, where practical.
- Write files atomically via a temporary file followed by rename.
- Keep using a fresh Playwright context so unrelated personal browser state is never included.
- Add configurable origin handling:
  - `captureOrigins: "flow"` for all origins involved in login, preserving compatibility.
  - An explicit allowlist for stricter installations.
  - Report which origins were saved, without printing cookie values.
- Warn when unexpectedly broad or unrelated origins are captured.
- Add prominent `.gitignore` guidance and refuse to store sessions inside a Git repository unless explicitly configured.
- Consider optional OS-backed encryption later, but don’t make cross-platform encryption a prerequisite for fixing basic filesystem security.

Acceptance test: verify permissions, inspect the saved origins, confirm no values are logged, and ensure session files are not accidentally staged by Git.

## 4. Stop treating every non-auth failure as proof of a valid session

Problem: a `404` or `500` with no detected login page does not prove authentication succeeded.

Proposal: use three verification outcomes:
- `valid`: explicit positive authentication evidence, or a successful protected response with no failure signals.
- `invalid`: explicit authentication failure, such as login redirect, configured selector, known unauthenticated URL, or `401/403`.
- `inconclusive`: `404`, `5xx`, navigation failure, timeout, or another result that establishes neither validity nor invalidity.

Add optional positive signals to the configuration, for example:

```json
{
  "verify": {
    "authenticatedUrlPatterns": ["/dashboard"],
    "authenticatedSelectors": ["[data-testid='account-menu']"],
    "authenticatedText": ["Sign out"]
  }
}
```

For applications without positive signals, a `2xx` response on the configured protected URL can remain the practical default. Non-`2xx` responses should not print `VALID`.

Preserve stable machine-readable exit codes, but rename/document code 3 as `INCONCLUSIVE` or `ROUTE_ERROR`, not “session valid.”

Acceptance test: cover `200`, login redirect, `401`, `403`, `404`, `500`, timeout, and a SPA shell that returns `200` while displaying a login component.

## 5. Recover from stale dependency-install locks

Problem: if dependency installation is killed, the `.installing` marker can remain indefinitely and suppress future installation attempts.

Proposal: make the lock structured rather than just a marker:

```json
{
  "pid": 12345,
  "startedAt": "2026-08-14T10:00:00Z",
  "host": "machine-name"
}
```

When encountering a lock:

- Check its age.
- Check whether its PID is still running on the same host.
- Treat it as stale if the process is gone or it exceeds a conservative timeout.
- Remove stale locks and continue.
- Always remove the lock in a `finally` block after normal failures.
- Print a concise recovery message when a stale lock is cleared.

For stronger concurrency protection, create the lock exclusively so two agents cannot both believe they acquired it.

Acceptance test: create an old lock with a nonexistent PID and confirm installation recovers; create a live lock and confirm a second installer exits safely.

## 6. Add a real automated test matrix

Problem: syntax checks are useful but do not establish that capture and replay work across supported authentication patterns.

Proposal: add layered tests.

Unit tests should cover:

- Configuration loading and validation
- Profile naming and path isolation
- Session expiry calculations
- Origin restrictions
- Verification classification
- Lock acquisition and stale-lock recovery
- Installer manifest and uninstall decisions

Fixture applications should simulate:

- Cookie-based sessions
- `localStorage`
- `sessionStorage`
- Optional IndexedDB
- Login redirects
- `401/403`
- False-positive `404/500` routes
- Expired sessions
- Multiple profiles
- A separate identity-provider origin
- SPA login screens returning HTTP `200`

End-to-end Playwright tests should capture a session using the fixture app, close the context, replay it in a fresh context, and verify access to a protected page.

Installer tests should run in temporary directories on both PowerShell and shell implementations and verify install, upgrade, user modifications, and uninstall behavior.

Also adjust the claims based on those tests: describe the mechanisms proven by the suite rather than saying it works with effectively any browser authentication. OAuth providers and applications using device-bound tokens, unusual popup flows, or anti-automation controls should be documented as possible limitations.

## 7. Two claims should be softened

- “~4–8h” is application-specific; sessions may last minutes, days, or refresh indefinitely.
- “Anything that leaves browser storage behind” is directionally correct, but popup-based flows, multi-origin storage, unusual post-login routes, device-bound sessions, IP binding, and anti-automation controls can still prevent replay.