// Plumbing shared by the plugin's hooks (session-context.mjs, verify-nudge.mjs).
import { readFileSync } from 'fs';
import { CONFIG_EXISTS, CONFIG_PATH } from './paths.mjs';

/**
 * The JSON a host passes a hook on stdin (session_id, cwd, and per-event fields such as
 * stop_hook_active). Resolves {} when there is none — run by hand from a terminal, or a host that
 * sends nothing — and never rejects, so a hook can always carry on with what it knows.
 */
export function readHookInput(timeoutMs = 2000) {
  if (process.stdin.isTTY) return Promise.resolve({});
  return new Promise((done) => {
    let text = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.pause();
      try {
        const parsed = JSON.parse(text);
        done(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
      } catch {
        done({});
      }
    };
    // A host that leaves stdin open without writing to it must not hang the session.
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { text += chunk; });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

/**
 * The project's doorman config as hooks see it: the parsed object, {} for a config that exists but
 * doesn't parse (still a project that uses doorman — the scripts will say what's wrong the first
 * time one runs), or null when hooks should stay silent: no config, or "configured": false.
 *
 * Hooks read the file themselves rather than importing config.mjs, which exits on a bad config and
 * prints warnings — neither of which belongs in the middle of someone's session.
 */
export function hookConfig() {
  if (!CONFIG_EXISTS) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed.configured === false ? null : parsed;
}
