// What the agent has done in this project, so the Stop hook can tell whether a UI change has been
// looked at in a browser since it was made.
//
// Three facts, all kept in the project's directory under the plugin's data directory (never in the
// project itself):
//
//   sessions/<id>.json  when each agent session started, and the newest file change the Stop hook
//                       has already nudged about in it — so it nudges once per change, not forever
//   last-shot.json      when shot.mjs last wrote a screenshot for this project
//
// Vendored, there are no hooks to read any of this, so every function is a quiet no-op. Nothing
// here ever throws: losing one of these records only means one nudge too many or too few, which is
// never worth failing a screenshot or a session over.
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { PROJECT_DATA_DIR, ensureDir } from './paths.mjs';

const SESSIONS_DIR = PROJECT_DATA_DIR ? join(PROJECT_DATA_DIR, 'sessions') : null;
const LAST_SHOT = PROJECT_DATA_DIR ? join(PROJECT_DATA_DIR, 'last-shot.json') : null;

// Session records older than this are swept away at the next session start.
const SESSION_RECORD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(path, value, flag = 'w') {
  try {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag });
    return true;
  } catch {
    return false;
  }
}

/** File for a session ID, or null when there's nowhere to keep it or the ID isn't usable as a
 *  file name. Host session IDs are UUIDs; anything else is refused rather than escaped. */
function sessionFile(sessionId) {
  if (!SESSIONS_DIR || typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
    return null;
  }
  return join(SESSIONS_DIR, `${sessionId}.json`);
}

function sweepOldSessions(now) {
  try {
    for (const name of readdirSync(SESSIONS_DIR)) {
      const path = join(SESSIONS_DIR, name);
      if (now - statSync(path).mtimeMs > SESSION_RECORD_TTL_MS) unlinkSync(path);
    }
  } catch {
    // Housekeeping only.
  }
}

/**
 * Note that a session started. SessionStart fires again on resume and after compaction with the
 * same ID; only the first time counts, because files the agent changed before a compaction are
 * still its own changes.
 */
export function recordSessionStart(sessionId, now = Date.now()) {
  const file = sessionFile(sessionId);
  if (!file) return;
  try {
    ensureDir(SESSIONS_DIR);
  } catch {
    return;
  }
  sweepOldSessions(now);
  writeJson(file, { startedAt: now }, 'wx');
}

/** The session's record ({ startedAt, nudgedUpTo? }), or null if it was never recorded. */
export function sessionRecord(sessionId) {
  const file = sessionFile(sessionId);
  const record = file ? readJson(file) : null;
  return typeof record?.startedAt === 'number' ? record : null;
}

/** Remember the newest file change already nudged about, so the same changes aren't raised twice. */
export function recordNudge(sessionId, upTo) {
  const file = sessionFile(sessionId);
  const record = sessionRecord(sessionId);
  if (!file || !record) return;
  writeJson(file, { ...record, nudgedUpTo: Math.max(upTo, record.nudgedUpTo ?? 0) });
}

/** Note that shot.mjs just wrote a screenshot. */
export function recordShot(now = Date.now()) {
  if (!LAST_SHOT) return;
  try {
    ensureDir(PROJECT_DATA_DIR);
  } catch {
    return;
  }
  writeJson(LAST_SHOT, { at: now });
}

/** When shot.mjs last wrote a screenshot for this project, or 0 if it never has. */
export function lastShotAt() {
  if (!LAST_SHOT || !existsSync(LAST_SHOT)) return 0;
  const at = readJson(LAST_SHOT)?.at;
  return typeof at === 'number' ? at : 0;
}
