// Work out where this project's dev server listens, from the project's own files.
//
//   node detect.mjs                 report ranked candidates (human readable)
//   node detect.mjs --json          the same, as JSON
//   node detect.mjs --write         write the best candidate into doorman.config.json
//   node detect.mjs --write --force overwrite an existing baseUrl too
//
//   --root <path>      project root to scan   (default: DOORMAN_PROJECT_DIR, CLAUDE_PROJECT_DIR,
//                                              or the nearest ancestor holding .git/*.sln/package.json)
//   --config <path>    config file to write   (default: wherever paths.mjs says it belongs)
//   --allow-remote     keep candidates that aren't demonstrably local (see the guardrail below)
//
// Exit 0 when something usable was found, 4 (ENVIRONMENT, the toolkit's convention) when not —
// so a caller can branch on the code instead of parsing this output.
//
// No npm dependencies, and no import of config.mjs, because this has to run *before* a valid
// configuration exists (config.mjs would exit 4 first). paths.mjs is safe to import: it only
// resolves locations and never fails.
//
// Guardrail: candidates that aren't demonstrably local are discarded, not ranked. .env files and
// appsettings.*.json routinely carry staging and production URLs, and the whole design persists a
// live session to disk — pointing it at production would be the one genuinely damaging mistake
// this script could make. Discarded candidates are reported, never silently dropped, and
// --allow-remote is the deliberate override.
import { connect } from 'net';
import { dirname, join, basename, resolve } from 'path';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import {
  CONFIG_PATH, PROJECT_DIR, PROJECT_DIR_IS_GUESS, SCRIPT_DIR as HERE, ensureDir, projectConfigIn,
} from './paths.mjs';

const EXIT_OK = 0;
const EXIT_ENVIRONMENT = 4;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const opts = { write: false, force: false, json: false, allowRemote: false, root: null, config: null };
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  const next = () => {
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) die(`${arg} needs a value`);
    return v;
  };
  if (arg === '--write') opts.write = true;
  else if (arg === '--force') opts.force = true;
  else if (arg === '--json') opts.json = true;
  else if (arg === '--allow-remote') opts.allowRemote = true;
  else if (arg === '--root') opts.root = next();
  else if (arg.startsWith('--root=')) opts.root = arg.slice(7);
  else if (arg === '--config') opts.config = next();
  else if (arg.startsWith('--config=')) opts.config = arg.slice(9);
  else die(`Unknown argument: ${arg}`);
}

function die(message) {
  console.error(message);
  console.error('Usage: node detect.mjs [--write [--force]] [--json] [--root <path>] [--config <path>] [--allow-remote]');
  process.exit(EXIT_ENVIRONMENT);
}

// --root wins over everything paths.mjs worked out; without it, that answer is already the right
// one (DOORMAN_PROJECT_DIR, CLAUDE_PROJECT_DIR, or the nearest repository marker), and it also
// knows whether it had to guess.
const projectRoot = opts.root ? resolve(opts.root) : PROJECT_DIR;
const rootIsGuess = opts.root ? false : PROJECT_DIR_IS_GUESS;
const configPath = resolve(opts.config ?? CONFIG_PATH);

