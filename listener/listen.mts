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
import { reconcile } from "./reconcile.mts";
import {
  sh,
  handleComment,
  isSummon,
  summon,
  deleteLocalBranch,
  nudgeSpecIfActivated,
  SPEC_LABEL,
} from "./helper.mts";
import { getIssue, setIssue, type IssueStatus } from "./state.mts";
import { classify } from "./classify.mts";
import { notify } from "./notify.mts";
import { readPauseState, writePauseState, clearPauseState, rearmAction } from "./pause-state.mts";
import { startTelegramPolling } from "./telegram.mts";
import { buildStatus, formatStatus } from "./status.mts";

const parentRoot = resolve(import.meta.dirname, "..");
const port = Number(process.env.LISTENER_PORT ?? 8787);
const maxConcurrency = Number(process.env.MAX_CONCURRENCY ?? 3);
const repos = loadRepos(); // fail fast on a malformed routing table
const scheduler = createScheduler(maxConcurrency);

// Act layer (M3.2). The abort registry lets a 403 halt cancel every in-flight
// issue run; the retry map bounds transient (429/network) backoff before giving
// up. Both in-memory — a restart re-derives work from GitHub, and the durable
// pause-state re-arms a quota pause / 403 halt (rearmPause on boot).
const inFlightAborts = new Map<string, AbortController>();
const transientRetries = new Map<string, number>();
const RESUME_GRACE_MS = 5 * 60_000; // resume at quota reset + 5 min
const MAX_TRANSIENT_RETRIES = 3;
const BACKOFF_BASE_MS = 10_000;
// Restack driver bound to the UNCAPPED restack lane (6c). Seeds per-branch steps
// on a blocker's merge; the cascade drains through the same lane.
// `reconcileRestacks` re-derives missed merges on boot (step 7).
const { restackOnMerge, reconcileRestacks } = makeRestacker(scheduler.enqueueRestack);

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
  // A spec is a manifest, never implemented — reject it BEFORE the trigger check
  // so a spec is skipped whatever its labels (and reconcile never routes it to the
  // @sunday-summon branch, which would relabel then run it). The human-facing
  // nudge is the caller's job (nudgeSpecIfActivated) — this stays pure.
  if (present.has(SPEC_LABEL)) {
    return { admit: false, reason: "spec issue — a manifest, not implementable" };
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
  const { resume } = opts;
  const key = `${fullName}#${issue}`;
  const childDir = resolve(parentRoot, cfg.path);
  const prior = getIssue(key);
  // A resume carries no base of its own — recover the ticket's stacked base
  // (persisted at admit/gate) so it doesn't silently fall back to main.
  const baseBranch = opts.baseBranch ?? prior?.baseBranch ?? "main";
  // A resume also carries the prior session's ctx + handoff count (M5.2) so runIssue
  // can decide resume-vs-handoff at the threshold.
  const resumeWithCtx = resume
    ? { ...resume, ctxTokens: prior?.ctxTokens, handoffSeq: prior?.handoffSeq }
    : undefined;
  setIssue(key, { status: "in-flight", baseBranch });
  sh("gh", ["issue", "edit", issue, "--add-label", "agent-working"], childDir);
  if (resume) {
    sh("gh", ["issue", "edit", issue, "--remove-label", "awaiting-human"], childDir);
  }
  // Register an abort handle so a 403 halt can cancel this run mid-flight (M3.2).
  const ac = new AbortController();
  inFlightAborts.set(key, ac);
  try {
    const outcome = await runIssue(fullName, cfg, issue, { baseBranch, resume: resumeWithCtx, signal: ac.signal });
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
      baseBranch,
      // Persist ctx (drives the next resume's threshold) + the handoff count, but only
      // when present — never overwrite a good prior value with undefined (M5.2).
      ...(outcome.ctxTokens !== undefined ? { ctxTokens: outcome.ctxTokens } : {}),
      ...(outcome.handoffSeq !== undefined ? { handoffSeq: outcome.handoffSeq } : {}),
    });
    transientRetries.delete(key); // a clean finish clears the backoff counter
  } catch (err) {
    setIssue(key, { status: "failed" });
    // A run WE aborted (403 halt) already had its taxonomy acted on — don't
    // re-classify it as a fresh failure (that would re-halt, re-notify).
    if (ac.signal.aborted) {
      console.log(`  ✂ ${key} aborted — ${String(ac.signal.reason instanceof Error ? ac.signal.reason.message : ac.signal.reason)}`);
      return;
    }
    // Classify the failure off the RunResult/error shape and act oppositely per
    // class (quota→pause, 403→abort+halt, transient→backoff, run-failed→flag,
    // unknown→halt). notify() writes the durable event first.
    actOnFailure(classify({ error: err }), { fullName, cfg, childDir, issue, key });
  } finally {
    inFlightAborts.delete(key);
    sh("gh", ["issue", "edit", issue, "--remove-label", "agent-working"], childDir);
  }
}

