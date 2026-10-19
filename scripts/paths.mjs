// Where everything lives. This is the one file that knows the difference between the two ways the
// toolkit runs, so nothing else has to care.
//
//   Vendored — the scripts, the config and the session files all sit together in the project, at
//   <project>/tools/doorman. Simple, self-contained, and what CI or any tool without a plugin host
//   can use.
//
//   Plugin   — the scripts live in the installed plugin (shared between every project, replaced on
//   update), the config lives in the project being tested, and the session files live in the
//   host's own plugin data directory, off the project's disk entirely. A live session then cannot
//   be committed even by accident, which is the whole reason for the split. This is the same split
//   whether the host is Claude Code or Codex — the repository root is the plugin for both, with
//   this scripts/ directory inside it.
//
// The mode is decided by this file's own location, deliberately not by an environment variable: a
// full checkout of this repo (or an installed copy of it) has .claude-plugin/plugin.json or
// .codex-plugin/plugin.json one level up, and the vendored installer only ever copies scripts/. So
// a vendored install cannot slip onto the plugin path because some *_PLUGIN_* variable happened to
// be set in the environment, and either layout behaves the same run from a shell as it does run by
// an agent.
//
// Nothing exits here: config.mjs owns the failing, so detect.mjs can import this while the
// configuration is still missing or invalid. The one side effect is recording which plugin data
// directory this installed copy uses (see resolveDataDir below), and that never throws.
//
// Run it directly (`node paths.mjs`) to print the resolved layout — the fastest way to answer
// "where did it put my session file?".
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { basename, dirname, join, resolve } from 'path';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';

/** Directory holding the toolkit's own scripts. */
export const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const REPO_ROOT_CANDIDATE = resolve(SCRIPT_DIR, '..');
const HAS_PLUGIN_MANIFEST =
  existsSync(join(REPO_ROOT_CANDIDATE, '.claude-plugin', 'plugin.json')) ||
  existsSync(join(REPO_ROOT_CANDIDATE, '.codex-plugin', 'plugin.json'));

/** Root of the plugin (this repo, or the host's installed copy of it) when either host's manifest
 *  sits beside scripts/, rather than a vendored copy; else null. */
export const REPO_ROOT = HAS_PLUGIN_MANIFEST ? REPO_ROOT_CANDIDATE : null;

export const PLUGIN_MODE = REPO_ROOT !== null;

/** doorman's own per-user directory. DOORMAN_HOME moves it, which is mainly for tests. */
export const DOORMAN_HOME = resolve(process.env.DOORMAN_HOME ?? join(homedir(), '.doorman'));

