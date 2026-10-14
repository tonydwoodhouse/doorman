// Check this project's doorman.config.json without changing it.
//
//   node check-config.mjs        exit 0: valid; 4: what's wrong and how to fix it
//
// The config belongs to the developer: installers never rewrite one that exists, and run this on an
// upgrade instead, so a setting an older version accepted and this one doesn't is reported rather
// than silently "fixed". Loading config.mjs is the check — a bad value, an unknown setting or an
// unconfigured file is reported exactly as every other script would report it.
import { CONFIG_PATH, config, unknownConfigKeys } from './config.mjs';

console.log(`Config OK: ${CONFIG_PATH}${unknownConfigKeys.length ? '  (see the warning above)' : ''}`);
for (const key of ['baseUrl', 'loginPath', 'defaultCheckPath', 'authenticatedSelector']) {
  console.log(`  ${key.padEnd(22)} ${JSON.stringify(config[key])}`);
}
