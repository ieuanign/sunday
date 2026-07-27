// assignor/failure.mts — the failure taxonomy: what a failure IS, and how far it reaches.
//
// Ported from v1's `listener/classify.mts`, which gave every unrecognised failure a
// fail-safe GLOBAL halt — the defect ADR-0002 removes. Here each class carries a SCOPE
// instead of a severity-that-means-halt, and only `pipeline` stops everything.
//
// Pure: a string in, a `Failure` out. No clock, no I/O, no logger — so every class is
// drivable from a fixture, and the act layer (which pauses, retries, quarantines) is a
// separate thing that can be reasoned about on its own.
//
// It classifies TEXT because text is all the parent ever has: the agent seam flattens
// every library error to a plain `Error` whose message is preserved precisely so this can
// read it (`services/agent/claude.mts`), the image sweep reports a failed build as a
// `reason` string, and a dead child is an exit code the parent turns into a line.
//
// The quota/auth/transient patterns are PROVISIONAL. The real provider's error text is not
// known until the first live quota hit or 403, which is why an unrecognised failure still
// carries its raw excerpt into the durable log — that capture is what tightens these.
//
// The ACT layer (`FailurePolicy`, below) is the other half: what Sunday DOES about a
// failure of each scope. It is where the pause is armed, and it is reached from exactly
// three places (constraint 1) — `Assignor.record`, `boot.images()` and #43's restack lane.

import type { PauseState, PauseStore } from "./pause.mts";
import type { Scheduler } from "./scheduler.mts";
import type { StateStore } from "./state.mts";
import { AGENT_FAILED_LABEL, QUARANTINE_LABEL, type GitHubLabels } from "#services/github/index.mts";
import type { ModuleLogger } from "#services/logger.mts";
import type {
  ClassifyOptions,
  Failure,
  FailureClass,
  FailureInput,
  FailurePolicyDeps,
  FailureScope,
  RepoRecheck,
  RestartWorkItem,
  WorkItemRef,
} from "./types.mts";

/** Which class reaches how far (ADR-0002). `setup` is the one class whose scope is not
 *  fixed here — see `scopeOf`. */
const SCOPE: Record<FailureClass, FailureScope> = {
  quota: "pipeline",
  auth: "pipeline",
  setup: "repo",
  transient: "item",
  "run-failed": "item",
  unknown: "item",
};

/** The one setup failure that is NOT one repo's: no image anywhere can be built or run
 *  while the daemon is down, so this is the third thing allowed to stop the pipeline
 *  (constraint 4). */
const DAEMON_DOWN = /cannot connect to the docker daemon|is the docker daemon running|docker daemon is not running/;

/** The environment a run needs could not be produced: the image is missing or could not be
 *  created, or the daemon that would run it is not there. Deterministic breakage a retry
 *  cannot fix — a human (or the recheck rebuild) repairs it. A dead daemon is included
 *  rather than left to the caller's fallback, so it is recognised as setup wherever it
 *  surfaces; a build failure that says nothing recognisable is boot's `setup` fallback. */
const SETUP = new RegExp(`provider '[^']+' create failed|image '[^']+' not found locally|${DAEMON_DOWN.source}`);

/** A RELATIVE wait — `retry-after: N`, `retry after N seconds`, a bare `N seconds`. The
 *  discriminator against a quota's ABSOLUTE reset: conflating them either halts the
 *  pipeline on a 429 or retries one item into a wall the whole backlog then hits. */
const RETRY_AFTER = /retry[\s-]?after[^0-9]{0,10}\d+|\b\d+\s*seconds?\b/;

/** 5xx, network, and GitHub's own API failing under a `gh` call. The GraphQL 502 wrapper
 *  is named explicitly because it carries NO status code in its text (captured 2026-07-24,
 *  finance#57/#58, where it matched nothing and halted the pipeline). */
const TRANSIENT =
  /\b429\b|too many requests|rate.?limit|\b5\d\d\b|graphql: something went wrong|bad gateway|service unavailable|timeout|timed out|econnrefused|econnreset|etimedout|socket hang ?up|network|fetch failed|enotfound|eai_again/;

