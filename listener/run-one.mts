// listener/run-one.mts — Sunday's one-shot CLI wrapper (M1/M2).
//
//   node --env-file=.env listener/run-one.mts <owner/repo> <issue#>
//
// Hand-runs one issue via the shared runIssue() action — the exact path the
// listener takes. The sandbox decides; the host does all I/O.

import { loadRepos } from "#config/repos.mts";
import { runIssue } from "./run-issue.mts";

const [fullName, issue] = process.argv.slice(2);
if (!fullName || !issue) {
  console.error(
    "usage: node --env-file=.env listener/run-one.mts <owner/repo> <issue#>",
  );
  process.exit(1);
}

const cfg = loadRepos()[fullName];
if (!cfg) {
  console.error(`${fullName} is not in config/repos.json`);
  process.exit(1);
}

await runIssue(fullName, cfg, issue);