interface FailureCtx {
  fullName: string;
  cfg: RepoConfig;
  childDir: string;
  issue: string;
  key: string;
}

/** React to a classified run failure. Pauses/halts the whole pipeline for quota
 *  and auth; backs off + retries a transient; flags a run-level failure on its
 *  issue; halts on the fail-safe unknown. The event is already durably logged by
 *  notify(); the acts here add the pipeline-control side effects. */
function actOnFailure(event: ReturnType<typeof classify>, ctx: FailureCtx): void {
  const { fullName, cfg, childDir, issue, key } = ctx;
  switch (event.class) {
    case "quota": {
      const resumeAt = event.resetAt !== undefined ? event.resetAt + RESUME_GRACE_MS : undefined;
      scheduler.pause(event.summary);
      writePauseState({ reason: event.summary, since: Date.now(), ...(resumeAt !== undefined ? { resumeAt } : {}) });
      if (resumeAt !== undefined) {
        notify(event); // pipeline-global — auto-resumes, no human needed
        scheduleResume(resumeAt);
      } else {
        // No parseable reset → the human must /resume-at. Home the notice to this
        // issue + awaiting-human so it's actionable.
        notify(event, { fullName, childDir, issue, label: "awaiting-human" });
      }
      break;
    }
    case "auth":
      // 403 → cancel every in-flight run and halt; a human re-auths, reconcile
      // re-admits on the next boot.
      scheduler.pause(event.summary);
      writePauseState({ reason: event.summary, since: Date.now() });
      notify(event);
      abortAllInFlight("403 auth failure — halting");
      break;
    case "transient": {
      const n = (transientRetries.get(key) ?? 0) + 1;
      if (n <= MAX_TRANSIENT_RETRIES) {
        transientRetries.set(key, n);
        const delay = event.retryAfterMs ?? BACKOFF_BASE_MS * 2 ** (n - 1);
        notify(event); // auto-recovers — logged, not homed to the issue
        console.log(`  ↻ ${key} transient — retry ${n}/${MAX_TRANSIENT_RETRIES} in ${Math.round(delay / 1000)}s`);
        setTimeout(() => {
          scheduler.enqueue({ key, branch: `feat/${issue}`, run: () => runAdmitted(fullName, cfg, issue) });
        }, delay);
      } else {
        transientRetries.delete(key);
        notify({ ...event, summary: `${event.summary} — gave up after ${MAX_TRANSIENT_RETRIES} retries` }, { fullName, childDir, issue, label: "agent-failed" });
      }
      break;
    }
    case "run-failed":
      // The agent ran but produced nothing shippable (bad output / dirty). No PR
      // to open — flag the issue for a human.
      notify(event, { fullName, childDir, issue, label: "agent-failed" });
      break;
    case "summarize-failed":
      // M5.2 D4b: an oversized session's handoff turn produced no usable note. Fail
      // the issue as agent-failed (a relabel retries FRESH) — never awaiting-human,
      // which would re-resume the bloated session in a loop. The message is specific.
      notify(event, { fullName, childDir, issue, label: "agent-failed" });
      break;
    case "unknown":
      // Fail-safe: halt so a human looks; the raw excerpt is in events.jsonl.
      scheduler.pause(event.summary);
      writePauseState({ reason: event.summary, since: Date.now() });
      notify(event, { fullName, childDir, issue });
      break;
  }
}

/** Abort a quota pause's clock or a manual resume: clear the durable state and let
 *  both lanes drain. */
function resumePipeline(): void {
  clearPauseState();
  scheduler.resume();
}

/** Schedule the auto-resume of a quota pause at `resumeAt` (reset + grace). */
function scheduleResume(resumeAt: number): void {
  const delay = Math.max(0, resumeAt - Date.now());
  setTimeout(resumePipeline, delay);
  console.log(`  ⏰ auto-resume scheduled for ${new Date(resumeAt).toISOString()}`);
}

