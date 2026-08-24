// Verifies the saved session still grants access to a gated page.
// Config: edit doorman.config.json (baseUrl, defaultCheckPath, authenticatedSelector, ...).
//
// Run:  node auth-check.mjs  [path-after-host, default = config.defaultCheckPath]
// e.g.  node auth-check.mjs /admin/reports
//       node auth-check.mjs --profile=admin
//
// Exit codes: 0 authenticated | 1 session invalid | 2 no session yet
//             3 session fine but route non-200 | 4 environment problem (not auth)
//
// NOTE (Git Bash on Windows): a leading-slash arg gets mangled into a Windows
// path. Prefix with MSYS_NO_PATHCONV=1, e.g.
//   MSYS_NO_PATHCONV=1 node auth-check.mjs /admin/reports
import { config, positionals } from './config.mjs';
import { CHECK_SHOT_PATH, checkAndReport } from './verify.mjs';

const target = positionals[0] ?? config.defaultCheckPath;

process.exitCode = await checkAndReport(target, { screenshotPath: CHECK_SHOT_PATH });
