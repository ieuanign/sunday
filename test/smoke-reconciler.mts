// test/smoke-reconciler.mts — hermetic smoke for re-deriving outstanding work from
// GitHub, which is always the truth (CONTEXT.md).
//   devbox run node test/smoke-reconciler.mts
// Section one is PURE: the rule that decides whether a comment thread carries a summon
// Sunday has not answered. The sections after it drive the real `Reconciler` over the
// real Assignor, scheduler and state store, with GitHub substituted by synthetic issue
// lists and comment streams — the one thing here that reaches the world.
// $0, no network, no GitHub.

import { rmSync } from "node:fs";
import { resolve } from "node:path";

import { FailurePolicy } from "#assignor/failure.mts";
import { Assignor, type ForkWorkItem, type Paths } from "#assignor/index.mts";
import { PauseStore } from "#assignor/pause.mts";
import { hasUnansweredSummon, Reconciler } from "#assignor/reconcile.mts";
import { createScheduler } from "#assignor/scheduler.mts";
import { StateStore } from "#assignor/state.mts";
import type { RepoConfig } from "#config/repos.mts";
import { acquireLock, readLock } from "#lib/lock.mts";
import { sundayComment, sundayReply } from "#lib/markers.mts";
import { AGENT_FAILED_LABEL, CLAIM_LABEL, QUARANTINE_LABEL, type GitHubLabels, type GitHubReconcile, type IssueComment, type OpenIssue, type OpenPullRequest, type ReviewComment } from "#services/github/index.mts";
import { Logger, type Destinations, type LogLine } from "#services/logger.mts";

const dir = resolve(import.meta.dirname, "..", ".scratch", `smoke-reconciler-${process.pid}`);

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

/** Two routed repos, because "one repo's failure does not abort the others" is only an
 *  answer when there IS another one. Both carry the same triggers, so a label short of
 *  admission is short of it in either. */
const TABLE: Record<string, RepoConfig> = {
  "acme/finance": { path: "repos/finance", imageName: "sunday-finance", promptFile: "docs/prompt.md", triggerLabels: ["sunday", "ready-for-agent"] },
  "acme/ops": { path: "repos/ops", imageName: "sunday-ops", promptFile: "docs/prompt.md", triggerLabels: ["sunday", "ready-for-agent"] },
};

const TRIGGERS = ["sunday", "ready-for-agent"];

/** Did anything say this at all? Every issue reconcile passes over leaves a line, because
 *  a work item dropped in silence is indistinguishable from one nobody had. */
const said = (lines: LogLine[], text: string) => lines.some((l) => l.message.includes(text));

let caseNo = 0;

/** One reconcile: the real `Reconciler` over the real Assignor, scheduler and state store,
 *  with GitHub substituted — every method on it is either a real edit to a real repo or a
 *  network read, and the whole point of the class is WHAT it asks GitHub and what it does
 *  with the answer. Paths point into this case's own dir, so the real `var/` is untouched. */
