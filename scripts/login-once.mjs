// One-time interactive login capture for any browser-based authentication system.
// Opens a VISIBLE browser. YOU complete the sign-in + MFA yourself.
// On success, saves the authenticated session to storageState.json (gitignored)
// for headless reuse by UI tests / screenshots.
//
// Config: edit doorman.config.json (baseUrl, loginPath, authenticatedSelector, ...).
// Prereqs: the dev server must be running at config.baseUrl.
//
// Run:  node login-once.mjs
//       node login-once.mjs --profile=admin      # keep a second session for another role
//       DOORMAN_BASE_URL=https://... node login-once.mjs    # one-off base URL override
//
// This blocks for up to config.loginTimeoutMs (default 5 min) waiting for a human, so an
// agent must launch it in the BACKGROUND and watch for the marker lines it prints.
// `node ensure.mjs` does check-then-login in one step and is usually the better entry point.
//
// Exit codes: 0 session saved | 4 environment problem | 5 sign-in never completed
import { captureSession } from './capture.mjs';

process.exitCode = await captureSession();
