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
import { runIssue, SUNDAY_MARKER } from "./run-issue.mts";
import { sh } from "./helper.mts";
import { getIssue, setIssue, type IssueStatus } from "./state.mts";

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
  // (The done/in-flight state skip lives in the handler; parent/tracker
  //  exclusion is still TODO — needs a tracker-label convention.)
  return { admit: true };
}

/** Claim the issue with `agent-working` (the durable cross-restart guard), run
 *  or resume it, map the agent's signal to durable state, then release the claim
 *  regardless of outcome. `resume` continues a gated session with a human reply. */
async function runAdmitted(
  fullName: string,
  cfg: RepoConfig,
  issue: string,
  resume?: { sessionId: string; reply: string },
): Promise<void> {
  const key = `${fullName}#${issue}`;
  const childDir = resolve(parentRoot, cfg.path);
  setIssue(key, { status: "in-flight" });
  sh("gh", ["issue", "edit", issue, "--add-label", "agent-working"], childDir);
  if (resume) {
    sh("gh", ["issue", "edit", issue, "--remove-label", "awaiting-human"], childDir);
  }
  try {
    const outcome = await runIssue(fullName, cfg, issue, resume);
    // gate → keep the session open for a human; fail (or ready/draft that shipped
    // nothing) → failed; ready/draft with a PR → done. runIssue already posted the
    // gate comment + `awaiting-human` label.
    const status: IssueStatus =
      outcome.signal === "gate"
        ? "awaiting-human"
        : outcome.signal === "fail" || !outcome.prUrl
          ? "failed"
          : "done";
    setIssue(key, {
      status,
      branch: outcome.branch,
      prUrl: outcome.prUrl,
      sessionId: outcome.sessionId,
    });
  } catch (err) {
    setIssue(key, { status: "failed" });
    throw err; // let the scheduler log it
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
        const key = `${repo}#${number}`;
        const decision = admitIssue(repo, labels, repos);
        const prior = getIssue(key);
        if (!decision.admit) {
          console.log(`  · skip — ${decision.reason}`);
        } else if (prior && prior.status !== "failed") {
          // already in-flight / done / awaiting-human — don't re-run
          // (a `failed` issue may retry on a re-label).
          console.log(`  · skip ${key} — state=${prior.status}`);
        } else {
          console.log(`  ✓ ADMIT ${key}`);
          const cfg = repos[repo];
          scheduler.enqueue({
            key,
            run: () => runAdmitted(repo, cfg, String(number)),
          });
        }
      } else if (event === "issue_comment" && rawAction === "created") {
        // Gate resume: a human reply on an `awaiting-human` issue continues the
        // agent's session. Skip our OWN gate comment (same author → filter by
        // marker) and comments on non-gated issues.
        const key = `${repo}#${number}`;
        const cfg = repos[repo];
        const prior = getIssue(key);
        const commentBody: string = payload.comment?.body ?? "";
        if (!cfg || !prior || prior.status !== "awaiting-human") {
          // not a gated issue we own — ignore silently
        } else if (commentBody.includes(SUNDAY_MARKER)) {
          console.log(`  · skip ${key} — our own gate comment`);
        } else if (!prior.sessionId) {
          console.log(`  · skip ${key} — awaiting-human but no session to resume`);
        } else {
          console.log(`  ✓ RESUME ${key}`);
          const sessionId = prior.sessionId;
          scheduler.enqueue({
            key,
            run: () => runAdmitted(repo, cfg, String(number), { sessionId, reply: commentBody }),
          });
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
