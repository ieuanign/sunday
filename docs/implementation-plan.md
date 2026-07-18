# Implementation plan — the Sunday pipeline

> **Status: build-ready plan (design phase).** This is the ordered, dependency-aware build
> sequence for the pipeline, synthesised from a resolved design + a verified spike. It is the
> hand-off to the execution build; nothing here is built yet. It is deliberately **generic** —
> concrete per-child specifics (image recipe, service wiring) live in each child's own
> `.sandcastle/` and are not part of this template.

## What this builds

A local, event-driven pipeline that turns labelled GitHub issues into autonomous,
sandbox-isolated implementations that open PRs, running on your own hardware. The shape is
already designed in [`architecture.md`](architecture.md); this plan **orders the build** and
folds in the decisions taken since that document was written.

```
GitHub issue (labelled) → gh webhook forward → listener (TS) → sandcastle.run({cwd: repos/<child>})
  → Docker sandbox (headless agent, credential-free) → TS pushes + opens PR to the child's origin
```

## Load-bearing decisions this plan assumes (resolved)

All resolved on the wayfinder map; detail in each source. The build does **not** re-open these.

- **Engine:** Sandcastle is primary, **pinned exactly to `0.12.0`** (early 0.x — re-vet on any
  bump). A personal "sandcastle-like" reimplementation is a *secondary learning track*, out of
  scope here.
- **Spike verdict — GO.** Git isolation to the child's origin, non-`main` base stacking, and
  session resume are all verified. Crucially: **Sandcastle never pushes or opens PRs** — it runs
  the agent and merges commits onto a host branch; the **host (TS) owns push, PR, labels, and
  comments**. The sandbox is **credential-free** (no `gh`, no token). (`.scratch/spike/FINDINGS.md`)
- **Sandcastle API shape:** `run()` needs an explicit, **already-built** `imageName` and an
  **absolute** `promptFile` (it does *not* auto-read `cwd/.sandcastle`); `branchStrategy:{type:
  "branch", branch, baseBranch}` gives the stacking primitive; `resumeSession` gives the gate;
  `CLAUDE_CODE_OAUTH_TOKEN` is passed via `.sandcastle/.env`. (`.scratch/wayfinder/findings-issue2-sandcastle-api.md`)
- **Judgment vs mechanics (security + token boundary):** the agent emits decisions/text; the
  **TS does ALL I/O**. TS fetches issue/comments/diff and injects them, then posts comments,
  opens PRs, applies labels, pushes, and **drives the rebase** (an agent is summoned *only* on a
  genuine source conflict; regenerable artifacts — lockfiles, `go.sum` — are regenerated, never
  agent-merged). The boundary is *physically enforced* by the credential-free sandbox.
- **Auth / risk:** full automation on the Max/OAuth token (native headless `claude`), **$0**
  marginal. Residual risk is *scale* — mitigated by the operability layer. (`findings-tos-oauth-automation.md`)
- **Operability:** failure taxonomy + quota pause/resume + a bidirectional Telegram
  notifier/control channel. (`.scratch/wayfinder/findings-issue8-operability.md`)
- **Resource management:** per-phase effort/model matrix, ctx-threshold handoff, and a
  cost-weighted (no-USD) token report. (`.scratch/wayfinder/spec-issue11-resource-mgmt.md`)
- **Reference child:** already onboarded and proven (DB-layer tests green in-sandbox). The
  onboarding recipe is **private** (`.scratch/`); this plan references it, never inlines it.

## Binding conventions for the build

- **`$0` by default (hard rule).** Max token (paid already), Docker (free), Cloudflare Tunnel
  (free tier). Any paid path — `ANTHROPIC_API_KEY`, n8n Cloud, a paid tunnel tier — is **flagged
  and needs explicit approval first**.
- **Public/generic.** No reference-child name or config in this repo. Child specifics stay in
  `.scratch/` (private) and in the child's own `.sandcastle/`.
- **Personal account** → per-repo templated `--repo` webhook forwarders. The org `--org` path is
  out of scope.
