// Before the agent finishes, make sure it has looked at the UI it changed.
//
// Runs on Stop. The session-start note (session-context.mjs) tells the agent it can check pages in
// a browser; this is the backstop for when it forgets and is about to report UI work as done on the
// strength of the unit tests alone. If files that show on a page have changed since the session
// began, and shot.mjs hasn't written a screenshot since the newest of those changes, it asks the
// agent to carry on and look — or to say in a line why it can't or needn't.
//
// It nudges once per set of changes. The answer it gets may well be "this change has no visible
// effect", and a hook that refused to take that for an answer would be switched off within a day.
// So it records how far it has nudged and stays quiet until a newer change appears; it also never
// blocks a stop that a Stop hook already continued (stop_hook_active), which rules out loops.
//
// Silent, and always exit 0, when any of these hold: no doorman config, "configured": false,
// "verifyNudge": false, no git, no record of when the session started, or nothing changed since.
// Never fail a session over this.
import { statSync } from 'fs';
import { lastShotAt, recordNudge, recordSessionStart, sessionRecord } from './activity.mjs';
import { hookConfig, readHookInput } from './hook-support.mjs';
import { PROJECT_DIR } from './paths.mjs';
import { changedFiles, uiFileMatcher } from './ui-files.mjs';

const MAX_FILES_LISTED = 5;

/** When the session started: recorded by session-context.mjs, or failing that (a session that
 *  began before this version was installed) the creation time of its transcript. */
function sessionStart(input) {
  const record = sessionRecord(input.session_id);
  if (record) return record;
  try {
    const born = statSync(input.transcript_path).birthtimeMs;
    if (born > 0) {
      recordSessionStart(input.session_id, born);
      return sessionRecord(input.session_id);
    }
  } catch {
    // No transcript path, or a filesystem that doesn't keep creation times.
  }
  return null;
}

function describe(file) {
  if (file.deleted) return `${file.path} (deleted)`;
  if (file.from) return `${file.from} → ${file.path}`;
  return file.path;
}

function reasonFor(files) {
  const listed = files.slice(0, MAX_FILES_LISTED).map(describe).join(', ');
  const more = files.length > MAX_FILES_LISTED ? ` and ${files.length - MAX_FILES_LISTED} more` : '';
  return (
    `doorman: you changed UI files this session (${listed}${more}) and haven't looked at them in ` +
    'a browser since. Before reporting the work as done, use the doorman get-past-login skill to ' +
    'screenshot the affected page(s) and open the PNG with the Read tool; start the dev server ' +
    'first if it isn\'t running. If the change has no visible effect, you can\'t check it here, or ' +
    'you are stopping to ask the developer something, say so in one line and stop — this reminder ' +
    'won\'t repeat for these changes.'
  );
}

async function main() {
  const config = hookConfig();
  if (config === null || config.verifyNudge === false) return;

  const input = await readHookInput();
  if (input.stop_hook_active === true) return;

  const session = sessionStart(input);
  if (!session) return;

  const files = changedFiles(PROJECT_DIR);
  if (!files) return;

  const since = Math.max(session.startedAt, lastShotAt(), session.nudgedUpTo ?? 0);
  const isUi = uiFileMatcher(config);
  const unchecked = files
    .filter((f) => f.mtimeMs > since && (isUi(f.path) || (f.from !== undefined && isUi(f.from))))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!unchecked.length) return;

  recordNudge(input.session_id, unchecked[0].mtimeMs);
  console.log(JSON.stringify({ decision: 'block', reason: reasonFor(unchecked) }));
}

try {
  await main();
} catch {
  // Never stand between the agent and the end of its turn over a bug in a reminder.
}
