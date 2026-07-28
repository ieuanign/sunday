// issue/types.mts — the two shapes one issue run is driven by, split out of `index.mts`
// per CLAUDE.md §7. Declarations only: `index.mts` re-exports them
// (`export * from "./types.mts"`), so no caller's import path changes.

import type { Agent } from "#services/agent/index.mts";
import type { Git } from "#services/git.mts";
import type { GitHubRun } from "#services/github/index.mts";
import type { ModuleLogger } from "#services/logger.mts";
import type { ImagePresent } from "./preconditions.mts";

/** One issue run, fully resolved. Every path is absolute and every file already read: the
 *  entry point (`issue/run.mts`) resolves them from the Job, so nothing in here derives a
 *  path or opens a file. */
export interface IssueRunInput {
  /** The work-item key (`<owner>/<repo>#<issue>`) the outcome is named back with, and
   *  what the agent's per-run floor dir is named for. */
  key: string;
  /** `<owner>/<repo>`, from the routing table. */
  repo: string;
  issue: number;
  /** The child checkout this run happens against, absolute. */
  childDir: string;
  /** The branch this run bases on and its PR targets — `main`, or `feat/<blocker>` when
   *  the Assignor stacked this item on a blocker whose PR is already open (#42). The
   *  ASSIGNOR decided it and this run recomputes none of it (constraint 8); re-asserting
   *  that a stacked base still exists before shipping is #38's. */
  base: string;
  /** The pre-built sandbox image for this repo. */
  imageName: string;
  /** The labels this repo admits an issue on, from the routing table. The run asserts
   *  they are all STILL on the issue before it starts (#38): a human who pulls one while
   *  the item waits in the queue is taking it back, and an agent started anyway spends
   *  real quota on work nobody asked for any more. */
  triggerLabels: string[];
  /** The repo's baseline prompt, already read — its `{{REPO}}`/`{{ISSUE}}` placeholders
   *  are filled here. */
  baselinePrompt: string;
  /** This run's own log. The agent library appends its raw output to the same file, so
   *  the run reads back in one place. */
  logPath: string;
  /** Continue the session a previous run gated on, with the human's answer — and with how
   *  big that session had grown when it gated (#67), which only the parent's durable state
   *  still knows. Absent is unknown, and unknown resumes. */
  resume?: { sessionId: string; reply: string; contextTokens?: number };
  /** The context a session may reach before a reply is handed off to a fresh one instead
   *  of resuming it (#67). A resolved NUMBER: `.env`'s `HANDOFF_CTX_THRESHOLD` is read and
   *  validated by the entry point, because `Number("12O000")` is `NaN` and `ctx >= NaN` is
   *  `false` — a typo would disable the feature in silence, which is v1's bug. */
  handoffThreshold: number;
  /** What the PREVIOUS attempt at this item died on, when this run is #39's one retry.
   *  Handed to the agent in the prompt: it is the only thing this run knows that the last
   *  one did not, and without it a retry is the same run again on fresh quota. */
  retryError?: string;
}

/** Everything a run reaches the world through, and constructs none of. */
export interface IssueModuleDeps {
  agent: Agent;
  github: GitHubRun;
  git: Git;
  /** Is this repo's image on the host? A plain injected function rather than the sandbox
   *  service: nothing in `issue/` may import that library, and a check that constructed
   *  its own probe could not be driven without docker (#34 constraint 7). */
  imagePresent: ImagePresent;
  /** Keep this run's handoff note (#67). Injected, and injected as a function taking only
   *  the TEXT, for the same reason `imagePresent` is: the module resolves no path and
   *  opens no file, so the entry point owns where a note lands and a smoke sees what would
   *  have been written without a temp dir. May throw — the run catches it. */
  writeHandoffNote: (note: string) => void;
  /** Drop the spent note, once the pull request the fresh session opened exists. May
   *  throw, and the run catches that too: this one fires AFTER the push. */
  clearHandoffNote: () => void;
  log: ModuleLogger;
}
