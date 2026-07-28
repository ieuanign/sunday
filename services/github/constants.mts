// services/github/constants.mts — the labels Sunday writes on GitHub, split out of
// `index.mts` per CLAUDE.md §7. Values only: `index.mts` re-exports them
// (`export * from "./constants.mts"`), so no caller's import path changes.

/** The label that says an issue is Sunday's RIGHT NOW. It is the durable cross-restart
 *  guard: a parent that comes back up with no memory reads this off GitHub, and a
 *  delivery that arrives mid-run is rejected by admission on the strength of it. */
export const CLAIM_LABEL = "agent-working";

/** The label that says a work item failed twice and has been set aside (#39). It is the
 *  RELEASE signal as much as the record: admission refuses a quarantined item while this
 *  is on the issue, and a human takes it off to hand the item back. Seeded by
 *  `scripts/repo-init.sh` alongside the rest. */
export const QUARANTINE_LABEL = "quarantined";

/** The label that says the agent RAN and reported the failure itself — its own verdict,
 *  not something that blew up around it. Nothing retries one: the run happened, and a
 *  second one would spend a whole agent run re-deciding what it already decided. Like
 *  `QUARANTINE_LABEL` it is the RELEASE signal as much as the record — admission refuses
 *  the item while this is on the issue, and a human takes it off to hand it back. */
export const AGENT_FAILED_LABEL = "agent-failed";

/** The label that says a HUMAN has to act before this moves again: an issue run that
 *  stopped to ask, and a PR whose restack hit a conflict Sunday will not guess at (#43).
 *  One home rather than a literal per writer — this is the string a human filters on. */
export const AWAITING_HUMAN_LABEL = "awaiting-human";
