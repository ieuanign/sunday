// listener/listen.mts — Sunday's listener (M2).
//
// Receives GitHub webhook deliveries that `gh webhook forward` pushes to a LOCAL
// port (no public endpoint), decides admission per the routing table, and runs
// admitted issues through the serializing scheduler (one shared quota). The
// sandbox decides; this host does all I/O.
//
//   Terminal 1:  node --env-file=.env listener/listen.mts
//   Terminal 2:  gh webhook forward --repo <owner/repo> \
//                  --events issues,issue_comment,pull_request,pull_request_review_comment \
//                  --url "http://localhost:8787/"

import { createServer } from "node:http";
import { resolve } from "node:path";

import { loadRepos, type RepoConfig } from "#config/repos.mts";
import { createScheduler } from "./scheduler.mts";
import { runIssue } from "./run-issue.mts";
import { runPrComments } from "./run-pr-comments.mts";
import { resolveBase } from "./dag.mts";
import { makeRestacker } from "./restack.mts";
import { sh, handleComment, isSummon } from "./helper.mts";
import { getIssue, setIssue, type IssueStatus } from "./state.mts";

const parentRoot = resolve(import.meta.dirname, "..");
const port = Number(process.env.LISTENER_PORT ?? 8787);
const maxConcurrency = Number(process.env.MAX_CONCURRENCY ?? 3);
const repos = loadRepos(); // fail fast on a malformed routing table
const scheduler = createScheduler(maxConcurrency);
// Restack driver bound to the UNCAPPED restack lane (6c). Seeds per-branch steps
// on a blocker's merge; the cascade drains through the same lane.
const { restackOnMerge } = makeRestacker(scheduler.enqueueRestack);

// Tickets that passed label admission but whose blockers aren't satisfied yet
// (6b). Re-evaluated when a `pull_request` event lands (a blocker may have just
// opened a PR or merged). In-memory only — reconcile (step 7) re-derives this
// from GitHub on restart. Keyed by `${fullName}#${issue}`.
const deferred = new Map<string, { fullName: string; cfg: RepoConfig; issue: string }>();

// Actions that should (re)consider an issue. NOT `unlabeled`/`edited` — those
// fire when we ourselves add/remove `agent-working`, and admitting on them would
// re-run a completed issue. (State-based skip for `done` issues is step 4c.)
const TRIGGER_ACTIONS = new Set(["opened", "reopened", "labeled"]);