function harness(over: { issues?: Record<string, OpenIssue[]>; throws?: Record<string, string>; comments?: Record<string, IssueComment[]>; releaseThrows?: string; claimThrows?: string; prs?: Record<string, OpenPullRequest[]>; prThrows?: Record<string, string>; review?: Record<string, ReviewComment[]>; commentsThrow?: string } = {}) {
  const caseDir = resolve(dir, `case-${caseNo++}`);
  const lines: LogLine[] = [];
  const comments: LogLine[] = [];
  const dests: Destinations = {
    console: () => {},
    runLog: (line) => void lines.push(line),
    eventLog: () => {},
    github: (line) => void comments.push(line),
    phone: () => {},
  };
  const logger = new Logger(dests);

  const claimed: string[] = [];
  const released: string[] = [];
  // The claim releases that went through the INHERITED SYNCHRONOUS seam, kept apart from
  // the async ones so "off the event loop" is observable at all. Reconcile's release count
  // is bounded by how many open issues wear a stale claim — nothing caps that — so one
  // blocking `gh` round-trip each is a parent that answers no readiness probe for as long
  // as the sweep runs, and a supervisor that SIGKILLs it (ADR-0001).
  const releasedSync: string[] = [];
  const labelled: string[] = [];
  const github: GitHubReconcile & GitHubLabels = {
    claim: (repo, issue) => {
      // `gh issue edit` against somebody else's service, on the admission path this pass
      // hands every open issue to.
      if (over.claimThrows === `${repo}#${issue}`) throw new Error("gh issue edit failed: HTTP 502");
      claimed.push(`${repo}#${issue}`);
    },
    release: (repo, issue) => void releasedSync.push(`${repo}#${issue}`),
    releaseAsync: async (repo, issue) => {
      if (over.releaseThrows === `${repo}#${issue}`) throw new Error("gh issue edit failed: HTTP 502");
      released.push(`${repo}#${issue}`);
    },
    listOpenIssues: async (repo) => {
      // `gh issue list` is a network read against somebody else's service: it 502s, it
      // rate-limits, and the token expires. `throws` is one of those.
      const boom = over.throws?.[repo];
      if (boom) throw new Error(boom);
      return over.issues?.[repo] ?? [];
    },
    issueComments: async (repo, issue) => {
      // A PR's conversation IS its issue thread, so the same read answers both halves of
      // the pass — and it is a network read that 502s like any other.
      if (over.commentsThrow === `${repo}#${issue}`) throw new Error("gh api comments failed: HTTP 502");
      return over.comments?.[`${repo}#${issue}`] ?? [];
    },
    addLabels: async (repo, issue, labels) => void labelled.push(`${repo}#${issue} [${labels.join(", ")}]`),
    // Admission's blocker read (#42), answering "nothing blocks this issue": what this
    // file is about is which issues reconcile hands to admission, not what it decides.
    blockedBy: async () => [],
    issueState: async () => "closed",
    readIssue: async () => ({ title: "", body: "" }),
    openPrForHead: async () => undefined,
    // The PR half of a repo's pass (#44), and a `gh pr list` that fails the way the issue
    // list does.
    listOpenPrs: async (repo) => {
      const boom = over.prThrows?.[repo];
      if (boom) throw new Error(boom);
      return over.prs?.[repo] ?? [];
    },
    reviewComments: async (repo, pr) => over.review?.[`${repo}#pr${pr}`] ?? [],
    // Answered off the case's OWN open pull requests, so a re-derive that reached a PR
    // this smoke never declared is a failure rather than a decision on invented data.
    readPr: async (repo, pr) => {
      const open = over.prs?.[repo]?.find((p) => p.number === pr);
      if (!open) throw new Error(`readPr: ${repo}#${pr} is not an open pull request in this case`);
      return { head: open.head, base: "main", state: "open" };
    },
    // The PR lane's label write (#44) — the failure policy takes this seam too, and no
    // case here fails a PR item.
    labelPr: async () => {
      throw new Error("labelPr: no case in this smoke labels a pull request");
    },
    // #66's release: a re-derive hands admission what GitHub already told it, so nothing
    // here reads or edits labels for one.
    issueLabels: async () => {
      throw new Error("issueLabels: no case in this smoke releases a parked item");
    },
    removeLabels: async () => {
      throw new Error("removeLabels: no case in this smoke releases a parked item");
    },
  };

  const paths: Paths = {
    resultPath: (key) => resolve(caseDir, "results", `${key.replace(/[^A-Za-z0-9._-]/g, "-")}.json`),
    pidPath: (key) => resolve(caseDir, "running", `${key.replace(/[^A-Za-z0-9._-]/g, "-")}.pid`),
    runLogPath: (fullName, flow) => resolve(caseDir, "log", fullName, flow, "run.log"),
    eventLogPath: resolve(caseDir, "log", "events.jsonl"),
  };

  // Never settles: an admitted item stays in-flight in the queue, which is what makes
  // "did this reach the seam" observable without forking a process.
  const forked: string[] = [];
  const fork: ForkWorkItem = (job) => {
    forked.push(job.key);
    return new Promise(() => {});
  };

  const scheduler = createScheduler(10, logger.child("scheduler"));
  const state = new StateStore(resolve(caseDir, "state.json"));
  // The real policy over this case's own pause file (#39): re-deriving admits work, and
  // what a failed one MEANS is `test/smoke-failure.mts`'s subject — what matters here is
  // that no case in this file can reach the real `var/pause.json`.
  const failure = new FailurePolicy({ pause: new PauseStore(resolve(caseDir, "pause.json")), scheduler, state, github, log: logger.child("failure") });
  // Annotated for the reason main.mts is: `recheckPr` closes over the Reconciler built
  // FROM this object, and inference cannot walk that cycle unaided.
  const assignor: Assignor = new Assignor({ repos: TABLE, github, log: logger.child("assignor"), scheduler, state, fork, paths, restack: async () => {}, failure, recheckPr: (repo, number, labels) => reconciler.pullRequest(repo, { number, labels }) });
  const reconciler = new Reconciler({ repos: TABLE, github, assignor, log: logger.child("reconcile") });

  /** Everything the queue knows about, running or waiting — a work item that reached the
   *  seam is in here whichever it is. */
  const queued = () => {
    const s = scheduler.snapshot();
    return [...s.regularInFlight, ...s.regularQueued].sort();
  };

  return { reconciler, assignor, scheduler, state, paths, lines, comments, claimed, released, releasedSync, labelled, forked, queued };
}

