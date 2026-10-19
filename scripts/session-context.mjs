// Tell the agent, at the start of every session, that this project has doorman set up.
//
// Runs on SessionStart. Whatever a SessionStart hook prints is added to the agent's context, and
// without this the get-past-login skill only comes to mind once something has already failed: an
// agent building a feature has no reason to think a signed-in browser check is even possible, so it
// skips verifying the UI, or stops at the login wall instead of reaching for the skill.
//
// This is the plugin's counterpart to the section the vendored installer writes into CLAUDE.md and
// AGENTS.md. Saying it here instead means nothing is written into the project: no line goes stale,
// uninstalling the plugin leaves nothing behind, and a teammate without the plugin is never pointed
// at a skill they don't have.
//
// Silent, and always exit 0, unless the project has a doorman config that isn't switched off with
// "configured": false (an app with no sign-in yet). Never fail a session over this.
import { readFileSync } from 'fs';
import { relative } from 'path';
import { CONFIG_EXISTS, CONFIG_PATH, PROJECT_DIR } from './paths.mjs';

function configured() {
  if (!CONFIG_EXISTS) return false;
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))?.configured !== false;
  } catch {
    // A config that doesn't parse is still a project that uses doorman; the scripts will say what's
    // wrong with it the first time one runs.
    return true;
  }
}

if (configured()) {
  const config = relative(PROJECT_DIR, CONFIG_PATH).replaceAll('\\', '/');
  console.log(
    `doorman is set up for this project (${config}). When you need to see or verify a page that ` +
    'requires a signed-in user (checking a UI change, taking a screenshot, inspecting layout), or ' +
    'a page redirects to a login, returns 401 or 403, or renders signed-out, use the doorman ' +
    'get-past-login skill to get a signed-in browser session. Don\'t skip the check, stop at the ' +
    'login wall, or ask the developer for credentials.',
  );
}
