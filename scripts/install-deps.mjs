// Make sure Playwright is installed for the plugin, without making anyone wait for it.
//
// Runs on SessionStart (Claude Code and Codex both support that hook event, and both run this same
// script from the one hooks/hooks.json at the plugin root).
// The plugin directory itself is the wrong place to install into — it can be read-only, and it is
// replaced wholesale when the plugin updates — so dependencies go into the host's plugin data
// directory instead, once per machine rather than once per project.
//
//   node install-deps.mjs         decide whether anything is needed; if so, start it detached
//   node install-deps.mjs --run   do the install (this is what the detached child runs)
//   node install-deps.mjs --sync  do the install in the foreground (for setup, and for debugging)
//
// Two things keep this from being a nuisance:
//
//   It is guarded by a stamp file holding a hash of scripts/package.json + package-lock.json, so
//   after the first session it does nothing at all and costs a few milliseconds to decide that.
//
//   It runs detached and the hook returns immediately, so session start is never blocked by a
//   download. DOORMAN_SKIP_INSTALL=1 disables it entirely for anyone who would rather install by
//   hand — the scripts print the exact command when the dependency is missing.
//
// Several sessions can start at once, so the install holds a lock: .installing, created
// exclusively and holding { pid, startedAt, host }. A lock whose process is gone (or that is older
// than any install could take) is stale — an install killed mid-way must never block every later
// one — so it is cleared, with a one-line note, and the install goes ahead.
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { hostname } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
// paths.mjs resolves the data directory — and, run from the hook, records it so the agent's own
// shell (which the host gives no plugin variables) finds the same one. Importing it is what makes
// the hook and every later script agree on where Playwright lives.
import { DEPS_DIR, SCRIPT_DIR as SCRIPTS_DIR } from './paths.mjs';
import { lockPathIn, readLock as readLockAt, staleReason } from './install-lock.mjs';

const SELF = fileURLToPath(import.meta.url);
const STAMP = join(DEPS_DIR, '.installed');
const RUNNING = lockPathIn(DEPS_DIR);
const LOG = join(DEPS_DIR, 'install.log');

const mode = process.argv[2] ?? null;

// The lockfile is what actually pins the version, so the hash covers both files: bump Playwright in
// scripts/package.json and every machine reinstalls on its next session, with no extra step.
const MANIFESTS = ['package.json', 'package-lock.json'];

function manifestHash() {
  const hash = createHash('sha256');
  for (const name of MANIFESTS) {
    const file = join(SCRIPTS_DIR, name);
    if (!existsSync(file)) return null;
    hash.update(readFileSync(file));
  }
  return hash.digest('hex');
}

