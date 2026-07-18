// listener/listen.mts — Sunday's listener (M2).
//
// Receives GitHub webhook deliveries that `gh webhook forward` pushes to a LOCAL
// port (no public endpoint — gh dials out to GitHub and re-delivers here), and
// decides admission per the routing table. It does NOT run anything yet — the
// serializing loop + the run action come next (M2.3).
//
//   Terminal 1:  node --env-file=.env listener/listen.mts
//   Terminal 2:  gh webhook forward --repo <owner/repo> \
//                  --events issues,issue_comment,pull_request \
//                  --url "http://localhost:8787/"

import { createServer } from "node:http";

import { loadRepos, type RepoConfig } from "../config/repos.mts";

const port = Number(process.env.LISTENER_PORT ?? 8787);
const repos = loadRepos(); // fail fast on a malformed routing table

type Admission = { admit: true } | { admit: false; reason: string };

/** Admit an issue only if its repo is configured and ALL trigger labels are present. */
export function admitIssue(
  repo: string,
  labels: string[],
  table: Record<string, RepoConfig>,
): Admission {
  const cfg = table[repo];
  if (!cfg) return { admit: false, reason: `${repo} not in config/repos.json` };
  const present = new Set(labels);
  const missing = cfg.triggerLabels.filter((label) => !present.has(label));
  if (missing.length > 0) {
    return { admit: false, reason: `missing trigger label(s) [${missing.join(", ")}]` };
  }
  // TODO(M2.3): never auto-dev parent/tracker issues (needs a tracker-label convention).
  return { admit: true };
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
      const action = payload.action ? `.${payload.action}` : "";
      const number = payload.issue?.number ?? payload.pull_request?.number ?? "";
      const labels: string[] = (
        payload.issue?.labels ??
        payload.pull_request?.labels ??
        []
      ).map((label: { name: string }) => label.name);

      console.log(
        `← ${event}${action}  ${repo}#${number}` +
          (labels.length ? `  [${labels.join(", ")}]` : ""),
      );

      if (event === "issues") {
        const decision = admitIssue(repo, labels, repos);
        console.log(
          decision.admit
            ? `  ✓ ADMIT ${repo}#${number}`
            : `  · skip — ${decision.reason}`,
        );
      }
    } catch {
      console.log(`← ${event}  (unparseable body, ${body.length}b)`);
    }
    res.writeHead(200).end("ok");
  });
});

server.listen(port, () => {
  console.log(
    `listener up on http://localhost:${port} — routing ${Object.keys(repos).length} repo(s)`,
  );
});
