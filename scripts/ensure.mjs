// One command to get from "no idea" to "a working session on a gated page".
//
// Checks the saved session; if it is missing or expired, runs the interactive sign-in itself
// and re-verifies afterwards. This is the entry point an AGENT should prefer: a single
// background command replaces check -> branch -> login -> poll.
//
// Run:  node ensure.mjs                     # uses config.defaultCheckPath
//       node ensure.mjs /admin/reports      # make sure this route is reachable
//       node ensure.mjs --profile=admin     # sign in as another role
//       node ensure.mjs --no-login          # check only, never open a browser window
//       node ensure.mjs --clear             # discard the saved session, then sign in again
//       node ensure.mjs --clear --no-login  # just discard it (a local "sign out")
//
// Because it may block for minutes waiting for a human, launch it in the BACKGROUND and watch
// for these marker lines:
//   === SIGN-IN REQUIRED ===   no usable session; a browser window is about to open
//   === WAITING FOR SIGN-IN === the window is open — ask the developer to sign in
//   === SESSION READY ===      the session works; carry on (also printed if none was needed)
//
// Exit codes: 0 ready | 1 signed in but the check still fails | 2 no session (--no-login)
//             3 inconclusive: the route proved nothing (404/5xx/timeout) — signing in can't help
//             4 environment problem | 5 sign-in never completed
import { config, flags, target } from './config.mjs';
import { EXIT, clearSession } from './session.mjs';
import { captureSession } from './capture.mjs';
import { CHECK_SHOT_PATH, loginCommand, reportCheck, runCheck } from './verify.mjs';

const noLogin = flags['no-login'] === true;

if (flags.clear === true) {
  const removed = clearSession();
  console.log(removed.length
    ? `Discarded saved session:\n${removed.map((p) => `   ${p}`).join('\n')}`
    : 'No saved session to discard.');
  if (noLogin) process.exit(EXIT.OK);
}

const first = await runCheck(target, { screenshotPath: CHECK_SHOT_PATH });

if (first.code === EXIT.OK) {
  reportCheck(first);
  console.log('=== SESSION READY ===');
  process.exit(EXIT.OK);
}

// A route that proves nothing either way is not something signing in again can fix.
if (first.code === EXIT.INCONCLUSIVE) {
  reportCheck(first);
  process.exit(EXIT.INCONCLUSIVE);
}

if (noLogin) {
  reportCheck(first);
  console.error('--no-login was passed, so no sign-in was attempted.');
  process.exit(first.code);
}

console.log('=== SIGN-IN REQUIRED ===');
console.log(first.verdict === 'no-session'
  ? `No session captured yet${config.appName ? ` for ${config.appName}` : ''}.`
  : `The saved session is no longer usable: ${first.reasons.join('; ')}.`);
if (first.age) console.log(`It was ${first.age.text}.`);
console.log('Opening a browser window for the interactive sign-in...\n');

const captureCode = await captureSession();
if (captureCode !== EXIT.OK) process.exit(captureCode);

// Re-verify: a sign-in can satisfy the URL heuristics and still not reach the target route.
console.log('');
const second = await runCheck(target, { screenshotPath: CHECK_SHOT_PATH });
reportCheck(second, { showFix: false });

if (second.code === EXIT.OK) {
  console.log('=== SESSION READY ===');
  process.exit(EXIT.OK);
}

if (second.code === EXIT.UNAUTHENTICATED || second.code === EXIT.NO_SESSION) {
  console.error('');
  console.error('The sign-in completed but the session still does not pass the check.');
  console.error('That points at doorman.config.json rather than the sign-in itself — check');
  console.error('authenticatedSelector, authenticatedUrlPattern and loginPathPattern against');
  console.error(`the URL above, then retry with: ${loginCommand()}`);
  process.exit(EXIT.UNAUTHENTICATED);
}

process.exit(second.code);
