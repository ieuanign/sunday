// listener/listen.mts — Sunday's listener (M2).
//
// Receives GitHub webhook deliveries that `gh webhook forward` pushes to a LOCAL
// port (no public endpoint), decides admission per the routing table, and runs
// admitted issues through the serializing scheduler (one shared quota). The
// sandbox decides; this host does all I/O.
//
//   Terminal 1:  node --env-file=.env listener/listen.mts
//   Terminal 2:  gh webhook forward --repo <owner/repo> \
//                  --events issues,issue_comment,pull_request \
//                  --url "http://localhost:8787/"

import { createServer } from "node:http";
import { resolve } from "node:path";

import { loadRepos, type RepoConfig } from "#config/repos.mts";
import { createScheduler } from "./scheduler.mts";
import { runIssue } from "./run-issue.mts";
import { sh } from "./helper.mts";

const parentRoot = resolve(import.meta.dirname, "..");
const port = Number(process.env.LISTENER_PORT ?? 8787);
const maxConcurrency = Number(process.env.MAX_CONCURRENCY ?? 3);
const repos = loadRepos(); // fail fast on a malformed routing table
const scheduler = createScheduler(maxConcurrency);

// Actions that should (re)consider an issue. NOT `unlabeled`/`edited` — those
// fire when we ourselves add/remove `agent-working`, and admitting on them would
// re-run a completed issue. (State-based skip for `done` issues is step 4c.)
const TRIGGER_ACTIONS = new Set(["opened", "reopened", "labeled"]);

type Admission = { admit: true } | { admit: false; reason: string };

/** Admit an issue only if its repo is configured, ALL trigger labels are
 *  present, and it isn't already claimed (`agent-working`). */
export function admitIssue(
  repo: string,
  labels: string[],
  table: Record<string, RepoConfig>,
): Admission {
  const cfg = table[repo];
  if (!cfg) return { admit: false, reason: `${repo} not in config/repos.json` };
  const present = new Set(labels);
  if (present.has("agent-working")) {
    return { admit: false, reason: "already claimed (agent-working)" };
  }
  const missing = cfg.triggerLabels.filter((label) => !present.has(label));
  if (missing.length > 0) {
    return { admit: false, reason: `missing trigger label(s) [${missing.join(", ")}]` };
  }
  // TODO(step 4c): also skip issues already `done` (state), and never auto-dev
  // parent/tracker issues (needs a tracker-label convention).
  return { admit: true };
}

/** Claim the issue with `agent-working` (the durable cross-restart guard), run
 *  it, then release the claim regardless of outcome. */
async function runAdmitted(
  fullName: string,
  cfg: RepoConfig,
  issue: string,
): Promise<void> {
  const childDir = resolve(parentRoot, cfg.path);
  sh("gh", ["issue", "edit", issue, "--add-label", "agent-working"], childDir);
  try {
    await runIssue(fullName, cfg, issue);
  } finally {
    sh("gh", ["issue", "edit", issue, "--remove-label", "agent-working"], childDir);
  }
}

const server = createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200).end("sunday listener up\n");
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const event = req.headers["x-github-event"] ?? "?";
    try {
      const payload = JSON.parse(body);
      const repo = payload.repository?.full_name ?? "?";
      const rawAction: string = payload.action ?? "";
      const number = payload.issue?.number ?? payload.pull_request?.number ?? "";
      const labels: string[] = (
        payload.issue?.labels ??
        payload.pull_request?.labels ??
        []
      ).map((label: { name: string }) => label.name);

      console.log(
        `← ${event}${rawAction ? `.${rawAction}` : ""}  ${repo}#${number}` +
          (labels.length ? `  [${labels.join(", ")}]` : ""),
      );

      if (event === "issues" && TRIGGER_ACTIONS.has(rawAction)) {
        const decision = admitIssue(repo, labels, repos);
        if (decision.admit) {
          console.log(`  ✓ ADMIT ${repo}#${number}`);
          const cfg = repos[repo];
          scheduler.enqueue({
            key: `${repo}#${number}`,
            run: () => runAdmitted(repo, cfg, String(number)),
          });
        } else {
          console.log(`  · skip — ${decision.reason}`);
        }
      }
    } catch {
      console.log(`← ${event}  (unparseable body, ${body.length}b)`);
    }
    res.writeHead(200).end("ok");
  });
});

server.listen(port, () => {
  console.log(
    `listener up on http://localhost:${port} — routing ${Object.keys(repos).length} repo(s), cap ${maxConcurrency}`,
  );
});
