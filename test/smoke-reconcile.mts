// test/smoke-reconcile.mts — no-quota smoke for reconcile-on-restart (step 7).
//   devbox run node test/smoke-reconcile.mts
// Drives the PURE decision helpers with synthetic comments/labels/blockers — the
// re-derivation logic without any GitHub I/O. The end-to-end orchestration (which
// reads GitHub via gh) is user-driven, like the 6c restack e2e.

import {
  pickResumeReply,
  hasUnaddressedSunday,
  issueAction,
  type CommentRef,
} from "../listener/reconcile.mts";
import { restackOwed } from "../listener/restack.mts";
import { hasLivePr } from "../listener/dag.mts";
import { isSummon, isActivatedSpec, SUNDAY_MARKER } from "../listener/helper.mts";
import type { Blocker } from "../listener/dag.mts";

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

const gate = (id: number, ask = "what do you want?"): CommentRef => ({
  id,
  body: `${SUNDAY_MARKER}\n🤖 **Sunday**\n\n${ask}`,
});
const human = (id: number, body = "@sunday please go"): CommentRef => ({ id, body });

// ── pickResumeReply: the human reply that should resume a gated issue ──
{
  ok(
    "resume: reply after our gate → that body",
    pickResumeReply([gate(10), human(11, "use option B")], SUNDAY_MARKER) === "use option B",
  );
  ok(
    "resume: no reply since the gate → null",
    pickResumeReply([human(9, "earlier chatter"), gate(10)], SUNDAY_MARKER) === null,
  );
  ok(
    "resume: multiple replies → the newest",
    pickResumeReply([gate(10), human(11, "first"), human(12, "final")], SUNDAY_MARKER) === "final",
  );
  ok(
    "resume: only our gate, no human → null",
    pickResumeReply([gate(10)], SUNDAY_MARKER) === null,
  );
  ok(
    "resume: no gate anchor at all → null",
    pickResumeReply([human(11, "orphan reply")], SUNDAY_MARKER) === null,
  );
  ok(
    "resume: our own comment after the gate is ignored (marker)",
    pickResumeReply([gate(10), gate(11, "ping")], SUNDAY_MARKER) === null,
  );
}

// ── hasUnaddressedSunday: an @sunday newer than our last reply (per stream) ──
{
  const reply = (id: number): CommentRef => ({ id, body: `${SUNDAY_MARKER}\nfixed it` });
  const summon = (id: number): CommentRef => ({ id, body: "@sunday take another look" });
  ok(
    "pr: summon after our last reply → unaddressed",
    hasUnaddressedSunday([summon(20), reply(21), summon(22)], SUNDAY_MARKER, isSummon),
  );
  ok(
    "pr: summon already answered → addressed",
    !hasUnaddressedSunday([summon(20), reply(21)], SUNDAY_MARKER, isSummon),
  );
  ok(
    "pr: summon, never replied → unaddressed",
    hasUnaddressedSunday([summon(20)], SUNDAY_MARKER, isSummon),
  );
  ok(
    "pr: no summon at all → addressed",
    !hasUnaddressedSunday([{ id: 5, body: "nice work" }], SUNDAY_MARKER, isSummon),
  );
}

// ── issueAction: what reconcile does with one open issue ──
{
  const failed = { status: "failed" as const };
  const done = { status: "done" as const };
  const inFlight = { status: "in-flight" as const };
  const gated = { status: "awaiting-human" as const };
  const noPr = () => false;
  const livePr = () => true;
  ok("issue: admissible + no prior → admit", issueAction(true, false, undefined, false, noPr) === "admit");
  ok("issue: admissible + failed prior → admit (retry)", issueAction(true, false, failed, false, noPr) === "admit");
  ok("issue: admissible + orphaned in-flight → admit (restart)", issueAction(true, false, inFlight, false, noPr) === "admit");
  ok("issue: admissible + done prior → skip", issueAction(true, false, done, false, noPr) === "skip");
  ok("issue: admissible + awaiting-human → skip (gate pass owns it)", issueAction(true, false, gated, false, noPr) === "skip");
  ok("issue: admissible but already has a live PR → skip (GitHub truth)", issueAction(true, false, undefined, false, livePr) === "skip");
  ok("issue: not admissible, missing triggers + @sunday → summon", issueAction(false, true, undefined, true, noPr) === "summon");
  ok("issue: missing triggers, no @sunday → skip", issueAction(false, true, undefined, false, noPr) === "skip");
  ok("issue: not-ours reason (not missing-triggers) → skip", issueAction(false, false, undefined, true, noPr) === "skip");
  // The live-PR read is lazy — skipped when the state check already decided.
  let prChecked = false;
  issueAction(true, false, done, false, () => { prChecked = true; return true; });
  ok("issue: live-PR check is lazy (skipped when state already skips)", !prChecked);
}

// ── hasLivePr: open/merged blocks a fresh re-admit; closed-unmerged doesn't ──
{
  ok("livePr: OPEN → live", hasLivePr(["OPEN"]));
  ok("livePr: MERGED → live", hasLivePr(["MERGED"]));
  ok("livePr: CLOSED (unmerged) → not live", !hasLivePr(["CLOSED"]));
  ok("livePr: no PRs → not live", !hasLivePr([]));
  ok("livePr: mixed closed + open → live", hasLivePr(["CLOSED", "OPEN"]));
}

// ── restackOwed: a dependent still needing a rebase onto main ──
{
  const closed: Blocker[] = [{ number: 5, state: "closed" }];
  const open: Blocker[] = [{ number: 5, state: "open" }];
  const two: Blocker[] = [{ number: 5, state: "closed" }, { number: 6, state: "closed" }];
  ok("restack: 1 closed blocker + main NOT ancestor → owed", restackOwed(closed, () => false));
  ok("restack: 1 closed blocker + main IS ancestor → not owed", !restackOwed(closed, () => true));
  ok("restack: open blocker → not owed (parent's cascade handles it)", !restackOwed(open, () => false));
  ok("restack: 0 blockers → not owed", !restackOwed([], () => false));
  ok("restack: >1 blocker (never stacked) → not owed", !restackOwed(two, () => false));
  let called = false;
  restackOwed(open, () => { called = true; return false; });
  ok("restack: ancestor check is lazy (skipped when blockers fail)", !called);
}

// ── isActivatedSpec: a spec mis-labelled for the agent → nudge; else no-op ──
{
  const triggers = ["ready-for-agent", "auto-dev"];
  ok("spec: spec + all triggers → activated (nudge)", isActivatedSpec(["spec", "ready-for-agent", "auto-dev"], triggers));
  ok("spec: bare spec, no triggers → not activated", !isActivatedSpec(["spec"], triggers));
  ok("spec: spec + partial triggers → not activated", !isActivatedSpec(["spec", "ready-for-agent"], triggers));
  ok("spec: triggers but no spec label → not activated", !isActivatedSpec(["ready-for-agent", "auto-dev"], triggers));
  ok("spec: no labels → not activated", !isActivatedSpec([], triggers));
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