// PR actions that can satisfy a deferred ticket's blocker: a blocker's PR
// opening makes it stackable; its merge (a `closed`) makes it base-on-main. (6b)
const PR_REEVAL_ACTIONS = new Set(["opened", "reopened", "closed"]);

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
  opts: { baseBranch?: string; resume?: { sessionId: string; reply: string } } = {},
): Promise<void> {
  const { baseBranch, resume } = opts;
  const key = `${fullName}#${issue}`;
  const childDir = resolve(parentRoot, cfg.path);
  setIssue(key, { status: "in-flight" });
  sh("gh", ["issue", "edit", issue, "--add-label", "agent-working"], childDir);
  if (resume) {
    sh("gh", ["issue", "edit", issue, "--remove-label", "awaiting-human"], childDir);
  }
  try {
    const outcome = await runIssue(fullName, cfg, issue, { baseBranch, resume });
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

/** DAG gate + enqueue (6b). Resolve the ticket's base from its blockers: admit
 *  with the chosen base (main, or a blocker's branch to stack), or park it in the
 *  deferred set. Shared by the issues handler and the deferred re-check. */
function admitOrDefer(fullName: string, cfg: RepoConfig, issue: string): void {
  const key = `${fullName}#${issue}`;
  const childDir = resolve(parentRoot, cfg.path);
  const base = resolveBase(fullName, childDir, issue);
  if (!base.admit) {
    deferred.set(key, { fullName, cfg, issue });
    console.log(`  ⏸ defer ${key} — ${base.reason}`);
    return;
  }
  deferred.delete(key);
  const stacked = base.baseBranch !== "main" ? ` (stack on ${base.baseBranch})` : "";
  console.log(`  ✓ ADMIT ${key}${stacked}`);
  scheduler.enqueue({
    key,
    branch: `feat/${issue}`,
    run: () => runAdmitted(fullName, cfg, issue, { baseBranch: base.baseBranch }),
  });
}

/** A `pull_request` event landed — a blocker may have just opened a PR or merged.
 *  Re-check every deferred ticket in that repo and promote the now-satisfied
 *  ones. Forward re-check by design: the reverse `.../dependencies/blocks` edge
 *  404s, so we never ask "who does B block?" — we re-ask each deferred ticket's
 *  own blockers. */
function reevaluateDeferred(repo: string): void {
  for (const [key, d] of [...deferred]) {
    if (d.fullName !== repo) continue;
    const prior = getIssue(key);
    if (prior && prior.status !== "failed") {
      deferred.delete(key); // already in-flight/done/awaiting-human — stop tracking
      continue;
    }
    admitOrDefer(d.fullName, d.cfg, d.issue);
  }
}

/** Enqueue the @sunday-on-a-PR feedback run (keyed by PR so repeated mentions on
 *  the same PR dedup). Both conversation and inline review comments land here. The
 *  PR's head branch is resolved up front so the run takes the shared per-branch
 *  lock (a restack must not touch this branch while the fix runs, and vice versa). */
function enqueuePrComments(fullName: string, cfg: RepoConfig, pr: string): void {
  const key = `${fullName}#pr${pr}`;
  const childDir = resolve(parentRoot, cfg.path);
  const { headRefName } = JSON.parse(
    sh("gh", ["pr", "view", pr, "--json", "headRefName"], childDir),
  ) as { headRefName: string };
  console.log(`  ✓ PR-COMMENTS ${key} (branch ${headRefName})`);
  scheduler.enqueue({ key, branch: headRefName, run: () => runPrComments(fullName, cfg, pr) });
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
          admitOrDefer(repo, repos[repo], String(number));
        }
      } else if (event === "issue_comment" && rawAction === "created") {
        // Gate resume / @sunday summon / @sunday-on-PR — routed by handleComment
        // (helper.mts). The scheduler lives here, so the resume is injected.
        const cfg = repos[repo];
        if (cfg) {
          const issue = String(number);
          handleComment({
            fullName: repo,
            cfg,
            issue,
            body: payload.comment?.body ?? "",
            labels,
            onPr: Boolean(payload.issue?.pull_request),
            resume: (sessionId, reply) =>
              scheduler.enqueue({
                key: `${repo}#${issue}`,
                branch: `feat/${issue}`,
                run: () => runAdmitted(repo, cfg, issue, { resume: { sessionId, reply } }),
              }),
            summonPr: (pr) => enqueuePrComments(repo, cfg, pr),
          });
        }
      } else if (event === "pull_request_review_comment" && rawAction === "created") {
        // Inline review comment (Files-changed tab). @sunday here → the same
        // PR-comment flow; runPrComments gathers ALL @sunday comments on the PR.
        const cfg = repos[repo];
        const commentBody: string = payload.comment?.body ?? "";
        if (cfg && number && isSummon(commentBody)) {
          enqueuePrComments(repo, cfg, String(number));
        }
      } else if (event === "pull_request" && PR_REEVAL_ACTIONS.has(rawAction)) {
        // A blocker's PR just opened/reopened/merged → deferred dependents may
        // now be admissible. Re-check them (forward edge; see reevaluateDeferred).
        //
        // A MERGE additionally restacks already-stacked dependents (6c): they
        // were admitted+stacked in 6b, so they're NOT in the deferred set —
        // reevaluateDeferred alone would miss them.
        const cfg = repos[repo];
        const pr = payload.pull_request;
        const headRef: string = pr?.head?.ref ?? "";
        if (cfg && rawAction === "closed" && pr?.merged && headRef.startsWith("feat/")) {
          // Seed the restack lane off the handler's critical path (a fetch + gh
          // scan); the per-branch steps then drain through the uncapped lane.
          const mergedIssue = headRef.slice("feat/".length);
          const sha: string = pr.head.sha;
          console.log(`  ✓ RESTACK seed ${repo}#${mergedIssue}`);
          Promise.resolve()
            .then(() => restackOnMerge(repo, cfg, mergedIssue, sha))
            .catch((err: unknown) =>
              console.log(`✗ restack seed ${repo}#${mergedIssue}: ${err instanceof Error ? err.message : String(err)}`),
            );
        }
        reevaluateDeferred(repo);
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
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.warn(
      "⚠ CLAUDE_CODE_OAUTH_TOKEN unset — every agent run (issues, PR fixes, conflict rebases) " +
        "will fail; only clean host rebases work. Start with `node --env-file=.env …`.",
    );
  }
});