/** Cancel every in-flight issue run (403 halt). Each run() rejects with this
 *  reason; runAdmitted sees `signal.aborted` and skips re-classifying it. */
function abortAllInFlight(reason: string): void {
  for (const [key, ac] of inFlightAborts) {
    ac.abort(new Error(reason));
    console.log(`  ✂ aborting in-flight ${key}`);
  }
}

/** On boot, re-arm a persisted pause (M3.2): a quota pause whose reset has passed
 *  resumes now; a future one re-schedules; a 403 halt / no-timestamp quota stays
 *  paused for a human. Runs before reconcile so re-derived work is held, not run. */
function rearmPause(): void {
  const ps = readPauseState();
  if (!ps) return;
  switch (rearmAction(ps, Date.now())) {
    case "resume":
      console.log(`⟲ pause elapsed (${ps.reason}) — resuming`);
      resumePipeline();
      break;
    case "reschedule":
      scheduler.pause(ps.reason);
      scheduleResume(ps.resumeAt!);
      console.log(`⟲ re-armed pause (${ps.reason}) until ${new Date(ps.resumeAt!).toISOString()}`);
      break;
    case "halt":
      scheduler.pause(ps.reason);
      console.log(`⟲ re-armed halt (${ps.reason}) — awaiting a human resume`);
      break;
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

/** Resume a gated session with a human reply (shared by the live comment handler
 *  and reconcile's missed-reply recovery — same enqueue, no drift). */
function resumeGate(fullName: string, cfg: RepoConfig, issue: string, sessionId: string, reply: string): void {
  scheduler.enqueue({
    key: `${fullName}#${issue}`,
    branch: `feat/${issue}`,
    run: () => runAdmitted(fullName, cfg, issue, { resume: { sessionId, reply } }),
  });
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
          // A spec mis-labelled for the agent gets a one-time nudge (no-op otherwise).
          const cfg = repos[repo];
          if (cfg) nudgeSpecIfActivated(repo, cfg, String(number), labels, resolve(parentRoot, cfg.path));
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
            resume: (sessionId, reply) => resumeGate(repo, cfg, issue, sessionId, reply),
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
        if (cfg && rawAction === "closed" && headRef.startsWith("feat/")) {
          // Terminal PR (merged or closed): origin holds the history, so the local
          // branch is no longer the only copy — drop it (else they accumulate).
          deleteLocalBranch(resolve(parentRoot, cfg.path), headRef);
          if (pr?.merged) {
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
  // Re-arm a persisted quota pause / 403 halt BEFORE reconcile, so any work it
  // re-derives is held (both lanes) rather than run into the same wall (M3.2).
  rearmPause();
  // Optional Telegram control channel (M3.4). No-op unless TELEGRAM_BOT_TOKEN is
  // set. Commands drive the SAME pause/resume/pause-state seams the act layer uses
  // — one source of truth. /status merges the live scheduler snapshot onto the
  // durable buildStatus() view.
  startTelegramPolling({
    pause: (reason) => {
      scheduler.pause(reason);
      writePauseState({ reason, since: Date.now() });
    },
    resume: () => resumePipeline(),
    resumeAt: (at) => {
      const reason = "manual /resume-at";
      scheduler.pause(reason);
      writePauseState({ reason, since: Date.now(), resumeAt: at });
      scheduleResume(at);
    },
    status: () => {
      const snap = scheduler.snapshot();
      return (
        `${formatStatus(buildStatus())}\n` +
        `Live: in-flight ${snap.regularInFlight.length + snap.restackInFlight.length}, ` +
        `queued ${snap.regularQueued.length + snap.restackQueued.length}${snap.paused ? " · PAUSED" : ""}`
      );
    },
  });
  // Step 7: re-derive pending work from GitHub. reconcile's gh reads are async
  // (shA) and it yields between work units, so the sweep runs WITHOUT starving the
  // readiness probe's GET /; it drives the SAME callbacks the webhook path uses,
  // so recovery can't drift.
  Promise.resolve()
    .then(() =>
      reconcile({
        repos,
        admitIssue,
        admitOrDefer,
        summon,
        resumeGate,
        enqueuePrComments,
        reconcileRestacks,
      }),
    )
    .catch((err: unknown) =>
      console.log(`✗ reconcile: ${err instanceof Error ? err.message : String(err)}`),
    );
});