- **Trigger label (reconciled — see doc corrections): `ready-for-agent` + `auto-dev`** (AND),
  fired on the second label. The plural `ready-for-agents` is retired.
- **In-sandbox discipline** is [`sandbox-prompt.md`](sandbox-prompt.md): plan → test-first
  implement → review → debug-on-red → sign-off, agent **commits locally**; the host does the rest.

---

## Build sequence

Ordered walking-skeleton-first: prove one issue end-to-end by hand, then thicken. Each milestone
lists its steps and a **verify** gate before the next begins.

### M1 — Walking skeleton: one issue, end-to-end, manually invoked

Goal: a single hand-run proves the whole vertical (sandbox → commit → TS push → PR) on the
already-onboarded reference child. No webhook, no loop, no operability yet.

1. **Install + pin.** `@ai-hero/sandcastle@0.12.0` (exact, not `^`) as a devDependency of the
   parent workspace. `devbox.json` already provisions node/gh/git; Docker daemon is a host install.
2. **Scaffold the parent workspace:** `listener/`, `config/`, `repos/` (gitignored), `.scratch/`
   (gitignored), and `.env` from `.env.example`.
3. **Build the per-child image.** From the child's own `.sandcastle/Dockerfile`, run
   `sandcastle docker build-image` (it aligns the `agent` user to host UID/GID). The image needs
   `agent` at host UID/GID, `/home/agent`, `ENTRYPOINT ["sleep","infinity"]`, and on Docker
   Desktop `--provenance=false`. (Recipe: the private onboarding guide.)
4. **Minimal one-shot TS wrapper** (`listener/`, invoked by hand with `<repo> <issue#>`): TS
   `gh`-fetches the issue text, composes the prompt (`sandbox-prompt.md` baseline + issue), then
   `run({ agent: claudeCode(MODEL), sandbox: docker({ imageName }), cwd: "repos/<child>",
   promptFile: <ABSOLUTE path>, branchStrategy: { type:"branch", branch:"feat/<issue>",
   baseBranch:"main" } })`. On return, **TS** does `git -C repos/<child> push origin <branch>`
   then `gh pr create`. (Single default `MODEL`/`MODEL_EFFORT` from `.env` for now — the per-phase
   matrix arrives in M5.)

**Verify M1:** hand-run against one real reference-child issue → sandbox tests green, a branch
pushed to the child's origin, a PR opened. Parent workspace git untouched. This retires the
integration risk before any machinery is added.

### M2 — Event loop + orchestration (the listener)

Goal: labelling an issue drives it automatically, with concurrency, state, the gate, and stacking.

1. **`config/` routing schema:** `repository.full_name → { path, imageName, promptFile, labels }`.
2. **`gh webhook forward`** per-repo (`--repo`, personal account) subscribing `issues`,
   `issue_comment`, `pull_request`, delivered to a **local** `node:http` receiver on
   `LISTENER_PORT` (`--url http://localhost:<port>/`) — **no public endpoint** (gh dials out to
   GitHub's relay). Requires the experimental **`cli/gh-webhook`** extension (gh ships no built-in
   `webhook` command). Webhook secret (HMAC) in `.env`. No replay → reconcile compensates.
   **Fallback if forwarding proves flaky: poll GitHub** on a timer (same query as reconcile; the
   admission logic is identical either way). *(gh-webhook evaluated live and chosen — good latency,
   all event types flowing — 2026-07-18; polling held in reserve.)*
3. **Shared run action (`runIssue`):** extract M1's compose→run→push→PR into a single module both
   the one-shot CLI wrapper (`run-one.mts`) and the listener call — given a `RepoConfig` + issue#,
   it composes the prompt, `run()`s the sandbox, and (on commits) pushes + opens the PR. This is
   the one place the per-issue action lives; the CLI and the listener must not drift.
