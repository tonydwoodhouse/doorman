// Which files count as "UI" for verify-nudge.mjs, and which of them git says have changed.
//
// Kept free of side effects so config.mjs can take its defaults from here and the Stop hook can use
// it without loading (and possibly exiting on) the full configuration.
import { spawnSync } from 'child_process';
import { statSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Files whose change usually shows on a page: components, markup, templates and styles across the
 * stacks doorman is used with. Matched case-insensitively against the path relative to the
 * repository root, with forward slashes. Plain .ts/.js are deliberately absent — most of it is not
 * UI, and a nudge that fires on every edit gets ignored. Override with `uiFilePattern`.
 */
export const DEFAULT_UI_FILE_PATTERN =
  '\\.(tsx|jsx|vue|svelte|astro|css|scss|sass|less|styl|html?|cshtml|razor|erb|haml|slim|hbs|' +
  'handlebars|mustache|ejs|pug|njk|liquid|twig|jinja2?|j2|blade\\.php)$';

/** UI-looking files that never change what the running app shows: tests, stories, snapshots. */
export const DEFAULT_UI_FILE_IGNORE_PATTERN =
  '(^|/)(__tests__|__snapshots__|__mocks__|tests?|e2e|cypress|playwright)/|' +
  '\\.(test|spec|stories|story)\\.[^/]+$';

function compile(pattern, fallback) {
  if (pattern === null) return null;
  try {
    return new RegExp(typeof pattern === 'string' && pattern ? pattern : fallback, 'i');
  } catch {
    // config.mjs reports a bad pattern the next time any script runs; the hook just uses the default.
    return new RegExp(fallback, 'i');
  }
}

/** A predicate for repo-relative paths, from a config's uiFilePattern / uiFileIgnorePattern. */
export function uiFileMatcher(config = {}) {
  const include = compile(config.uiFilePattern ?? DEFAULT_UI_FILE_PATTERN, DEFAULT_UI_FILE_PATTERN);
  const ignore = 'uiFileIgnorePattern' in config
    ? compile(config.uiFileIgnorePattern, DEFAULT_UI_FILE_IGNORE_PATTERN)
    : compile(DEFAULT_UI_FILE_IGNORE_PATTERN, DEFAULT_UI_FILE_IGNORE_PATTERN);
  return (path) => include.test(path) && !(ignore?.test(path) ?? false);
}

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout : null;
}

function mtimeOf(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * The mtime of the nearest directory above `relPath` that still exists. Adding, removing or renaming
 * an entry updates its directory's mtime, so this dates a deletion or rename that the file itself
 * can't: a deleted file has no mtime, and a renamed one keeps its old one.
 */
function directoryTime(top, relPath) {
  let dir = dirname(relPath);
  for (;;) {
    const at = mtimeOf(join(top, dir));
    if (at !== null || dir === '.' || dir === '') return at ?? 0;
    dir = dirname(dir);
  }
}

/**
 * Files git reports as changed, deleted or untracked under `dir`'s repository, as
 * [{ path (repo-relative, forward slashes), from?, deleted?, mtimeMs }]. A rename or copy carries
 * its original path in `from`.
 *
 * mtimeMs is when the change happened, as nearly as the filesystem can say. For a modified or new
 * file that is the file's own mtime. A deleted file has none, and a moved one keeps the mtime of its
 * contents, so those are dated by the directories they left and arrived in. A directory's mtime
 * moves whenever anything in it is added or removed, so this can date such a change later than it
 * happened. Never earlier: an unchecked deletion or move is never missed, and at worst one
 * already seen comes up again.
 *
 * Null when `dir` isn't in a git repository or git isn't available, which callers treat as "nothing
 * to say".
 */
export function changedFiles(dir) {
  const top = git(dir, ['rev-parse', '--show-toplevel'])?.trim();
  if (!top) return null;
  const status = git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status === null) return null;

  const entries = status.split('\0');
  const files = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    // A rename or copy is followed by its original path.
    const from = /[RC]/.test(code) ? entries[++i] : undefined;

    const own = mtimeOf(join(top, path));
    if (own === null) {
      files.push({ path, deleted: true, mtimeMs: directoryTime(top, path) });
    } else if (from) {
      const moved = Math.max(own, directoryTime(top, path), directoryTime(top, from));
      files.push({ path, from, mtimeMs: moved });
    } else {
      files.push({ path, mtimeMs: own });
    }
  }
  return files;
}
