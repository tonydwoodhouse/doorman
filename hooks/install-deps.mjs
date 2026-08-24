// Make sure Playwright is installed for the plugin, without making anyone wait for it.
//
// Runs on SessionStart. The plugin directory itself is the wrong place to install into — it can be
// read-only, and it is replaced wholesale when the plugin updates — so dependencies go into the
// plugin's data directory instead, once per machine rather than once per project.
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
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const SELF = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = resolve(dirname(SELF), '..');
const SCRIPTS_DIR = join(PLUGIN_ROOT, 'scripts');
const DATA_DIR = resolve(process.env.CLAUDE_PLUGIN_DATA ?? join(homedir(), '.claude', 'plugin-data', 'doorman'));
const DEPS_DIR = join(DATA_DIR, 'deps');
const STAMP = join(DEPS_DIR, '.installed');
const RUNNING = join(DEPS_DIR, '.installing');
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

async function install(hash) {
  mkdirSync(DEPS_DIR, { recursive: true });
  writeFileSync(RUNNING, `${new Date().toISOString()}\n`, 'utf8');
  try {
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
  } finally {
    rmSync(RUNNING, { force: true });
  }
}

const hash = manifestHash();

if (hash === null) {
  console.error(`doorman: no package manifests in ${SCRIPTS_DIR} — the plugin looks incomplete.`);
  process.exit(0); // Never fail a session over this.
} else if (process.env.DOORMAN_SKIP_INSTALL === '1') {
  process.exit(0);
} else if (mode === '--run' || mode === '--sync') {
  const code = await install(hash);
  if (mode === '--sync') {
    console.log(code === 0
      ? `doorman: Playwright ready in ${DEPS_DIR}`
      : `doorman: install failed (exit ${code}). See ${LOG}`);
  }
  process.exit(mode === '--sync' ? code : 0);
} else if (isCurrent(hash)) {
  process.exit(0);
} else if (existsSync(RUNNING)) {
  process.exit(0); // Another session already started it.
} else {
  // Detached, with the handles let go, so the hook returns now and the session is not held up.
  const child = spawn(process.execPath, [SELF, '--run'], { detached: true, stdio: 'ignore' });
  child.unref();
  console.log('doorman: installing Playwright in the background (one-off, a few minutes on a slow ' +
    'connection). Browser tests will work as soon as it finishes.');
  process.exit(0);
}