4. **The listener process** — a single async **serializing loop**: admission (trigger
   `ready-for-agent` + `auto-dev`; **skip any `spec`-labelled issue** — a spec is a manifest, never
   implemented; post a one-line nudge "label the tickets"), **double-launch guard**
   (`agent-working` claim label + in-flight set), **global concurrency cap** (`MAX_CONCURRENCY`,
   default 3 — one shared quota), and `.scratch` **JSON state** (in-flight / `session_id` /
   branch / last-seen comment id, keyed by `(repo, issue#)`, temp-then-rename). **Single active
   instance** across ALL machines — the in-flight set is per-process and the `agent-working` label
   is only best-effort cross-instance (no atomic label CAS); run exactly one active listener, a
   second machine is a cold standby (see Accepted risks).
5. **Human gate + the signal contract:** the agent emits ONE structured result via Sandcastle
   `Output.object` — `<sunday-result>{ signal:"ready"|"draft"|"gate"|"fail", summary, question? }`
   (requires `maxIterations===1`); `runIssue` reads `result.output` and branches: ready → PR ·
   draft → draft PR · **gate → no PR, post `question` + `awaiting-human`, keep `session_id`** ·
   fail → WIP + draft PR + `agent-failed`. Replaces the crude `commits.length` check. The gate
   round-trip: an `issue_comment` reply on an `awaiting-human` issue → TS `run({ resumeSession })`
   with the comment → clears `awaiting-human`. (TS posts every comment + applies every label — see
   doc corrections.)