function read(path) {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

function isCurrent(hash) {
  return read(STAMP) === hash && existsSync(join(DEPS_DIR, 'node_modules', 'playwright'));
}

// ---------------------------------------------------------------------------
// The install lock
// ---------------------------------------------------------------------------

const LOCK_POLL_MS = 1000;
const readLock = () => readLockAt(RUNNING);

/**
 * Clear `lock` if it is stale. Re-reads first and only removes the file if it is still that same
 * lock, so a lock another installer has just taken in its place is left alone.
 */
function clearIfStale(lock) {
  const reason = staleReason(lock);
  if (!reason) return false;
  if (readLock()?.raw !== lock.raw) return true; // already replaced; let the caller look again
  rmSync(RUNNING, { force: true });
  console.log(`doorman: cleared a stale install lock (${reason}).`);
  return true;
}

/** Take the lock exclusively. Returns null on success, or the live lock that is in the way. */
function acquireLock() {
  mkdirSync(DEPS_DIR, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(RUNNING, `${JSON.stringify({
        pid: process.pid, startedAt: new Date().toISOString(), host: hostname(),
      })}\n`, { encoding: 'utf8', flag: 'wx' });
      return null;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const holder = readLock();
    if (holder && !clearIfStale(holder)) return holder;
  }
  return readLock() ?? { pid: null, startedAt: Date.now() };
}

/** Remove the lock, but only if it is ours. */
function releaseLock() {
  const lock = readLock();
  if (lock && lock.pid === process.pid && lock.host === hostname()) rmSync(RUNNING, { force: true });
}

/** Is a live install already under way? Clears a stale lock (and says so) on the way. */
function installRunning() {
  const lock = readLock();
  return Boolean(lock) && !clearIfStale(lock);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Install under the lock. With `wait`, a live lock is waited out (and if that install left things
 * current, there is nothing more to do); without it, a live lock means someone else has this in
 * hand and null is returned.
 */
async function installLocked(hash, { wait }) {
  let announced = false;
  for (;;) {
    const holder = acquireLock();
    if (!holder) {
      try {
        return await install(hash);
      } finally {
        releaseLock();
      }
    }
    if (!wait) return null;
    if (!announced) {
      const since = Number.isFinite(holder.startedAt) ? new Date(holder.startedAt).toLocaleTimeString() : 'earlier';
      console.log(`doorman: another install is already running${holder.pid ? ` (pid ${holder.pid}` : ' ('}` +
        `, since ${since}); waiting for it to finish.`);
      announced = true;
    }
    for (;;) {
      await sleep(LOCK_POLL_MS);
      const current = readLock();
      if (!current || staleReason(current)) break;
    }
    if (isCurrent(hash)) return 0;
  }
}

/** Run a command in DEPS_DIR, resolving to its exit code. Output is appended to the log. */
function run(command, args, extraEnv = {}) {
  return new Promise((done) => {
    const child = spawn(command, args, {
      cwd: DEPS_DIR,
      // shell:true so `npm` resolves to npm.cmd on Windows without special-casing the platform.
      shell: true,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const append = (chunk) => {
      try {
        writeFileSync(LOG, chunk, { flag: 'a' });
      } catch {
        // The log is a convenience; losing it must not fail the install.
      }
    };
    append(`\n$ ${command} ${args.join(' ')}\n`);
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (e) => {
      append(`spawn failed: ${e.message}\n`);
      done(-1);
    });
    child.on('close', (code) => done(code ?? -1));
  });
}

/** The install itself. Callers hold the lock (see installLocked). */
async function install(hash) {
  // Copy the manifests rather than installing in place: scripts/ belongs to the plugin and must
  // stay exactly as shipped, node_modules and all.
  for (const name of MANIFESTS) {
    writeFileSync(join(DEPS_DIR, name), readFileSync(join(SCRIPTS_DIR, name)));
  }

  // PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, then an explicit `install chromium`: the playwright package
  // otherwise fetches Firefox and WebKit too, which is several hundred megabytes this toolkit
  // never launches. Chromium lands in Playwright's shared cache, so it is one download per
  // machine per version, not per project.
  const npmCode = await run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
  });
  if (npmCode !== 0) return npmCode;

  const browserCode = await run('npx', ['--no-install', 'playwright', 'install', 'chromium']);
  if (browserCode !== 0) return browserCode;

  writeFileSync(STAMP, `${hash}\n`, 'utf8');
  return 0;
}

const hash = manifestHash();

if (hash === null) {
  console.error(`doorman: no package manifests in ${SCRIPTS_DIR} — the plugin looks incomplete.`);
  process.exit(0); // Never fail a session over this.
} else if (process.env.DOORMAN_SKIP_INSTALL === '1') {
  process.exit(0);
} else if (mode === '--run' || mode === '--sync') {
  // Ctrl+C on a foreground install shouldn't leave a lock behind for the next one to judge.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      releaseLock();
      process.exit(130);
    });
  }
  // --run is the detached child: if another install holds the lock, it has this in hand.
  // --sync is someone waiting at a prompt: wait for that install rather than fail.
  const code = await installLocked(hash, { wait: mode === '--sync' });
  if (mode === '--sync') {
    console.log(code === 0
      ? `doorman: Playwright ready in ${DEPS_DIR}`
      : `doorman: install failed (exit ${code}). See ${LOG}`);
  }
  process.exit(mode === '--sync' ? code : 0);
} else if (isCurrent(hash)) {
  process.exit(0);
} else if (installRunning()) {
  process.exit(0); // Another session already started it.
} else {
  // Detached, with the handles let go, so the hook returns now and the session is not held up.
  const child = spawn(process.execPath, [SELF, '--run'], { detached: true, stdio: 'ignore' });
  child.unref();
  console.log('doorman: installing Playwright in the background (one-off, a few minutes on a slow ' +
    'connection). Browser tests will work as soon as it finishes.');
  process.exit(0);
}
