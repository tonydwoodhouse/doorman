// The dependency-install lock: reading it, and deciding whether whoever took it is still working.
//
// install-deps.mjs takes and releases the lock; playwright.mjs only needs to know whether an install
// is genuinely in progress, so a missing Playwright is reported as "still installing" only while
// that is true. Both read it through here so they can never disagree about a stale lock.
import { readFileSync, statSync } from 'fs';
import { hostname } from 'os';
import { join } from 'path';

/** The lock file inside a dependency directory. */
export const lockPathIn = (depsDir) => join(depsDir, '.installing');

// Longer than any real install, even a slow first Chromium download. A lock older than this is
// stale even if a process with its PID is running: by then that PID is likely someone else's.
export const LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** The lock at `path` as { pid, host, startedAt (ms), raw }, or null when there is none. */
export function readLock(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let lock = null;
  try {
    lock = JSON.parse(raw);
  } catch {
    // 0.1.0 wrote a bare timestamp; anything else unreadable is judged by the file's age.
  }
  if (lock && typeof lock === 'object') {
    return { pid: lock.pid, host: lock.host, startedAt: Date.parse(lock.startedAt), raw };
  }
  let startedAt = Date.parse(raw.trim());
  if (Number.isNaN(startedAt)) {
    try {
      startedAt = statSync(path).mtimeMs;
    } catch {
      return null;
    }
  }
  return { pid: null, host: null, startedAt, raw };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0: existence check only
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists, just not ours to signal
  }
}

/** Why `lock` is stale, or null while its holder may still be working. */
export function staleReason(lock) {
  const age = Date.now() - lock.startedAt;
  if (!Number.isFinite(age) || age > LOCK_MAX_AGE_MS) {
    return `it was taken ${Number.isFinite(age) ? `${Math.round(age / 60000)} minutes ago` : 'at an unknown time'}`;
  }
  // A PID only means something on the machine that wrote it (a home directory can be shared).
  if (lock.host === hostname() && Number.isInteger(lock.pid) && !pidAlive(lock.pid)) {
    return `process ${lock.pid} is no longer running`;
  }
  return null;
}

/** Is an install holding a live lock in `depsDir` right now? */
export function installInProgress(depsDir) {
  const lock = readLock(lockPathIn(depsDir));
  return Boolean(lock) && !staleReason(lock);
}
