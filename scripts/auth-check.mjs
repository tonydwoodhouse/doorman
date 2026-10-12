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
// Git Bash on Windows rewrites a leading-slash arg into a Windows path; config.mjs undoes it.
import { target } from './config.mjs';
import { CHECK_SHOT_PATH, checkAndReport } from './verify.mjs';


process.exitCode = await checkAndReport(target, { screenshotPath: CHECK_SHOT_PATH });
