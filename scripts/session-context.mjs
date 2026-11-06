// Tell the agent, at the start of every session, that this project has doorman set up — and so that
// it can, and should, look at its UI changes in a real browser.
//
// Runs on SessionStart. Whatever a SessionStart hook prints is added to the agent's context. An
// agent assumes it has no browser, so a note that only says what to do "when you need to check a
// signed-in page" never fires: it doesn't think it can, runs the unit tests, and reports "I haven't
// checked it in a browser". So the note states the capability and the expectation, not just the
// trigger. verify-nudge.mjs (on Stop) is the backstop for when the agent forgets anyway.
//
// This is the plugin's counterpart to the section the vendored installer writes into CLAUDE.md and
// AGENTS.md. Saying it here instead means nothing is written into the project: no line goes stale,
// uninstalling the plugin leaves nothing behind, and a teammate without the plugin is never pointed
// at a skill they don't have.
//
// It also records when the session started, which verify-nudge.mjs needs so that files changed
// before the session (by the developer, or an earlier session) never count against this one.
//
// Silent, and always exit 0, unless the project has a doorman config that isn't switched off with
// "configured": false (an app with no sign-in yet). Never fail a session over this.
import { relative } from 'path';
import { recordSessionStart } from './activity.mjs';
import { hookConfig, readHookInput } from './hook-support.mjs';
import { CONFIG_PATH, PROJECT_DIR } from './paths.mjs';

function sessionNote(configLabel) {
  return (
    `doorman is set up for this project (${configLabel}), so you CAN open this app's pages in a ` +
    'real browser as a signed-in user. After any change that affects what a page shows (markup, ' +
    'styles, components, templates), use the doorman get-past-login skill to screenshot the ' +
    'affected page and open the PNG before you report the work as done; start the dev server ' +
    'first if it isn\'t running. Don\'t finish with "I haven\'t checked it in a browser": check it. ' +
    'Use the same skill whenever a page redirects to a login, returns 401 or 403, or renders ' +
    'signed-out. Never ask the developer for credentials.'
  );
}

if (hookConfig() !== null) {
  const input = await readHookInput();
  recordSessionStart(input.session_id);
  console.log(sessionNote(relative(PROJECT_DIR, CONFIG_PATH).replaceAll('\\', '/')));
}