function pathKey(dir) {
  const full = resolve(dir);
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

/** Where this installed copy records the data directory it settled on. One file per plugin root,
 *  keyed by a hash of the scripts' own path, because that path is the only thing a hook and the
 *  agent's shell are both guaranteed to know. */
export const DATA_DIR_RECORD = join(
  DOORMAN_HOME, 'plugin-roots',
  `${createHash('sha256').update(pathKey(SCRIPT_DIR)).digest('hex').slice(0, 16)}.json`,
);

function readRecordedDataDir() {
  try {
    const record = JSON.parse(readFileSync(DATA_DIR_RECORD, 'utf8'));
    return typeof record?.dataDir === 'string' && record.dataDir ? resolve(record.dataDir) : null;
  } catch {
    return null;
  }
}

function recordDataDir(dir) {
  try {
    mkdirSync(dirname(DATA_DIR_RECORD), { recursive: true });
    writeFileSync(DATA_DIR_RECORD, `${JSON.stringify({
      dataDir: dir, scriptDir: SCRIPT_DIR, recordedAt: new Date().toISOString(),
    }, null, 2)}
`, { encoding: 'utf8', flag: 'wx' });
  } catch {
    // Already recorded by another process (flag 'wx'), or doorman's home isn't writable. Either
    // way the directory resolved below is still used for this run.
  }
}

/**
 * Writable directory the host plugin owns, for session files and installed dependencies.
 *
 * The catch this has to handle: Claude Code and Codex both export their plugin data directory to
 * hook commands (CLAUDE_PLUGIN_DATA, and Codex's own PLUGIN_DATA), but neither exports it to the
 * shell the agent runs commands in. Left alone, the SessionStart hook would install Playwright in
 * one directory while every script the agent runs looked in another.
 *
 * So the first process to resolve it — normally the hook, which can see the host's variable —
 * records its answer in DATA_DIR_RECORD, and every later process for the same installed copy reads
 * that record before looking at the environment. Whoever goes first, everyone agrees.
 *
 * DOORMAN_DATA_DIR still wins outright, so a one-off run can be pointed anywhere, and it is never
 * recorded.
 */
function resolveDataDir() {
  if (process.env.DOORMAN_DATA_DIR) return resolve(process.env.DOORMAN_DATA_DIR);
  const recorded = readRecordedDataDir();
  if (recorded) return recorded;
  const hostDir = process.env.PLUGIN_DATA ?? process.env.CLAUDE_PLUGIN_DATA;
  const dir = resolve(hostDir ?? join(DOORMAN_HOME, 'plugin-data'));
  recordDataDir(dir);
  return dir;
}

export const DATA_DIR = PLUGIN_MODE ? resolveDataDir() : null;

// ---------------------------------------------------------------------------
// The project under test
// ---------------------------------------------------------------------------

// Files that mark a repository root across the stacks this toolkit is used with.
const ROOT_MARKERS = ['.git', '.hg', 'package.json', 'pyproject.toml', 'requirements.txt',
  'Cargo.toml', 'go.mod', 'composer.json', 'Gemfile', 'pom.xml'];
const ROOT_MARKER_EXTENSIONS = ['.sln', '.slnx', '.csproj', '.fsproj', '.gradle'];

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Nearest ancestor of `from` that looks like a repository root, as `{ dir, guess? }`.
 *
 * Scanning or configuring the wrong tree produces confidently wrong answers, so when no marker is
 * found this reports that the answer is a guess rather than quietly settling on one. A vendored
 * install lives at <root>/tools/doorman, which makes two levels up the best fallback.
 */
export function findProjectRoot(from) {
  let dir = resolve(from);
  for (let up = 0; up < 8; up++) {
    // The toolkit's own directory ships a package.json, so never stop on it.
    if (dir !== SCRIPT_DIR) {
      const names = readdirSafe(dir);
      const isRoot = ROOT_MARKERS.some((m) => existsSync(join(dir, m))) ||
        names.some((n) => ROOT_MARKER_EXTENSIONS.some((ext) => n.endsWith(ext)));
      if (isRoot) return { dir };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const twoUp = resolve(SCRIPT_DIR, '..', '..');
  return { dir: existsSync(twoUp) ? twoUp : process.cwd(), guess: true };
}

// As a plugin the scripts are outside the project, so the search starts at the working directory —
// which is the project Claude is working in. Vendored, the scripts are inside it, so it starts here.
const rootSearchStart = PLUGIN_MODE ? process.cwd() : SCRIPT_DIR;
const explicitRoot = process.env.DOORMAN_PROJECT_DIR ?? process.env.CLAUDE_PROJECT_DIR ?? null;
const foundRoot = explicitRoot ? { dir: explicitRoot } : findProjectRoot(rootSearchStart);

/** Root of the project being tested. */
export const PROJECT_DIR = resolve(foundRoot.dir);
/** True when PROJECT_DIR was inferred without finding a repository marker — worth disclosing. */
export const PROJECT_DIR_IS_GUESS = Boolean(foundRoot.guess);

/**
 * Stable, readable directory name for a project path.
 *
 * The basename alone would collide between two checkouts of the same repo — which would silently
 * share one session between them — so the full path's hash is appended. Windows paths are lowercased
 * first so C:\Src and c:\src resolve to the same session rather than two.
 */
export function slugFor(dir) {
  const full = resolve(dir).replace(/[\\/]+$/, '');
  const key = process.platform === 'win32' ? full.toLowerCase() : full;
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 8);
  const name = basename(full).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${name || 'project'}-${hash}`;
}

/** Per-project directory name used under the plugin's data directory. */
export const PROJECT_SLUG = PLUGIN_MODE ? slugFor(PROJECT_DIR) : null;

// ---------------------------------------------------------------------------
// Resolved locations
// ---------------------------------------------------------------------------

// Deliberately not under .claude/: Claude Code treats that directory as sensitive and won't let an
// agent edit files there without asking, and Codex has no reason to look in it. Configs written
// there by 0.1.0 are still read (LEGACY_PROJECT_CONFIG), just never created.
const PROJECT_CONFIG = join('.doorman', 'doorman.config.json');
const LEGACY_PROJECT_CONFIG = join('.claude', 'doorman', 'doorman.config.json');
const VENDORED_CONFIG = join('tools', 'doorman', 'doorman.config.json');

function firstExisting(candidates) {
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** The plugin-style config in a project directory (current location first, then 0.1.0's), or
 *  null. A vendored install seeds its own config from this, so configuring twice isn't needed. */
export function projectConfigIn(dir) {
  return firstExisting([PROJECT_CONFIG, LEGACY_PROJECT_CONFIG].map((p) => join(dir, p)));
}

// DOORMAN_CONFIG always wins, so one project can be pointed at another's configuration for a
// one-off run without editing anything.
const envConfig = process.env.DOORMAN_CONFIG ? resolve(process.env.DOORMAN_CONFIG) : null;

// Where a config would be created if none exists yet.
const defaultConfigPath = envConfig ?? (PLUGIN_MODE
  ? join(PROJECT_DIR, PROJECT_CONFIG)
  : join(SCRIPT_DIR, 'doorman.config.json'));

// An existing vendored install in the same repo is honoured as a third choice: its config holds
// URLs and selectors, never secrets, so reusing it beats making the developer answer twice.
const configCandidates = envConfig
  ? [envConfig]
  : PLUGIN_MODE
    ? [PROJECT_CONFIG, LEGACY_PROJECT_CONFIG, VENDORED_CONFIG].map((p) => join(PROJECT_DIR, p))
    : [join(SCRIPT_DIR, 'doorman.config.json')];

/** The configuration file in use, or where it should be created. */
export const CONFIG_PATH = firstExisting(configCandidates) ?? defaultConfigPath;
export const CONFIG_EXISTS = existsSync(CONFIG_PATH);

/**
 * Directory holding the saved session for this project.
 *
 * Under the plugin this is outside the repository on purpose — storageState.json is a live session,
 * and the surest way to keep it out of a commit is to keep it off the project's disk.
 */
export const SESSION_DIR = process.env.DOORMAN_SESSION_DIR
  ? resolve(process.env.DOORMAN_SESSION_DIR)
  : PLUGIN_MODE ? join(DATA_DIR, 'projects', PROJECT_SLUG, 'session') : SCRIPT_DIR;

/** Default destination for screenshots. Kept apart from the session files, which are sensitive. */
export const OUTPUT_DIR = process.env.DOORMAN_OUTPUT_DIR
  ? resolve(process.env.DOORMAN_OUTPUT_DIR)
  : PLUGIN_MODE ? join(DATA_DIR, 'projects', PROJECT_SLUG, 'shots') : SCRIPT_DIR;

/**
 * Directory whose node_modules holds Playwright.
 *
 * The plugin directory itself may be read-only, and is replaced wholesale on update, so
 * dependencies are installed into the data directory instead — see scripts/install-deps.mjs.
 * DOORMAN_DEPS_DIR overrides it directly, same as SESSION_DIR/OUTPUT_DIR above.
 */
export const DEPS_DIR = PLUGIN_MODE
  ? resolve(process.env.DOORMAN_DEPS_DIR ?? join(DATA_DIR, 'deps'))
  : SCRIPT_DIR;

/** Per-project directory under the plugin's data directory, or null when vendored. */
export const PROJECT_DATA_DIR = PLUGIN_MODE ? join(DATA_DIR, 'projects', PROJECT_SLUG) : null;

/** mkdir -p, returning the directory, so writers can call it inline. */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Record which project a slug belongs to.
 *
 * Without this the data directory is a list of hashes, and nobody can tell which one to delete when
 * they want a project's saved session gone.
 */
export function noteProjectPath() {
  if (!PROJECT_DATA_DIR) return;
  const marker = join(PROJECT_DATA_DIR, 'project.txt');
  const line = `${PROJECT_DIR}\n`;
  try {
    if (readFileSafe(marker) !== line) {
      ensureDir(PROJECT_DATA_DIR);
      writeFileSync(marker, line, 'utf8');
    }
  } catch {
    // Purely for human legibility — never worth failing a run over.
  }
}

function readFileSafe(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Human-readable summary of the above, for diagnostics and setup output. */
export function describeLayout() {
  const lines = [
    `mode          ${PLUGIN_MODE ? 'plugin' : 'vendored'}`,
    `scripts       ${SCRIPT_DIR}`,
    `project       ${PROJECT_DIR}${PROJECT_DIR_IS_GUESS ? '   (guessed — no repository marker found)' : ''}`,
    `config        ${CONFIG_PATH}${CONFIG_EXISTS ? '' : '   (does not exist yet)'}`,
    `session       ${SESSION_DIR}`,
    `screenshots   ${OUTPUT_DIR}`,
    `dependencies  ${join(DEPS_DIR, 'node_modules')}${existsSync(join(DEPS_DIR, 'node_modules')) ? '' : '   (not installed)'}`,
  ];
  if (PLUGIN_MODE) {
    lines.push(`plugin data   ${DATA_DIR}`);
    lines.push(`data record   ${DATA_DIR_RECORD}`);
  }
  return lines;
}

// `node paths.mjs` prints the layout. Handy when a session file isn't where someone expected.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  console.log(describeLayout().join('\n'));
}
