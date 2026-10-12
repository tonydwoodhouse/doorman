// Owner-only, atomic writes for the files that hold a live session.
//
// A saved session is a bearer credential for as long as it stays valid: anyone who can read
// storageState.json can replay the sign-in. So every session file is written owner-only (0600 on
// Unix, an ACL naming only the current user on Windows), via a temporary file renamed into place
// so a reader never sees half a file and the final name is never briefly world-readable.
//
// No dependencies beyond Node, and no config import, so a test can use it directly.
import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { userInfo } from 'os';
import { basename, dirname, join } from 'path';

const WINDOWS = process.platform === 'win32';

function windowsAccount() {
  const name = userInfo().username;
  return process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${name}` : name;
}

/**
 * Restrict a file or directory to the current user. Best effort: returns false when the platform
 * refused (an exotic filesystem, a missing icacls), so the caller can say so instead of failing.
 */
export function restrictToOwner(path, { directory = false } = {}) {
  try {
    if (WINDOWS) {
      // Drop inherited entries and grant only this account; (OI)(CI) makes new files inherit it.
      const grant = `${windowsAccount()}:${directory ? '(OI)(CI)F' : 'F'}`;
      execFileSync('icacls', [path, '/inheritance:r', '/grant:r', grant, '/q'],
        { stdio: 'ignore', windowsHide: true });
    } else {
      chmodSync(path, directory ? 0o700 : 0o600);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * mkdir -p for a directory that will hold session files, restricted to the current user.
 * On Windows the ACL is only set when the directory is created (icacls is a process per call);
 * every file written into it is restricted individually anyway.
 */
export function ensurePrivateDir(dir) {
  const existed = existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!WINDOWS || !existed) restrictToOwner(dir, { directory: true });
  return dir;
}

/**
 * Write `contents` to `path` owner-only and atomically. Returns whether the permissions could be
 * restricted; throws only if the write itself fails.
 */
export function writePrivateFile(path, contents) {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    // Restrict before the rename, so the file is never readable by others under its real name.
    const restricted = restrictToOwner(tmp);
    renameWithRetry(tmp, path);
    return restricted;
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

// Windows refuses to replace a file another process has open (a concurrent check reading the
// session, an antivirus scan). Those locks are brief, so a short retry beats failing a sign-in.
function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      if (!WINDOWS || attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

/**
 * Could Git pick this file up? Returns { exposed: false } when it is outside any repository (or
 * Git isn't installed), or ignored there; otherwise { exposed: true, repo }.
 *
 * `git check-ignore` reports a file that is already tracked as not ignored, which is right: an
 * ignore rule added after the fact doesn't stop a tracked file being committed again.
 */
export function gitExposure(path) {
  const dir = dirname(path);
  try {
    execFileSync('git', ['-C', dir, 'check-ignore', '-q', '--', basename(path)],
      { stdio: 'ignore', windowsHide: true });
    return { exposed: false }; // exit 0: ignored
  } catch (e) {
    if (e.status !== 1) return { exposed: false }; // 128: not a repository; ENOENT: no git at all
  }
  let repo = null;
  try {
    repo = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
  } catch {
    // Only used to make the message more specific.
  }
  return { exposed: true, repo };
}