/** Words that NAME a credential without saying anything is wrong with one — `credentials.ts`
 *  in a merge conflict, a failing `authentication.test.ts`, a path under `oauth/`. They used
 *  to match BARE, and auth is `pipeline`: an item failure whose text merely mentioned a
 *  credential shredded the entire backlog (#39). No earlier pattern can fix that, because the
 *  incidental mention rides in on an item failure of ANY shape — so the gate belongs here. */
const CREDENTIAL = "credentials?|authentication|oauth";

/** The credential named as the broken thing: "invalid credentials", "bad credential". Read in
 *  EITHER order, so `expired oauth token` and `oauth token has expired` both land. */
const REFUSED = "invalid|expired|revoked|missing|bad";

/** …and the verdicts that only count AFTER it: "authentication failed", "credentials denied".
 *  Ahead of it they ARE the defect — "failed to read credentials.ts" is one item's problem. */
const REFUSED_AFTER = `${REFUSED}|failed|failure|error|denied|rejected|required`;

/** A credential is the process's, so a refused one fails every run identically — the second
 *  of the three failures allowed to stop the pipeline. `403`, `forbidden`, `unauthorized` and
 *  an `invalid api key` say that on their own; the ambiguous words must sit next to a word
 *  that says the credential was refused, with only a short filler between and never across a
 *  `.` or a `/` — which is what keeps a file path out and a real 403 in. Being too strict here
 *  is the worse failure: a wall that stops halting burns the whole backlog on the same 403. */
const AUTH = new RegExp(
  "\\b403\\b|forbidden|unauthorized|invalid api key|invalid.{0,12}token" +
    `|(?:${REFUSED})[^./\\n]{0,12}(?:${CREDENTIAL})` +
    `|(?:${CREDENTIAL})[^./\\n]{0,16}(?:${REFUSED_AFTER})`,
);

const EXCERPT_MAX = 2000;

/** Keep the TAIL — provider errors and a build's failing RUN line land at the end. */
function excerpt(text: string): string {
  return text.length > EXCERPT_MAX ? `…${text.slice(-EXCERPT_MAX)}` : text;
}

/** Absolute reset time → epoch ms, or undefined. ISO-8601 or a 10-digit unix epoch, BOTH
 *  anchored to a nearby reset/limit/quota mention. The anchor is not optional: unanchored,
 *  ANY timestamped error reads as a quota reset — a GitHub 502 whose text happens to carry
 *  `…on 2026-07-24T19:22:36Z` (captured 2026-07-24, finance#57/#58) then halts the pipeline
 *  until a reset that never existed. PROVISIONAL — relative durations ("resets in 2h") are
 *  deliberately NOT parsed (they would need a clock, and this is pure); they fall to the
 *  no-reset quota path, which waits for a human. */