try {
  // ── the missed summon. A human writes "@sunday please look at this" while Sunday is
  //    down; GitHub never replays that comment, so the only way the work is ever picked
  //    up is a boot that re-reads the thread. What makes it decidable with no state of
  //    ours is GitHub's own comment ids: they are monotonic, so a summon older than our
  //    newest reply was answered — on this boot and on every boot after it ──
  {
    const human = (id: number, body: string) => ({ id, body });
    const sunday = (id: number, body: string) => ({ id, body: sundayComment(body) });

    ok(
      "summon: a human @sunday nobody replied to is outstanding work",
      hasUnansweredSummon([human(1, "@sunday can you take this?")]),
    );
    ok(
      "summon: one Sunday already answered is not — the reply is newer than the ask",
      !hasUnansweredSummon([human(1, "@sunday can you take this?"), sunday(2, "on it")]),
      "a summon that re-fires every boot is a repeated agent run on real quota",
    );
    ok(
      "summon: a SECOND ask after that answer is outstanding again",
      hasUnansweredSummon([human(1, "@sunday take this"), sunday(2, "done"), human(3, "@sunday one more thing")]),
    );
    ok(
      "summon: Sunday quoting the request it is answering does not summon Sunday",
      !hasUnansweredSummon([sunday(2, "you asked: @sunday take this")]),
      "Sunday posts under the same account a human does — unguarded, it answers itself forever",
    );
    ok(
      "summon: an ordinary conversation with no @sunday in it is nobody's work",
      !hasUnansweredSummon([human(1, "agreed, let us do that next quarter")]),
    );
  }

  // ── the whole point of the module (constraint 3): an issue re-derived from GitHub goes
  //    through the SAME admission the webhook path uses. v1 kept a live handler and a
  //    recovery handler and they drifted — so this is asserted the only way that can
  //    catch a drift, by running one issue down each path and comparing what came out ──
  {
    const labels = [...TRIGGERS, "bug"];
    const rederived = harness({ issues: { "acme/finance": [{ number: 57, labels }, { number: 58, labels: ["bug"] }] } });
    await rederived.reconciler.run();

    const live = harness();
    live.assignor.handle({ event: "issues", action: "labeled", repo: "acme/finance", number: 57, labels, onPullRequest: false, merged: false });
    // The live route fires admission and does not wait for it — it reaches GitHub now
    // (#42), and the receiver calling it cannot see a rejection. The sweep awaits its own.
    await new Promise((settle) => setTimeout(settle, 0));

    ok("seam: an open issue carrying its triggers is claimed, exactly as a delivery for it would be", rederived.claimed.join(",") === live.claimed.join(",") && rederived.claimed.join(",") === "acme/finance#57", `${rederived.claimed.join(",")} vs ${live.claimed.join(",")}`);
    ok("seam: recorded in the same state", rederived.state.get("acme/finance#57")?.status === live.state.get("acme/finance#57")?.status, `${JSON.stringify(rederived.state.get("acme/finance#57"))} vs ${JSON.stringify(live.state.get("acme/finance#57"))}`);
    ok("seam: and queued as the same work item — one admission path, so the two cannot drift", rederived.queued().join(",") === live.queued().join(",") && rederived.queued().join(",") === "acme/finance#57", `${rederived.queued().join(",")} vs ${live.queued().join(",")}`);
    ok("seam: an open issue without its trigger labels is not Sunday's — reconcile admits, it does not conscript", !rederived.claimed.includes("acme/finance#58") && rederived.state.get("acme/finance#58") === undefined, `${rederived.claimed.join(",")} ${JSON.stringify(rederived.state.get("acme/finance#58"))}`);
    ok("seam: and the skip says why, since an issue a human expected to run and did not is the question reconcile exists to answer", said(rederived.lines, "acme/finance#58"), JSON.stringify(rederived.lines.map((l) => l.message)));
  }

  // ── the claim nobody is on. `agent-working` is Sunday's cross-restart mutual exclusion:
  //    admission rejects a claimed issue outright. So a parent that died holding one
  //    leaves an issue that NO delivery can ever re-admit — a work item lost in the one
  //    way that looks, on GitHub, exactly like a work item in progress ──
  {
    const h = harness({ issues: { "acme/finance": [{ number: 57, labels: [...TRIGGERS, CLAIM_LABEL] }] } });
    await h.reconciler.run();

    ok("orphan: a claim with no process behind it is released", h.released.join(",") === "acme/finance#57", h.released.join(","));
    ok("orphan: and released OFF the event loop — a restart can find any number of stale claims, and one blocking `gh` round-trip each is a parent that answers no readiness probe until the sweep ends", h.releasedSync.length === 0, `blocking releases: ${h.releasedSync.join(",")}`);
    ok("orphan: and the issue under it is reconsidered in the same pass — leaving it for the next webhook is waiting for an event GitHub will never send again", h.queued().join(",") === "acme/finance#57", `${h.queued().join(",")} claimed=${h.claimed.join(",")}`);
    ok("orphan: it is named, because a released claim is Sunday editing somebody's issue", said(h.lines, "acme/finance#57") && said(h.lines, CLAIM_LABEL), JSON.stringify(h.lines.map((l) => l.message)));
  }

  // ── and the same claim with a process behind it (constraint 6). Children deliberately
  //    outlive the parent (ADR-0001), so a live lock means somebody IS on this issue
  //    whatever this parent remembers. Releasing it re-admits the issue underneath a run
  //    still in progress: two agents on the same work, on real quota, both pushing the
  //    same branch. It is the one genuinely dangerous write in the file ──
  {
    const h = harness({ issues: { "acme/finance": [{ number: 57, labels: [...TRIGGERS, CLAIM_LABEL] }] } });
    acquireLock(h.paths.pidPath("acme/finance#57"), process.pid); // a live holder — this very process
    await h.reconciler.run();

    ok("live child: the claim stays ON — the process on the item says so, not this parent's memory", h.released.length === 0 && h.releasedSync.length === 0, `${h.released.join(",")} ${h.releasedSync.join(",")}`);
    ok("live child: and nothing is re-admitted under the run that is still going", h.queued().length === 0 && h.claimed.length === 0, `${h.queued().join(",")} claimed=${h.claimed.join(",")}`);
    ok("live child: the lock it is working under is left exactly where it is", readLock(h.paths.pidPath("acme/finance#57"))?.alive === true, JSON.stringify(readLock(h.paths.pidPath("acme/finance#57"))));
    ok("live child: the skip names the process that owns the item", said(h.lines, `pid ${process.pid}`), JSON.stringify(h.lines.map((l) => l.message)));
  }

  // ── the summon Sunday never saw. A human writes "@sunday do this" while the pipeline is
  //    down: GitHub fires that webhook once and never again, so the issue sits there
  //    short only the labels the human would have had to add. Replayed as those labels,
  //    it reaches admission by its ORDINARY path — reconcile never admits around it ──
  {
    const h = harness({
      issues: {
        "acme/finance": [
          { number: 57, labels: ["bug"] }, // asked for while Sunday was down
          { number: 58, labels: ["bug"] }, // asked for, and already served
          { number: 59, labels: ["bug"] }, // nobody asked
          { number: 60, labels: ["bug", "spec"] }, // asked for, but not implementable
        ],
      },
      comments: {
        "acme/finance#57": [{ id: 1, body: "@sunday please take this one" }],
        "acme/finance#58": [{ id: 1, body: "@sunday please take this one" }, { id: 2, body: sundayComment("▶ work started") }],
        "acme/finance#60": [{ id: 1, body: "@sunday build this spec" }],
      },
    });
    await h.reconciler.run();

    ok("summon: an issue short only its triggers, with a summon nobody answered, gets those labels", h.labelled.join(",") === "acme/finance#57 [sunday, ready-for-agent]", h.labelled.join(","));
    ok("summon: and is admitted on them in the same pass — waiting for the `labeled` webhook we just caused is a second round-trip a restart cannot count on", h.queued().join(",") === "acme/finance#57", `${h.queued().join(",")} claimed=${h.claimed.join(",")}`);
    ok("summon: one Sunday already replied to is left alone — re-labelling it re-runs work that is done, on real quota", !h.labelled.some((l) => l.includes("#58")) && !h.queued().includes("acme/finance#58"), `${h.labelled.join(",")} ${h.queued().join(",")}`);
    ok("summon: an issue nobody summoned Sunday on is not conscripted by reconcile", !h.labelled.some((l) => l.includes("#59")) && !h.queued().includes("acme/finance#59"), `${h.labelled.join(",")} ${h.queued().join(",")}`);
    ok("summon: nor is a spec — it is short its triggers AND unimplementable, and labelling it would relabel a manifest and run it", !h.labelled.some((l) => l.includes("#60")) && !h.queued().includes("acme/finance#60"), `${h.labelled.join(",")} ${h.queued().join(",")}`);
    ok("summon: the replay is reported — Sunday added labels to a human's issue and the thread never says so", said(h.lines, "acme/finance#57") && said(h.lines, "summon"), JSON.stringify(h.lines.map((l) => l.message)));
  }

  // ── the other half of a repo's pass (#44). A pull request is a work item too, and the
  //    summon on one arrives as a webhook that fires exactly once: down, restarted or
  //    blacked out, and it is gone. What makes it re-derivable with nothing of ours is the
  //    reply marker — a summon newer than Sunday's newest REPLY is outstanding, whatever
  //    the state file remembers ──
  {
    const human = (id: number, body: string) => ({ id, body });
    const inline = (id: number, body: string) => ({ id, body, path: "src/pay.ts", line: 12 });
    const h = harness({
      prs: {
        "acme/finance": [
          { number: 110, head: "feat/10", labels: [] }, // asked, in the conversation
          { number: 111, head: "feat/11", labels: [] }, // asked, and already answered
          { number: 112, head: "feat/12", labels: [] }, // asked, inline on a file line
          { number: 113, head: "feat/13", labels: [] }, // asked mid-run, and only milestoned
          { number: 114, head: "feat/14", labels: [] }, // nobody asked
        ],
      },
      comments: {
        "acme/finance#110": [human(1, "@sunday the naming here is off")],
        "acme/finance#111": [human(1, "@sunday fix the naming"), { id: 2, body: sundayReply("renamed it", 1) }],
        "acme/finance#113": [
          { id: 1, body: sundayComment("▶ work started") },
          human(2, "@sunday while you are in there, the log line too"),
          { id: 3, body: sundayComment("✓ done — answered 1 comment(s)") },
        ],
        "acme/finance#114": [human(1, "looks good to me")],
      },
      review: {
        "acme/finance#pr112": [inline(9, "@sunday this branch is unreachable")],
        "acme/finance#pr111": [inline(9, "@sunday fix the naming"), inline(10, sundayReply("renamed it", 9))],
      },
    });
    await h.reconciler.run();

    ok("pr: an open pull request carrying a summon nobody answered is re-derived as its own work item", h.queued().includes("acme/finance#pr110"), `${h.queued().join(",")} claimed=${h.claimed.join(",")}`);
    ok("pr: keyed `#pr<n>`, so it can never share a state entry, a lock or a result file with the issue that happens to be numbered the same", h.state.get("acme/finance#pr110")?.status === "in-flight" && h.state.get("acme/finance#110") === undefined, JSON.stringify(h.state.get("acme/finance#pr110")));
    ok("pr: and it holds the pull request's own head branch, which is the lock keeping a comment run out of an issue run's checkout", h.state.get("acme/finance#pr110")?.head === "feat/10", JSON.stringify(h.state.get("acme/finance#pr110")));
    ok("pr: one already replied to is left alone — re-deriving it is a whole agent run answering a question that has its answer", !h.queued().includes("acme/finance#pr111"), h.queued().join(","));
    ok("pr: a summon left INLINE on a file line is re-derived too — the two streams are read separately, and neither can answer for the other", h.queued().includes("acme/finance#pr112"), h.queued().join(","));
    ok("pr: a milestone comment does not answer anything — judged by Sunday's marker alone, the two every work item posts would bury a summon that landed mid-run forever", h.queued().includes("acme/finance#pr113"), h.queued().join(","));
    ok("pr: a pull request nobody summoned Sunday on is not conscripted, exactly as an issue is not", !h.queued().includes("acme/finance#pr114"), h.queued().join(","));
    ok("pr: and no claim is taken on any of them — `agent-working` is an ISSUE label, and the orphan sweep above walks issues only, so one left on a pull request is a state nothing ever releases", h.claimed.length === 0 && h.released.length === 0, `claimed=${h.claimed.join(",")} released=${h.released.join(",")}`);
    ok("pr: each one that was re-derived says so, since a summon replayed weeks late is Sunday acting on a comment nobody remembers writing", said(h.lines, "acme/finance#pr110") && said(h.lines, "acme/finance#pr112"), JSON.stringify(h.lines.map((l) => l.message)));
  }

  // ── the labels are read off the SAME list (#44 constraint 2). An item set aside after
  //    failing twice is refused on the strength of the `quarantined` label, and a human
  //    taking that label off is what hands it back. Re-derived with an empty label list it
  //    would be handed back by the pass itself — on every boot, every blackout catch-up and
  //    every repo recheck, each one a real agent run on real quota ──
  {
    const h = harness({
      prs: {
        "acme/finance": [
          { number: 110, head: "feat/10", labels: [QUARANTINE_LABEL] },
          { number: 111, head: "feat/11", labels: [] }, // set aside too, and handed back by a human
        ],
      },
      comments: {
        "acme/finance#110": [{ id: 1, body: "@sunday the naming here is off" }],
        "acme/finance#111": [{ id: 1, body: "@sunday the naming here is off" }],
      },
    });
    h.state.set("acme/finance#pr110", { status: "quarantined" });
    h.state.set("acme/finance#pr111", { status: "quarantined" });
    await h.reconciler.run();

    ok("quarantine: a pull request still wearing the label is not re-derived, whatever its thread says", !h.queued().includes("acme/finance#pr110"), h.queued().join(","));
    ok("quarantine: and one a human has taken it off is handed straight back, through the same pass", h.queued().includes("acme/finance#pr111"), h.queued().join(","));
  }

  // ── the issue lane's other parked label (#68). It has to hold with NO state entry behind
  //    it: a fresh boot off a lost `var/` re-derives every open issue. One case covers all
  //    three callers — boot, blackout catch-up and the per-repo recheck are the same pass ──
  {
    const h = harness({
      issues: {
        "acme/finance": [
          { number: 57, labels: [...TRIGGERS, AGENT_FAILED_LABEL] },
          { number: 58, labels: TRIGGERS }, // the same triggers, and no verdict on it
        ],
      },
    });
    await h.reconciler.run();

    ok("agent-failed: an open issue wearing the label is not re-derived, and the one beside it still is", h.queued().join(",") === "acme/finance#58", `${h.queued().join(",")} claimed=${h.claimed.join(",")}`);
    ok("agent-failed: and no claim is taken on it — a claim without a run behind it is the orphan the sweep above exists to strip", h.claimed.join(",") === "acme/finance#58", h.claimed.join(","));
    ok("agent-failed: it is named, since an item nothing moves again until a human acts must not drop out of the pass in silence", said(h.lines, "acme/finance#57") && said(h.lines, AGENT_FAILED_LABEL), JSON.stringify(h.lines.map((l) => l.message)));
  }

  // ── reconcile is the ONE place Sunday reads somebody else's service in bulk, and that
  //    service 502s, rate-limits and expires tokens. A repo that cannot be read must cost
  //    that repo its pass and nothing more: GitHub is still the truth, so the next boot
  //    simply asks again — but a backlog abandoned because a DIFFERENT repo failed is
  //    work nobody ever comes back for ──
  {
    const h = harness({
      throws: { "acme/finance": "gh issue list failed: HTTP 502" },
      issues: { "acme/ops": [{ number: 12, labels: TRIGGERS }] },
    });
    await h.reconciler.run();

    ok("isolation: a repo whose issue list fails does not take the repos behind it down with it", h.queued().join(",") === "acme/ops#12", `${h.queued().join(",")} claimed=${h.claimed.join(",")}`);
    ok("isolation: and the repo that failed is named at error — a backlog silently not re-derived looks exactly like an empty one", h.lines.some((l) => l.level === "error" && l.message.includes("acme/finance") && l.message.includes("502")), JSON.stringify(h.lines.map((l) => `${l.level} ${l.message}`)));
    ok("isolation: and it reaches no issue thread in that repo — a repo Sunday could not read is the operator's problem, not every author's", h.comments.every((l) => l.context.repo !== "acme/finance"), JSON.stringify(h.comments.map((l) => `${JSON.stringify(l.context)} ${l.message}`)));
  }

  // ── the same, one level down: reconsidering ONE issue reaches GitHub too (the claim
  //    strip, the label replay), so a single issue that fails must not abandon the rest of
  //    that repo's backlog behind it ──
  {
    const h = harness({
      issues: { "acme/finance": [{ number: 57, labels: [...TRIGGERS, CLAIM_LABEL] }, { number: 58, labels: TRIGGERS }] },
      releaseThrows: "acme/finance#57",
    });
    await h.reconciler.run();

    ok("isolation: an issue that fails mid-pass does not strand the ones behind it", h.queued().join(",") === "acme/finance#58", `${h.queued().join(",")} claimed=${h.claimed.join(",")}`);
    ok("isolation: and it is named, since it is an issue still holding a claim nobody is on", h.lines.some((l) => l.level === "error" && l.message.includes("acme/finance#57")), JSON.stringify(h.lines.map((l) => `${l.level} ${l.message}`)));
  }

  // ── ADMISSION reaches GitHub now too (#42 asks what blocks each issue), so it is the
  //    other thing here that can fail per issue — and it is only inside this pass's
  //    per-issue try/catch if the pass actually WAITS for it. An admission left floating
  //    rejects where nothing is listening, which is an unhandled rejection and the whole
  //    parent under `restart: always` (ADR-0001) ──
  {
    const h = harness({
      issues: { "acme/finance": [{ number: 57, labels: TRIGGERS }, { number: 58, labels: TRIGGERS }] },
      claimThrows: "acme/finance#57",
    });
    await h.reconciler.run();

    ok("isolation: an admission that throws costs that issue its pass and nothing more", h.queued().join(",") === "acme/finance#58", `${h.queued().join(",")} claimed=${h.claimed.join(",")}`);
    ok(
      "isolation: and the failure is caught and named, rather than escaping the sweep entirely",
      h.lines.some((l) => l.level === "error" && l.message.includes("acme/finance#57") && l.message.includes("502")),
      JSON.stringify(h.lines.map((l) => `${l.level} ${l.message}`)),
    );
  }

  // ── and the two halves of a repo's pass are isolated from EACH OTHER. `gh pr list` and
  //    `gh issue list` are two calls to somebody else's service, and a backlog of issues
  //    abandoned because the pull request read 502'd is work nobody comes back for ──
  {
    const h = harness({
      issues: { "acme/finance": [{ number: 57, labels: TRIGGERS }] },
      prThrows: { "acme/finance": "gh pr list failed: HTTP 502" },
      prs: { "acme/ops": [{ number: 110, head: "feat/10", labels: [] }] },
      comments: { "acme/ops#110": [{ id: 1, body: "@sunday the naming here is off" }] },
    });
    await h.reconciler.run();

    ok("isolation: a pull request list that fails costs that half of that repo's pass and nothing else", h.queued().sort().join(",") === "acme/finance#57,acme/ops#pr110", `${h.queued().join(",")}`);
    ok("isolation: and it is named at error — a pull request half silently not re-derived looks exactly like a repo with no open ones", h.lines.some((l) => l.level === "error" && l.message.includes("acme/finance") && l.message.includes("502")), JSON.stringify(h.lines.map((l) => `${l.level} ${l.message}`)));
  }

  // ── the same, one level down: deciding ONE pull request reads two comment streams and
  //    then admission reads the pull request itself, all of it over the network ──
  {
    const h = harness({
      prs: {
        "acme/finance": [
          { number: 110, head: "feat/10", labels: [] },
          { number: 111, head: "feat/11", labels: [] },
        ],
      },
      comments: { "acme/finance#111": [{ id: 1, body: "@sunday the naming here is off" }] },
      commentsThrow: "acme/finance#110",
    });
    await h.reconciler.run();

    ok("isolation: a pull request whose thread cannot be read does not strand the ones behind it", h.queued().join(",") === "acme/finance#pr111", h.queued().join(","));
    ok("isolation: and it is named, since a summon nobody can read is a human still waiting", h.lines.some((l) => l.level === "error" && l.message.includes("acme/finance#pr110")), JSON.stringify(h.lines.map((l) => `${l.level} ${l.message}`)));
  }

  // ── one repo, on demand. A forwarder that was down for a single repo missed events for
  //    that repo alone: sweeping every routed repo to catch it up spends somebody else's
  //    rate limit on a gap they never had. The pass is the same one `run()` loops over —
  //    a second re-derive route is the drift this module exists to prevent (constraint 3) ──
  {
    const h = harness({
      issues: {
        "acme/finance": [{ number: 57, labels: TRIGGERS }],
        "acme/ops": [{ number: 12, labels: TRIGGERS }],
      },
    });
    await h.reconciler.repo("acme/finance");

    ok("one repo: the named repo is re-derived through the same admission the sweep uses", h.queued().join(",") === "acme/finance#57", `${h.queued().join(",")} claimed=${h.claimed.join(",")}`);
    ok("one repo: and the repos nobody asked about are left alone — their events were never missed", !h.queued().includes("acme/ops#12") && !said(h.lines, "acme/ops"), `${h.queued().join(",")} ${JSON.stringify(h.lines.map((l) => l.message))}`);
  }

  // ── and the isolation lives INSIDE that pass, so it holds for whoever calls it. The
  //    sweep has a caller above it; a blackout recovery does not — it runs off a timer in
  //    the parent, where a rejection nobody catches is an unhandled rejection that kills
  //    the process under `restart: always`, which is the crash loop ADR-0001 exists to stop ──
  {
    const h = harness({ throws: { "acme/finance": "gh issue list failed: HTTP 502" } });
    let escaped: unknown;
    await h.reconciler.repo("acme/finance").catch((err) => void (escaped = err));

    ok("one repo: a read that fails throws nothing at the caller — the recovery caller is a timer with nobody above it", escaped === undefined, String(escaped));
    ok("one repo: and the repo that failed is named at error, since a gap silently not re-derived looks exactly like no gap", h.lines.some((l) => l.level === "error" && l.message.includes("acme/finance") && l.message.includes("502")), JSON.stringify(h.lines.map((l) => `${l.level} ${l.message}`)));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