6. **Dependency DAG + stacking (ticket-as-unit "waves"):** the **ticket** is the unit — Sunday
   admits any ticket whose blockers are satisfied; waves emerge from each ticket's own blocking
   edges (native sub-issue/blocking links, or a "Blocked by" text fallback), **not** from reading a
   spec. `runIssue` gains a **`baseBranch` param** (default `main`; a stacked ticket bases on its
   blocker's branch) — the knob that turns waves on. *A* starts once blocker *B*'s draft PR is open,
   branches from *B*'s head, PR targets *B*'s branch. **On *B* merge, TS drives** `git rebase --onto
   main <B-ref> A`, retargets *A*'s PR base to `main`, cascades up — summoning an agent **only** on a
   genuine source conflict (bounded 2 attempts, then the gate). Rebase-only, never merge.
   **Undeclared file overlap** between concurrent tickets is **not** pre-checked (Sunday has no
   upfront plan/touchpoints, unlike dev-loop's Gate 1) — a real collision falls to the same
   agent-rebase path; `MAX_CONCURRENCY` is the lever. *(Deferred convenience: `auto-dev` on a spec
   bulk-labels its unblocked child tickets — pure labelling, execution stays ticket-as-unit.)*
7. **Reconcile-on-restart:** re-derive all pending work from GitHub (new issues, missed gate
   replies, missed PR-merge restacks, orphaned `agent-working`). GitHub is the truth → an outage
   is a delay, not a loss. The `.scratch` state is the "save data" — it carries the `session_id`
   that lets a run **resume** rather than restart; lose it and work is still re-derived from GitHub,
   but in-flight sessions restart from scratch.

**Verify M2:** label a real issue → automatic end-to-end run; a gate round-trip resumes; a
stacked pair opens correctly; merging *B* restacks *A*.

### M3 — Operability (failure taxonomy, quota resume, Telegram)

Draws entirely on `findings-issue8-operability.md`.

1. **Signal taxonomy** off `RunResult` (throw vs `completionSignal` vs `stdout` stream-json
   `result` subtype vs `preservedWorktreePath`), not raw exit codes.
2. **Classify + act oppositely:** quota (5-hr reset) → pause, resume at **reset + 5 min**; no
   parseable timestamp → persist resume state + notify + `awaiting-human`. **403** → abort
   in-flight + halt + notify (human re-auths; reconcile re-admits). **429/network/5xx** → bounded
   backoff. Run-level failures → existing `agent-failed` draft-PR path.
3. **Notifier floor:** every P1/P2/P3 → terse **Telegram** + full **`.scratch/operability/events.jsonl`**
   (Sentry-style; written first, synchronously). Issue-homed events also comment + label.
4. **Bidirectional control:** same bot, registered commands (`/pause`, `/resume`, `/resume-at`,
   `/status`, `/agent`, …) via **webhook**; `$0` public endpoint via **Cloudflare Tunnel**; authz =
   `secret_token` header **+ `chat_id` allowlist**.
5. `.env` keys: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`,
   `TELEGRAM_WEBHOOK_URL`. New infra dep: `cloudflared` (free tier — cost-flagged).
6. **Concurrent-flow observability:** the root fix is **per-flow log separation** — each `runIssue`
   streams to `.scratch/<repo>/<issue>/run.log`; the listener stdout drops to terse one-line-per-
   event summaries (feasible as early as M2). Viewer: ship the **cheap `sunday status` + `tail -f`**
   first; a bespoke `ink` `sunday watch` TUI (FleetView-style select) is **deferred** until
   concurrency climbs past ~3.

**Verify M3:** each failure class routes correctly (capture the raw stdout excerpt + result
`subtype` on the first real quota hit / 403 / context-limit / refusal and tighten parsers); a
Telegram command round-trips.

### M4 — Supervision

Preferred shape: a **Docker Compose "Sunday orchestration stack"** (mirrors the existing
`liddlemise-prod` ops model) — a `listener` service + a **templated per-repo** `webhook-forward`
service (`--url http://listener:<port>/` over the compose network, `GH_TOKEN` injected).

1. **Two hard constraints.** (a) The **listener is a singleton** — its serializing loop + the
   double-launch guard assume one process, so **never scale it to replicas** (two would
   double-admit the same issue; unlike stateless `backend-1/backend-2`). (b) **Docker-out-of-Docker**
   — a containerized listener spawns sandcastle sandboxes, so it needs the host docker socket
   mounted **and** `repos/` mapped to its host path (sandcastle bind-mounts resolve against the host
   daemon, not the container). The ephemeral sandboxes are **not** compose services.
2. **Alternatives:** **systemd** units on the Linux reference host, or **launchd/foreground** on
   macOS for development.

**Verify M4:** kill the listener → supervisor restarts it → reconcile recovers all pending work.

### M5 — Resource management + onboarding polish

Layered last: the pipeline works; now tune cost and smooth onboarding. Per #11, the matrix's
numbers are **tuned from real production data**, so this deliberately follows M1–M4.

1. **Per-phase matrix + Sunday's discipline** (`config/roster.*`): the listener generates injected
   `.claude/agents/<phase>.md` (model + effort) per run; `.env` `MODEL`/`MODEL_EFFORT` is the
   global fallback. Starting values: Plan opus/max · Implement opus/xhigh · Review sonnet/high ·
   Debug opus/xhigh · Sign-off sonnet/medium (model switching is `$0` on the Max token). The same
   injection carries **Sunday's default discipline as a FLOOR** — the full roster (`code-writer`→
   `/tdd`, `reviewer`→`/code-review-mp`, `debugger`→`/diagnosing-bugs`, + `architecture-engineer`),
   each phase a **fresh context** (keeps every phase under the "smart zone" threshold). **Precedence
   by presence:** a child's own *present* setup overrides the floor (likely via native project>user
   precedence — inject at the sandbox's user level); a bare child gets Sunday's default. **B1 — the
   sandbox agent self-orchestrates** the sequential phases (1 container; work stays fresh;
   orchestrator growth caught by the §2 handoff). Escalate to host-driven phases only if the token
   report shows the orchestrator itself hitting the threshold.
2. **Handoff-at-threshold:** TS reads the orchestrator session's `ctx = input + cacheRead +
   cacheCreation` at **resume points** — `<120K` → `run({resumeSession})`; `≥120K` → an
   **agent-written** handoff doc (bounded resume-one-turn → `.scratch/<repo>/handoff/<issue>-<n>.md`)
   → fresh `run()`. On summarize-turn error → notify (M3) + halt. Clean up handoff files on
   terminal push. Redirect the handoff skill's OS-temp write to `.scratch/<repo>/handoff/`.
3. **Cost-weighted token report** (free, host-side on run completion): per-phase raw 4 fields +
   `ctxTokens` + `cacheHitRatio` + flags; one normalized weighted **sort key**
   (`input×1 + cacheCreation×1.25 + cacheRead×0.1 + output×5`); **no USD**. Store
   `.scratch/<repo>/token-report/<run-id>.{json,md}` + `history.jsonl`; notifier gets the headline.
   ⚠️ **Per-phase attribution is unverified** — `iterations[]` are the orchestrator's turns, not
   sub-agents; parse `sessionFilePath` JSONL to attribute by phase, and **verify granularity on
   the first real run** (the "~5× per phase" figure is an assumption).
4. **Onboarding:** the reference child is already onboarded (private guide). Automating future
   onboarding (`npm run repo:init <git-url>` wrapping `sandcastle init` + `gen-workspace` + config +
   labels) is tracked separately as the onboard-a-child tool.

**Verify M5:** a run emits per-phase model/effort from the matrix; a forced ≥120K session hands
off cleanly; a token report lands with correct per-phase attribution (or the fallback + the flag).

---

## Canonical-doc corrections this plan makes

The following were written under a superseded design and are corrected as part of this plan:

- **`architecture.md` — the rebase actor.** "an agent runs `git rebase --onto main <B-ref> A`" →
  the rebase is **TS mechanics**; an agent is summoned only on a genuine source conflict.
- **`architecture.md` — trigger label.** `ready-for-agents` (plural) → **`ready-for-agent`**
  (singular), unified with the triage canonical set to kill the one-letter collision. The
  reference child's config + existing label migrate to the singular.
- **`sandbox-prompt.md` — I/O ownership (§4/§5, and consistently §2.6/§6/§7/intro).** The sandbox
  is **credential-free**: the agent **commits locally and emits a structured result**; the **host
  pushes, opens the PR, posts comments, and applies labels**. "Push to origin" / "open the PR" /
  "post a comment + apply the label" as *agent* actions are removed. The agent→TS contract is now
  **resolved** (grill 2026-07-18, `.scratch/wayfinder/findings-grill-m2m5-2026-07-18.md`): §4 emits
  `<sunday-result>{signal,summary,question?}` via `Output.object` — see M2 step 5.
- **`sandbox-prompt.md` §1/§2 — discipline is Sunday's floor.** The repo binds the WHAT (its
  `CLAUDE.md`/ADRs/domain — conventions); Sunday injects the HOW (the roster + `/tdd` ·
  `/code-review-mp` · `/diagnosing-bugs`) as the default, overridden by a child's own *present*
  setup — see M5.1. (Grill 2026-07-18.)

## Resolved open questions (from `architecture.md`)

1. **Forwarding shape** → personal account, per-repo `--repo` forwarders.
2. **Per-child `.sandcastle` resolution** → `run()` does not auto-read it; pass explicit
   `promptFile` (absolute) + a pre-built `imageName`.
3. **Child service wiring** (e.g. a test DB) → child-specific; booted as a per-run sidecar per the
   private onboarding recipe, reached via the child's own config.

## Accepted risks

- **Quota ceiling** — ~5 agents/issue × cap 3 on one shared plan; levers: lower the cap, thin the
  roster (tuned from the M5 report).
- **Ready stacked PRs on unreviewed bases.**
- **Sandcastle is early / solo-maintained** — pinned exactly; re-vet on upgrade.
- **`gh webhook forward` has no replay** — reconcile compensates.
- **Single active instance** — the listener is a singleton across ALL machines; the `agent-working`
  label is best-effort cross-instance protection, not a distributed lock (GitHub has no atomic label
  CAS). Run one active listener — a second machine is a **cold standby**, not active/active; true
  active/active would need a real lease (Redis/DB), which is out of scope.

## Out of scope (this plan)

The secondary "sandcastle-like" own-impl track; the e2e-test roster phase (headless
browser + screenshots/video — explicitly last); onboarding children beyond the first reference
child; paid paths by default; the org (`--org`) path; a GitHub Actions workflow.