function parseResetTime(text: string): number | undefined {
  const iso = text.match(
    /(?:reset|usage limit|quota)[^0-9]{0,40}(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/i,
  );
  if (iso) {
    const t = Date.parse(iso[1]);
    if (!Number.isNaN(t)) return t;
  }
  const epoch = text.match(/reset[^0-9]{0,24}(\d{10})\b/i);
  return epoch ? Number(epoch[1]) * 1000 : undefined;
}

/** How far a class reaches. Fixed per class except `setup`, which reads the text: one
 *  repo's image is that repo's problem, a dead daemon is everyone's. */
function scopeOf(cls: FailureClass, lower: string): FailureScope {
  return cls === "setup" && DAEMON_DOWN.test(lower) ? "pipeline" : SCOPE[cls];
}

/** Classify a failure's text into a class and a scope. Never throws. */
export function classify(text: string, options: ClassifyOptions = {}): Failure {
  const raw = excerpt(text);
  const lower = text.toLowerCase();

  if (options.agentFailed) {
    return { class: "run-failed", scope: SCOPE["run-failed"], summary: "the agent ran and reported a failure", excerpt: raw };
  }

  // Before auth: a create or pull failure can name registry credentials without the
  // provider API's credential being the problem, and one repo's stop must not become a
  // pipeline halt.
  if (SETUP.test(lower)) {
    return {
      class: "setup",
      scope: scopeOf("setup", lower),
      summary: DAEMON_DOWN.test(lower)
        ? "the container daemon is not running — no sandbox can be created"
        : "the sandbox image could not be built or created",
      excerpt: raw,
    };
  }

  // The branch is checked out in the PARENT repo, so the run cannot put its worktree on it
  // (git refuses the same branch twice). Captured 2026-07-25 (finance PR#61): a human's
  // hand checkout that moved away 44s later — a contention to wait out, and never the
  // fail-safe halt v1 fell through to. Ahead of auth for the same reason setup is: the
  // path in the message can name anything.
  if (/already checked out in worktree|used by worktree at/.test(lower)) {
    return {
      class: "transient",
      scope: SCOPE.transient,
      summary: "the branch is checked out in the parent worktree",
      excerpt: raw,
    };
  }

  // `gh pr create` against a base that no longer exists: a stacked base whose blocker
  // merged — and GitHub deleted the branch — WHILE this run was in flight (captured
  // 2026-07-25, finance#57). Self-healing: the next run's own `fetch -p` prunes the
  // dangling ref and re-derives the base. GitHub reports it as a cluster of blank-sha
  // noise; the discriminating clause is "Base ref must be a branch".
  if (/base ref must be a branch|head sha can't be blank/.test(lower)) {
    const base = text.match(/no commits between (\S+) and \S+/i)?.[1];
    return {
      class: "transient",
      scope: SCOPE.transient,
      summary: `the PR base ${base ? `${base} ` : ""}no longer exists (a stacked blocker merged mid-run)`,
      excerpt: raw,
    };
  }

  if (AUTH.test(lower)) {
    return { class: "auth", scope: SCOPE.auth, summary: "auth failure (403 / invalid credential)", excerpt: raw };
  }

  // A reset time present ⇒ quota (the pause can lift itself at reset + grace).
  const resetAt = parseResetTime(text);
  if (resetAt !== undefined) {
    return {
      class: "quota",
      scope: SCOPE.quota,
      summary: `quota exhausted — reset ${new Date(resetAt).toISOString()}`,
      excerpt: raw,
      resetAt,
    };
  }

  // A relative wait on a rate-limited call ⇒ the blip, checked BEFORE the quota keywords
  // below: "rate limit" appears in both, and only the shape of the wait tells them apart.
  if (RETRY_AFTER.test(lower) && /\b429\b|too many requests|rate.?limit|retry/.test(lower)) {
    return { class: "transient", scope: SCOPE.transient, summary: "rate-limited (429)", excerpt: raw };
  }

  // Quota worded without a time. Includes "rate limit" deliberately: a quota wall reported
  // in those words must stop the pipeline, or the whole backlog feeds into it.
  if (/quota|usage limit|limit reached|rate.?limit/.test(lower)) {
    return { class: "quota", scope: SCOPE.quota, summary: "quota exhausted — no reset time in the error", excerpt: raw };
  }

  if (TRANSIENT.test(lower)) {
    return { class: "transient", scope: SCOPE.transient, summary: "transient error (network / 5xx)", excerpt: raw };
  }

  const fallback = options.fallback ?? "unknown";
  return { class: fallback, scope: scopeOf(fallback, lower), summary: "unrecognised failure", excerpt: raw };
}

/** How long AFTER a quota's reset the pipeline starts spending again. The reset the
 *  provider names is the instant the window opens, and resuming exactly on it races a
 *  clock skew straight back into the wall — which re-arms the pause for another window. */
const RESUME_GRACE_MS = 60_000;

/** Node's `setTimeout` ceiling — 2^31-1 ms, ~24.8 days. A longer delay is not refused: it
 *  is silently CLAMPED to 1ms, and THAT silent clamp is the danger. A reset far enough out
 *  to overflow it would lift the pause almost immediately and feed the whole backlog back
 *  into the wall it is waiting on — a wrong answer rather than an error, which is the shape
 *  ADR-0002 exists to design out. It is not a hypothetical: the quota patterns above are
 *  PROVISIONAL until real provider text tightens them, so a mis-parse producing a nonsense
 *  far-future timestamp is likeliest right now. A reset no timer can hold therefore gets
 *  the same answer as a reset the provider never named — the pipeline waits for a human. */
const MAX_TIMER_MS = 2_147_483_647;

/** Does an incoming halt say anything the ARMED one does not? Compared on the only thing a
 *  halt decides — whether the pipeline lifts itself, and when — rather than on the reason
 *  text: three agents hitting the same wall a second apart word it identically, and an auth
 *  failure landing inside a quota window words it differently but must still get through.
 *
 *  So a halt supersedes when it takes the auto-resume AWAY (auth during a quota window: a
 *  credential does not fix itself when somebody's window closes) or pushes it LATER.
 *  Nothing supersedes a pause that already waits for a human — a quota window arriving on
 *  an armed auth halt would otherwise hand a broken credential a resume it never had, and
 *  the pipeline lifts itself into the 403 and fails every queued item. */
function supersedes(resumeAt: number | undefined, armed: PauseState): boolean {
  if (armed.resumeAt === undefined) return false;
  return resumeAt === undefined || resumeAt > armed.resumeAt;
}

/** The classes that get the one retry. `run-failed` is deliberately not among them — the
 *  agent RAN and reported its own verdict, so a second run would spend real quota
 *  re-deciding what it already decided — and neither is anything that reaches further
 *  than one item. */
const RETRYABLE: readonly FailureClass[] = ["transient", "unknown"];

/** How long a stopped repo waits before its image is tried again. Long, because the fix
 *  is a human editing a Dockerfile or starting the daemon, and each attempt is a real
 *  docker build — but not so long that a repo repaired in a minute sits idle for an hour. */
const RECHECK_MS = 300_000;

/** What Sunday DOES about a failure. One entry — `failed()` — which classifies, and then
 *  acts as far as the scope reaches and no further: a `pipeline` failure stops everything,
 *  and nothing else does (ADR-0002).
 *
 *  It NEVER throws (constraint 9). It sits on every failure path and is reached from
 *  timers with nobody above them, so a throw here turns a handled failure into a dead work
 *  item or an unhandled rejection that takes the parent down under `restart: always`
 *  (ADR-0001). Durable state — the pause file — is what actually stops the pipeline. */
export class FailurePolicy {
  // Declared, not parameter properties: Node runs `.mts` in strip-only mode, which
  // rejects `constructor(private x)`.
  private readonly pause: PauseStore;
  private readonly scheduler: Scheduler;
  private readonly state: StateStore;
  private readonly github: GitHubLabels;
  private readonly log: ModuleLogger;
  private readonly resumeGrace: number;
  private readonly recheck?: RepoRecheck;
  /** The repos nothing may start in. IN MEMORY, unlike the pause and the quarantine: a
   *  stop is a statement about an IMAGE, and the first thing the next parent does is build
   *  every routed repo's image (`boot.mts`) — which re-derives this set from the world
   *  rather than trusting a file that could disagree with what docker now says. */
  private readonly stopped = new Set<string>();

  constructor(deps: FailurePolicyDeps) {
    this.pause = deps.pause;
    this.scheduler = deps.scheduler;
    this.state = deps.state;
    this.github = deps.github;
    this.log = deps.log;
    this.resumeGrace = deps.resumeGraceMs ?? RESUME_GRACE_MS;
    this.recheck = deps.recheck;
  }

  /** Is this repo's environment broken? Read by admission (`assignor/index.mts`), which
   *  is what makes the stop mean anything: an issue admitted into a repo whose image will
   *  not build is a whole agent run that dies on the same create failure, and on a busy
   *  repo that is the entire backlog, one item at a time. */
  isStopped(repo: string): boolean {
    return this.stopped.has(repo);
  }

  /** Classify a failure and act on it. The one entry point. */
  failed(input: FailureInput): void {
    this.guard(`the failure policy could not act on ${input.item?.key ?? input.repo}`, () => {
      const failure = classify(input.text, { fallback: input.fallback, agentFailed: input.agentFailed });
      if (failure.scope === "pipeline") {
        this.halt(failure);
        return;
      }
      if (failure.scope === "repo") {
        this.stop(failure, input.repo);
        return;
      }
      if (failure.scope === "item" && input.item) {
        this.item(failure, input.item, input.retry);
        return;
      }
      // An item-scope failure with no work item to act on — boot's image sweep has no work
      // item at all, and #43's restack lane may not either. Recorded, and the rest of the
      // pipeline carries on. `info`, because the failure's own text is on the milestone the
      // caller already posted (constraint 6) and there is nothing here for a human to do.
      this.log.info(`· ${failure.class} (item) ${input.repo} — ${failure.summary}`, { repo: input.repo });
    });
  }

  /** Stop ONE child repo: its environment cannot be produced, so every run in it would die
   *  the same way — and every run in every OTHER repo is fine. v1 read exactly this create
   *  failure as unrecognised and stopped the whole pipeline for it, which is the defect
   *  ADR-0002 removes.
   *
   *  Nothing durable is written and no work item is touched: the items that died on the
   *  broken image are already `failed`, which is the state the re-derive below picks back
   *  up. The stop is the ADMISSION guard and nothing more.
   *
   *  Constraint 5: the repo and NO target. One broken image is not the fault of whichever
   *  issue happened to find it first, and it must not comment on that issue's thread.
   *  `error` the first time — a broken environment is something a human goes and fixes —
   *  and `info` for every failure after it, so a repo's in-flight items landing one after
   *  another cannot page anybody once per item for a single break. */
  private stop(failure: Failure, repo: string): void {
    if (this.stopped.has(repo)) {
      this.log.info(`· ${repo} is already stopped — ${failure.summary}`, { repo });
      return;
    }
    this.stopped.add(repo);
    this.log.error(
      `⏸ ${repo} stopped — ${failure.summary}. Every other repo keeps running` +
        `${this.recheck ? ", and this one resumes as soon as its image builds again" : " — a restart is what picks it back up"}`,
      { repo },
    );
    this.scheduleRecheck(repo);
  }

  /** Try the repo again on a timer. The alternative is a human remembering to tell Sunday
   *  they fixed it, which is v1's halt with an extra step: the repair (a Dockerfile edit, a
   *  daemon started) is invisible from here, and a clean build is the one honest signal
   *  that it landed. */
  private scheduleRecheck(repo: string): void {
    if (!this.recheck) return;
    setTimeout(() => void this.rebuild(repo), this.recheck.everyMs ?? RECHECK_MS);
  }

  /** One recheck. Async and reached from a timer with nobody above it, so it swallows
   *  everything (constraint 9): a rejection here is an unhandled one, and under
   *  `restart: always` that takes the whole parent down over one repo's image. */
  private async rebuild(repo: string): Promise<void> {
    if (!this.stopped.has(repo) || !this.recheck) return;
    let broken: string | undefined;
    try {
      broken = await this.recheck.rebuild(repo);
    } catch (err) {
      broken = err instanceof Error ? err.message : String(err);
    }
    if (broken !== undefined) {
      // `info`: the stop was said at `error` when it happened, and a repo waiting on a
      // human is not news once a minute.
      this.log.info(`· ${repo} is still stopped — ${broken}`, { repo });
      this.scheduleRecheck(repo);
      return;
    }
    // Cleared BEFORE the re-derive, and that order is the whole self-heal: reconcile hands
    // every open issue straight back to admission, where the guard this clears would
    // otherwise skip every one of them.
    this.stopped.delete(repo);
    // `info`, exactly as the pipeline's own auto-resume is said: what a human acts on is a
    // thing being broken, and this is the mechanism reporting that it no longer is.
    this.log.info(`▶ ${repo} resumed — its sandbox image builds again`, { repo });
    try {
      // The items that died on the broken image are `failed`, which is exactly what a
      // re-derive re-admits — so the repair needs no bookkeeping of its own.
      await this.recheck.reconcile(repo);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.log.error(`✗ ${repo} resumed, and its outstanding work was not re-derived — ${why}`, { repo });
    }
  }

  /** Stop ONE work item, and only it — the change ADR-0002 is about. The ladder is a rung
   *  long so far: an item whose retry is unspent is started again, carrying its own error
   *  when it has one worth reading.
   *
   *  The budget is written BEFORE the restart, and durably: a parent killed between the
   *  two leaves an item that has already spent its retry, which is the safe way round —
   *  the other order retries forever on real quota. */
  private item(failure: Failure, item: WorkItemRef, retry?: RestartWorkItem): void {
    const about = { repo: item.repo, target: item.issue };
    // The agent ran and reported its own defeat: marked for a human to triage, and that is
    // all. Retrying it would spend a whole agent run re-deciding what it already decided,
    // and setting it aside would be Sunday quarantining an ISSUE that is simply hard.
    if (failure.class === "run-failed") {
      this.label(item, AGENT_FAILED_LABEL);
      this.log.info(`· ${failure.class} (item) ${item.key} — ${failure.summary}`, about);
      return;
    }
    const prior = this.state.get(item.key);
    if (retry && prior?.retried !== true && RETRYABLE.includes(failure.class)) {
      this.state.set(item.key, { ...(prior ?? { status: "failed" }), retried: true });
      // `unknown` hands its own error back — the ONE thing a fresh run would not know, and
      // the whole reason a second one is worth the quota. `transient` hands back nothing:
      // the blip was not the agent's fault, and somebody else's 502 in the prompt is noise.
      retry(failure.class === "unknown" ? failure.excerpt : undefined);
      // `info`: the failure's own text is on the outcome milestone the caller already
      // posted (constraint 6), and a retry is the mechanism working rather than something
      // a human has to act on.
      this.log.info(`↻ retry ${item.key} — ${failure.summary}`, about);
      return;
    }
    // The retry is spent and it failed the same way. An `unknown` twice over is an item
    // nothing here knows how to fix, so it is set aside rather than run a third time.
    if (failure.class === "unknown") {
      this.quarantine(item, failure);
      return;
    }
    this.log.info(`· ${failure.class} (item) ${item.key} — ${failure.summary}`, about);
  }

  /** Set one work item aside. DURABLE and distinct from `failed` (constraint 7): a failed
   *  item is exactly what the next reconcile re-admits, and an item that cannot succeed
   *  would loop through its retry on real quota for as long as anything kept re-admitting
   *  it — which is the defect ADR-0002 replaces the global halt with.
   *
   *  Written OVER the `failed` the caller's own record just wrote: one redundant write on
   *  the rare quarantine path buys an untouched apply ordering, and it is self-correcting
   *  — a parent killed between the two leaves the item `failed` with its retry spent, and
   *  its next failure quarantines it. */
  private quarantine(item: WorkItemRef, failure: Failure): void {
    const prior = this.state.get(item.key);
    this.state.set(item.key, { ...(prior ?? {}), status: "quarantined" });
    this.label(item, QUARANTINE_LABEL);
    // `error` is the priority channel (`services/logger.mts` ROUTES): it reaches the phone
    // AND the issue, which is what makes this line both the P1 notification ADR-0002 asks
    // for and the release instruction — a set-aside item nobody can find is a lost one.
    // The ONE comment this failure gets (constraint 6): the error's own text is already on
    // the outcome milestone, and this says what Sunday has done about it.
    this.log.error(
      `⏸ quarantined ${item.key} — ${failure.summary}, twice. Everything else keeps running. ` +
        `To hand it back: remove the \`${QUARANTINE_LABEL}\` label and re-add the trigger label.`,
      { repo: item.repo, target: item.issue },
    );
  }

  /** Mark the issue — or the PULL REQUEST, which is a different `gh` call and not a
   *  detail (#44 constraint 11): `gh issue edit <n>` against a comment run's number marks
   *  whatever issue happens to be numbered `n`, which is somebody else's work item wearing
   *  a quarantine nobody can explain.
   *
   *  BEST-EFFORT, always (constraint 9): durable state is what actually stops the item
   *  being re-admitted, so a label write that fails must not take the policy down with it
   *  — and the most likely failure is a repo onboarded before this label existed, which is
   *  a one-line fix worth naming.
   *
   *  Said with the repo and NO target, so it reaches whoever can fix that and never the
   *  issue thread: the acted-on failure has had its one comment already (constraint 6). */
  private label(item: WorkItemRef, name: string): void {
    const write =
      item.kind === "pr"
        ? this.github.labelPr(item.repo, item.issue, [name])
        : this.github.addLabels(item.repo, item.issue, [name]);
    void write.catch((err: unknown) => {
      const why = err instanceof Error ? err.message : String(err);
      this.log.error(`✗ ${item.key} could not be labelled ${name} — ${why} (gh label create ${name} --repo ${item.repo})`, {
        repo: item.repo,
      });
    });
  }

  /** Stop EVERYTHING: only `quota`, `auth` and a dead container daemon reach here
   *  (constraint 4).
   *
   *  The queue first, the file second. The scheduler's flag is in-memory and cannot fail,
   *  so pausing first means the wall is respected from this instant even if the disk write
   *  is what breaks — and the file is what makes the pause survive the restart that would
   *  otherwise spend the quota it is waiting on (`assignor/pause.mts`). */
  private halt(failure: Failure): void {
    const reset = failure.resetAt === undefined ? undefined : failure.resetAt + this.resumeGrace;
    // A reset no timer can hold is dropped HERE, before anything is armed, rather than
    // where the timer is set (see MAX_TIMER_MS): the pause file, the dedup below, the line
    // this logs and the next boot's re-arm (`boot.mts`, which re-schedules whatever
    // `resumeAt` it finds) must all agree that this one waits for a human — an armed
    // `resumeAt` nothing can fire is the same lie written down.
    const resumeAt = reset !== undefined && reset - Date.now() <= MAX_TIMER_MS ? reset : undefined;
    // Deduplicated for the same reason a repo stop is, and harder: the wall is
    // PROCESS-WIDE, so every agent in flight hits it within seconds of the first and each
    // failed outcome reaches here on its own. `alert`/`error` route to the phone with no
    // debounce of their own (`services/destinations.mts`), so an unguarded second halt
    // pages a human once per in-flight item for ONE event — and re-arms the file under the
    // auto-resume timer that is matched against exactly what it replaced.
    // Read only when the pipeline is ALREADY held: an unreadable pause file then throws
    // into `failed()`'s guard, which is safe here because the thing this halt would do —
    // stop the pipeline — is already true. Nothing is read on the path that arms it.
    if (this.scheduler.isPaused()) {
      const held = this.pause.read();
      if (held && !supersedes(resumeAt, held)) {
        this.log.info(`· the pipeline is already halted (${held.reason}) — ${failure.summary}`);
        return;
      }
    }
    this.scheduler.pause(failure.summary);
    const armed: PauseState = { reason: failure.summary, since: Date.now(), resumeAt };
    this.pause.write(armed);
    // What Sunday is DOING about it — the failure's own text is already on the work item's
    // outcome milestone (constraint 6), and this line is the one that pages a human.
    // NO repo and NO target (constraint 5): a halt has no business commenting on whichever
    // work item happened to be the one that hit the wall, and the next hundred would each
    // carry the same comment. `services/logger.mts` needs both to address an issue, so
    // carrying neither is the whole mechanism.
    // `alert` for a quota and `error` for everything else that gets here: they reach the
    // same sinks, and what differs is what the durable event says happened — a quota wall
    // is Sunday waiting out somebody else's window, an auth failure (or a dead daemon) is
    // something broken that a human has to go and fix.
    const line = `⏸ pipeline halted — ${failure.summary}${
      resumeAt !== undefined
        ? `, resuming ${new Date(resumeAt).toISOString()}`
        : `${reset === undefined ? "" : " — that reset is further out than a timer can hold"} — awaiting a human resume`
    }`;
    if (failure.class === "quota") this.log.alert(line);
    else this.log.error(line);
    if (resumeAt !== undefined) this.scheduleResume(armed, resumeAt);
  }

  /** Lift the pause when the window closes. A quota wall is the one failure with a KNOWN
   *  end, and without this the pipeline waits for a human to notice a window that expired
   *  hours ago — which is v1's halt wearing a timestamp.
   *
   *  It re-reads the file and lifts only the pause it armed ITSELF: a LATER one (an auth
   *  halt armed while this window ran) is not this timer's to lift, and resuming into a
   *  credential that is still broken fails every queued item instantly. Matched on the
   *  whole record rather than on `since` alone, because two failures landing in the same
   *  millisecond is exactly how the auth halt gets lifted by somebody else's window.
   *
   *  Boot owns the OTHER half of this: a pause left armed by a parent that died is
   *  re-armed and re-scheduled from the file (`boot.mts` `rearm`), because this timer died
   *  with the process that set it. */
  private scheduleResume(armed: PauseState, resumeAt: number): void {
    setTimeout(
      () =>
        this.guard(`the ${armed.reason} pause could not be lifted`, () => {
          const found = this.pause.read();
          if (found?.since !== armed.since || found.reason !== armed.reason) {
            this.log.info(`· the ${armed.reason} window closed, and a later pause is holding the pipeline`);
            return;
          }
          this.pause.clear();
          this.scheduler.resume();
          this.log.info(`▶ pipeline resumed — the window closed (${armed.reason})`);
        }),
      Math.max(0, resumeAt - Date.now()),
    );
  }

  /** Every entry this class has, wrapped (constraint 9): `failed()` is on every failure
   *  path, and the auto-resume fires from a timer with no caller at all. */
  private guard(what: string, act: () => void): void {
    try {
      act();
    } catch (err) {
      this.log.error(`✗ ${what} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