// ---------------------------------------------------------------------------
// Reading the project's files
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'bin', 'obj', 'dist', 'build', 'out', 'target', 'coverage',
  '.next', '.nuxt', '.svelte-kit', '.vs', '.idea', '.venv', 'venv', '__pycache__', 'vendor',
  'doorman', // never read our own installed copy back in
]);
const MAX_DEPTH = 4;   // src/MyApp/Properties/launchSettings.json is depth 3

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Depth-limited walk collecting the files we know how to read. */
function collectFiles(root) {
  const found = [];
  const walk = (dir, depth) => {
    for (const name of readdirSafe(dir)) {
      const full = join(dir, name);
      let entry;
      try {
        entry = statSync(full);
      } catch {
        continue;
      }
      if (entry.isDirectory()) {
        if (depth >= MAX_DEPTH || SKIP_DIRS.has(name)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (interesting(name, dir)) found.push(full);
    }
  };
  walk(root, 0);
  return found;
}

function interesting(name, dir) {
  const lower = name.toLowerCase();
  if (lower === 'launchsettings.json') return true;
  if (lower === 'launch.json') return basename(dir).toLowerCase() === '.vscode';
  if (lower === 'angular.json' || lower === 'package.json') return true;
  if (/^(vite|next|nuxt|webpack|vue)\.config\.[cm]?[jt]s$/.test(lower)) return true;
  if (/^(docker-)?compose(\.[a-z]+)?\.ya?ml$/.test(lower)) return true;
  if (/^\.env(\..+)?$/.test(lower)) return true;
  if (/^appsettings(\..+)?\.json$/.test(lower)) return true;
  return false;
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * JSON with comments and trailing commas — the normal shape of .vscode/launch.json, and
 * tolerated by the .NET tooling that reads launchSettings.json. Plain JSON.parse throws on both.
 */
function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === '"') {                                  // copy strings verbatim, escapes included
      out += c;
      i++;
      while (i < text.length) {
        if (text[i] === '\\') {
          out += text[i] + (text[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += text[i];
        if (text[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function readJsonc(path) {
  const text = readText(path);
  if (text === null) return null;
  try {
    return parseJsonc(text);
  } catch {
    return null;   // an unreadable file is a missing source, not a failure
  }
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

// Higher wins among equally live candidates. A liveness probe outranks all of this.
const RANK = {
  launchSettings: 100,
  vscodeLaunch: 90,
  aspnetUrls: 80,
  angular: 70,
  viteConfig: 65,
  npmScript: 60,
  appsettings: 55,
  dotenv: 50,
  compose: 45,
  frameworkDefault: 40,
};

const candidates = [];

/** Record one candidate. Wildcard binds mean "every interface", which for us means localhost. */
function add(rawUrl, { rank, source, field, basePath = null }) {
  if (!rawUrl) return;
  let text = String(rawUrl).trim();
  if (!text) return;
  // ASPNETCORE_URLS uses http://+:5000 and http://*:5000 for "any host".
  text = text.replace(/:\/\/(\+|\*)(?=[:/]|$)/, '://localhost');
  let url;
  try {
    url = new URL(text);
  } catch {
    return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (url.hostname === '0.0.0.0' || url.hostname === '[::]' || url.hostname === '::') url.hostname = 'localhost';

  const path = (basePath ?? '').replace(/\/+$/, '');
  const normalised = `${url.origin}${path}`;
  // Keep each source paired with the field it came from — reporting one file's name next to
  // another file's field is how a detector loses the developer's trust.
  const origin = { source, field, rank };
  const existing = candidates.find((c) => c.url === normalised);
  if (existing) {
    if (!existing.origins.some((o) => o.source === source && o.field === field)) {
      existing.origins.push(origin);
      existing.origins.sort((a, b) => b.rank - a.rank);
      existing.rank = existing.origins[0].rank;
    }
    return;
  }
  candidates.push({ url: normalised, rank, origins: [origin] });
}

/** A port on its own: build a URL, defaulting to http unless the source proved otherwise. */
function addPort(port, { https = false, ...rest }) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return;
  add(`${https ? 'https' : 'http'}://localhost:${n}`, rest);
}

// Things worth writing but not baseUrl: appName, defaultCheckPath. Highest rank wins, so file
// order during the walk doesn't decide which source is believed.
const suggestions = {};
function suggest(key, value, { source, field, rank }) {
  if (!value) return;
  if (suggestions[key] && suggestions[key].rank >= rank) return;
  suggestions[key] = { value, source, field, rank };
}
const files = collectFiles(projectRoot);
const rel = (path) => path.slice(projectRoot.length).replace(/^[\\/]/, '').replace(/\\/g, '/');

for (const file of files) {
  const name = basename(file).toLowerCase();
  const source = rel(file);

  if (name === 'launchsettings.json') {
    const json = readJsonc(file);
    if (!json) continue;
    // Prefer the "Project" (Kestrel) profile over IIS Express — it's what dotnet run uses.
    for (const [profileName, profile] of Object.entries(json.profiles ?? {})) {
      if (!profile || typeof profile !== 'object') continue;
      const isKestrel = profile.commandName === 'Project';
      const rank = RANK.launchSettings - (isKestrel ? 0 : 5);
      // The Kestrel profile is named after the project, which beats "My App".
      if (isKestrel) suggest('appName', profileName, { source, field: `profiles.${profileName}`, rank: 60 });
      // applicationUrl is a semicolon-separated list; the https entry is the one to keep.
      const urls = String(profile.applicationUrl ?? '').split(';').map((u) => u.trim()).filter(Boolean);
      for (const url of urls) {
        add(url, {
          rank: rank - (url.startsWith('https') ? 0 : 10),
          source,
          field: `profiles.${profileName}.applicationUrl`,
        });
      }
      add(profile.environmentVariables?.ASPNETCORE_URLS, {
        rank: RANK.aspnetUrls,
        source,
        field: `profiles.${profileName}.environmentVariables.ASPNETCORE_URLS`,
      });
      // launchUrl is the route the developer actually opens — a good gated-route guess.
      if (typeof profile.launchUrl === 'string' && profile.launchUrl) {
        const path = profile.launchUrl.startsWith('/') ? profile.launchUrl : `/${profile.launchUrl}`;
        if (path !== '/') {
          suggest('defaultCheckPath', path, { source, field: `profiles.${profileName}.launchUrl`, rank: 100 });
        }
      }
    }
    add(json.iisSettings?.iisExpress?.applicationUrl, {
      rank: RANK.launchSettings - 15,
      source,
      field: 'iisSettings.iisExpress.applicationUrl',
    });
    continue;
  }

  if (name === 'launch.json') {
    const json = readJsonc(file);
    if (!json) continue;
    for (const cfg of json.configurations ?? []) {
      if (!cfg || typeof cfg !== 'object') continue;
      add(cfg.url, { rank: RANK.vscodeLaunch, source, field: `configurations["${cfg.name ?? '?'}"].url` });
      // A path on that URL is the page the developer opens on launch — another gated-route guess.
      if (typeof cfg.url === 'string') {
        try {
          const path = new URL(cfg.url).pathname.replace(/\/+$/, '');
          if (path) suggest('defaultCheckPath', path, { source, field: `configurations["${cfg.name ?? '?'}"].url`, rank: 80 });
        } catch { /* not a URL we can read */ }
      }
      add(cfg.env?.ASPNETCORE_URLS, { rank: RANK.aspnetUrls, source, field: `configurations["${cfg.name ?? '?'}"].env.ASPNETCORE_URLS` });
      // uriFormat is usually "https://localhost:%s" — only usable once a port is known, so
      // it contributes a scheme+host, not a candidate, unless it already carries the port.
      const uriFormat = cfg.serverReadyAction?.uriFormat;
      if (typeof uriFormat === 'string' && !uriFormat.includes('%s')) {
        add(uriFormat, { rank: RANK.vscodeLaunch - 5, source, field: 'serverReadyAction.uriFormat' });
      }
    }
    continue;
  }

  if (name === 'angular.json') {
    const json = readJsonc(file);
    if (!json) continue;
    for (const [projectName, project] of Object.entries(json.projects ?? {})) {
      const serve = project?.architect?.serve ?? project?.targets?.serve;
      const o = serve?.options;
      if (!o) continue;
      addPort(o.port ?? 4200, {
        https: o.ssl === true,
        rank: RANK.angular,
        source,
        field: `projects.${projectName}.architect.serve.options.port`,
      });
    }
    continue;
  }

  if (/^(vite|nuxt|vue|webpack)\.config\./.test(name)) {
    const text = readText(file);
    if (!text) continue;
    // JS/TS config, so this is a scan rather than a parse — good enough for a port literal.
    const port = text.match(/\bport\s*:\s*(\d{2,5})/);
    const https = /\bhttps\s*:\s*(true|\{)/.test(text);
    const base = text.match(/\bbase\s*:\s*['"`]([^'"`]+)['"`]/);
    addPort(port?.[1] ?? (name.startsWith('vite') ? 5173 : name.startsWith('nuxt') ? 3000 : 8080), {
      https,
      rank: port ? RANK.viteConfig : RANK.frameworkDefault,
      source,
      field: port ? 'server.port' : 'framework default port',
      basePath: base?.[1] && base[1] !== '/' ? base[1] : null,
    });
    continue;
  }

  if (/^next\.config\./.test(name)) {
    const text = readText(file);
    if (!text) continue;
    const base = text.match(/\bbasePath\s*:\s*['"`]([^'"`]+)['"`]/);
    addPort(3000, {
      rank: RANK.frameworkDefault,
      source,
      field: 'Next.js default port',
      basePath: base?.[1] && base[1] !== '/' ? base[1] : null,
    });
    continue;
  }

  if (/^(docker-)?compose/.test(name)) {
    const text = readText(file);
    if (!text) continue;
    // Host-side ports only, from either list form: - "8080:80" / - 8080:80
    for (const m of text.matchAll(/^\s*-\s*["']?(?:[\d.]+:)?(\d{2,5}):\d{2,5}/gm)) {
      addPort(m[1], { rank: RANK.compose, source, field: 'ports' });
    }
    continue;
  }

  if (name === 'package.json') {
    const json = readJsonc(file);
    if (!json) continue;
    if (typeof json.name === 'string' && dirname(file) === projectRoot) {
      suggest('appName', json.name, { source, field: 'name', rank: 50 });
    }
    for (const [scriptName, body] of Object.entries(json.scripts ?? {})) {
      if (!/^(dev|start|serve)/.test(scriptName) || typeof body !== 'string') continue;
      const port = body.match(/(?:-p|--port)[= ](\d{2,5})/);
      if (port) {
        addPort(port[1], {
          https: /--https/.test(body),
          rank: RANK.npmScript,
          source,
          field: `scripts.${scriptName}`,
        });
      }
    }
    // Framework defaults, so a project with no port anywhere still gets a candidate to probe.
    const deps = { ...json.dependencies, ...json.devDependencies };
    if (dirname(file) === projectRoot) {
      const defaults = [
        ['next', 3000], ['nuxt', 3000], ['vite', 5173], ['@angular/core', 4200],
        ['react-scripts', 3000], ['@sveltejs/kit', 5173], ['astro', 4321],
      ];
      for (const [dep, port] of defaults) {
        if (deps[dep]) addPort(port, { rank: RANK.frameworkDefault, source, field: `${dep} default port` });
      }
    }
    continue;
  }

  if (/^\.env/.test(name)) {
    const text = readText(file);
    if (!text) continue;
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.+?)\s*$/i);
      if (!m) continue;
      const key = m[1].toUpperCase();
      const value = m[2].replace(/^["']|["']$/g, '');
      if (/^(ASPNETCORE_URLS|BASE_URL|APP_URL|VITE_BASE_URL|NEXT_PUBLIC_(?:BASE|APP|SITE)_URL|SITE_URL)$/.test(key)) {
        add(value, { rank: RANK.dotenv, source, field: key });
      } else if (/^(PORT|VITE_PORT|DEV_SERVER_PORT|SERVER_PORT)$/.test(key)) {
        addPort(value, { rank: RANK.dotenv, source, field: key });
      }
    }
    continue;
  }

  if (/^appsettings/.test(name)) {
    const json = readJsonc(file);
    if (!json) continue;
    const endpoints = json.Kestrel?.Endpoints ?? {};
    for (const [endpointName, endpoint] of Object.entries(endpoints)) {
      add(endpoint?.Url, { rank: RANK.appsettings, source, field: `Kestrel.Endpoints.${endpointName}.Url` });
    }
    continue;
  }
}

// ---------------------------------------------------------------------------
// Guardrail 1: local hosts only
// ---------------------------------------------------------------------------

/** Why a host counts as local, or null when it doesn't. */
function localityOf(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return 'loopback';
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return 'loopback';
  if (/^127\./.test(h)) return 'loopback';
  if (h === 'host.docker.internal' || h === 'gateway.docker.internal') return 'docker host';
  if (/^10\./.test(h)) return 'private network';
  if (/^192\.168\./.test(h)) return 'private network';
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return 'private network';
  if (/^169\.254\./.test(h)) return 'link-local';
  if (/\.(local|test|localhost|internal|localtest\.me)$/.test(h)) return 'local domain';
  return null;
}

const rejected = [];
const local = [];
for (const c of candidates) {
  const locality = localityOf(new URL(c.url).hostname);
  if (locality) {
    local.push({ ...c, locality });
  } else {
    rejected.push({ ...c, reason: 'not a local address' });
  }
}
// Rejected candidates are never probed — a request to a production host is itself the mistake.
const usable = opts.allowRemote ? [...local, ...rejected.map((c) => ({ ...c, locality: 'allowed by --allow-remote' }))] : local;

// ---------------------------------------------------------------------------
// Liveness: what is actually listening beats what a file claims
// ---------------------------------------------------------------------------

/**
 * TCP connect, not fetch: it proves a listener without tripping over the self-signed dev
 * certificates these URLs almost always use.
 */
function isListening(url, timeoutMs = 1200) {
  const { hostname, port, protocol } = new URL(url);
  const target = Number(port) || (protocol === 'https:' ? 443 : 80);
  return new Promise((resolvePromise) => {
    const socket = connect({ host: hostname.replace(/^\[|\]$/g, ''), port: target });
    const finish = (result) => {
      socket.destroy();
      resolvePromise(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

await Promise.all(usable.map(async (c) => {
  c.live = await isListening(c.url);
}));

// Live first, then the file-source ranking, then https over http for a stable order.
usable.sort((a, b) =>
  Number(b.live) - Number(a.live) ||
  b.rank - a.rank ||
  Number(b.url.startsWith('https')) - Number(a.url.startsWith('https')) ||
  a.url.localeCompare(b.url));

const chosen = usable[0] ?? null;

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (opts.json) {
  console.log(JSON.stringify({
    projectRoot,
    projectRootIsGuess: rootIsGuess,
    configPath,
    chosen,
    candidates: usable,
    rejected: opts.allowRemote ? [] : rejected,
    suggestions,
    filesRead: files.map(rel),
  }, null, 2));
} else {
  console.log(`Scanned ${files.length} candidate file(s) under ${projectRoot}`);
  if (rootIsGuess) {
    console.log('(Guessed that project root — no .git/.sln/package.json above this script.');
    console.log(' If it is wrong, re-run with --root <path>.)');
  }
  console.log('');
  if (usable.length) {
    console.log('Candidates (best first):');
    for (const c of usable) {
      const state = c.live ? 'LISTENING' : 'no answer';
      const [first, ...rest] = c.origins;
      console.log(`  ${state.padEnd(10)} ${c.url.padEnd(34)} ${first.source} (${first.field})`);
      for (const o of rest) console.log(`${' '.repeat(48)}also ${o.source} (${o.field})`);
    }
  } else {
    console.log('No local candidates found.');
  }
  if (rejected.length && !opts.allowRemote) {
    console.log('\nDiscarded as non-local (never probed — this toolkit is for local/test only):');
    for (const c of rejected) console.log(`  ${c.url.padEnd(34)} ${c.origins[0].source} (${c.origins[0].field})`);
    console.log('  Pass --allow-remote only if one of these really is a local/test environment.');
  }
  for (const [key, s] of Object.entries(suggestions)) {
    console.log(`\nSuggested ${key}: ${JSON.stringify(s.value)}  — from ${s.source} (${s.field})`);
  }
}

// ---------------------------------------------------------------------------
// Guardrail 2: write the answer, but make a wrong answer legible
// ---------------------------------------------------------------------------
//
// A wrong baseUrl fails as exit 4 naming the URL it tried, which is cheap and self-explanatory,
// so there's no reason to interrupt the developer for confirmation. What must never happen is a
// silent write: whatever lands in the file is printed here with the file it came from. When
// nothing is found we write "configured": false instead, which makes every script stop with
// instructions rather than quietly testing some default URL.

// The five project-specific fields, in the order they should appear. Creating the file from this
// (rather than writing only what was detected) means the fields detection *can't* answer —
// loginPath, authenticatedSelector — are visibly present and waiting, instead of absent and
// forgotten. It matches config/doorman.config.example.json field for field.
const SKELETON = {
  appName: 'My App',
  baseUrl: 'https://localhost:5001',
  loginPath: '/Login',
  defaultCheckPath: '/',
  authenticatedSelector: null,
};

if (opts.write) {
  const configExisted = existsSync(configPath);
  // Creating a vendored config in a project that already has a plugin one: start from that, so
  // the routes and selectors someone already worked out carry over instead of being asked again.
  const seedPath = configExisted ? null : projectConfigIn(projectRoot);
  const seeded = seedPath && resolve(seedPath) !== configPath ? readJsonc(seedPath) : null;
  if (seeded) console.log(`
Starting from the existing project config at ${seedPath}.`);
  const existing = configExisted ? (readJsonc(configPath) ?? {}) : (seeded ?? {});
  const next = { ...SKELETON, ...existing };
  const changes = [];

  if (chosen) {
    // The values doorman.config.json ships with. Each counts as unset, so a fresh install is
    // filled in without --force while a developer's own answer is left alone. Every replacement
    // is printed, so a deliberate value that matches a placeholder is visibly changed, not lost.
    const PLACEHOLDERS = { baseUrl: 'https://localhost:5001', appName: 'My App', defaultCheckPath: '/' };
    const isUnset = (key) => {
      const value = existing[key];
      return value === undefined || value === null || value === '' ||
        String(value).replace(/\/+$/, '') === PLACEHOLDERS[key].replace(/\/+$/, '');
    };

    if (!isUnset('baseUrl') && !opts.force) {
      console.log(`\nLeft baseUrl as ${existing.baseUrl} (already set — pass --force to replace it).`);
    } else if (next.baseUrl !== chosen.url) {
      next.baseUrl = chosen.url;
      changes.push(`baseUrl = ${chosen.url}   (${chosen.origins[0].source}, ${chosen.origins[0].field})`);
    }

    for (const key of ['appName', 'defaultCheckPath']) {
      const suggestion = suggestions[key];
      if (!suggestion || suggestion.value === next[key]) continue;
      if (!isUnset(key) && !opts.force) continue;
      next[key] = suggestion.value;
      changes.push(`${key} = ${suggestion.value}   (${suggestion.source}, ${suggestion.field})`);
    }
    if (next.configured === false) {
      delete next.configured;
      changes.push('cleared "configured": false');
    }
  } else {
    // No usable candidate: fail loudly and permanently rather than leaving a plausible default.
    next.configured = false;
    changes.push('configured = false   (nothing detected — every script will now stop with instructions)');
  }

  if (changes.length || !configExisted) {
    ensureDir(dirname(configPath));
    writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    console.log(`\n${configExisted ? 'Wrote' : 'Created'} ${configPath}:`);
    for (const change of changes) console.log(`  ${change}`);
    // Say which values are still the skeleton's guesses, so nobody mistakes "/Login" or "/" for
    // something read out of the project.
    const placeholders = ['loginPath', 'defaultCheckPath', 'authenticatedSelector']
      .filter((key) => next[key] === SKELETON[key]);
    if (placeholders.length) {
      console.log('  Still placeholders, NOT detected — set these from the app\'s own routes:');
      for (const key of placeholders) console.log(`    ${key} = ${JSON.stringify(next[key])}`);
    }
  } else {
    console.log(`\nNo changes needed in ${configPath}.`);
  }

  if (chosen && !chosen.live) {
    console.log('\nNothing is listening there yet — start the dev server before running ensure.mjs.');
  }
}

if (!chosen) {
  console.log('\nSet baseUrl by hand: the dev server URL, e.g. https://localhost:5001.');
  console.log('Look in Properties/launchSettings.json, .vscode/launch.json, vite.config.*,');
  console.log('angular.json, next.config.*, docker-compose.yml, or the project README.');
}

process.exit(chosen ? EXIT_OK : EXIT_ENVIRONMENT);
