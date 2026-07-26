// lib/markers.mts — how a comment Sunday authored is recognisable, to a machine and
// to a human. Ported from v1 (`listener/helper.mts`) rather than imported: v1 and V2
// must not cross-import until cutover deletes v1. The literals are UNCHANGED — live
// issue threads already carry them, and v1's comment routing still matches them.

/** Hidden marker on every comment WE post, so comment routing can tell our own comment
 *  from a human's: both are authored by the same account, so the login cannot. */
export const SUNDAY_MARKER = "<!-- sunday:gate -->";

/** Human-visible attribution, paired with the hidden marker so a person reading the
 *  thread can see at a glance who authored a comment. */
export const SUNDAY_SIGN = "🤖 **Sunday** · autonomous agent";

/** Compose a comment WE author: hidden marker, visible attribution, then the content.
 *  Every comment Sunday posts goes through here — an unmarked one reads back as a
 *  summon, and Sunday answers itself. */
export function sundayComment(body: string): string {
  return `${SUNDAY_MARKER}\n${SUNDAY_SIGN}\n\n${body}`;
}

/** The summon keyword. Case-insensitive because a human writes it by hand, and bounded
 *  so an account whose name merely starts with ours (`@sundaybot`) is somebody else's
 *  mention. Unchanged from v1 — live issue threads already summon Sunday this way. */
const SUNDAY_MENTION = /@sunday\b/i;

/** Is this comment a human handing work to Sunday? The marker check comes first and is
 *  what makes it a HUMAN's: Sunday posts under the same account, so a comment of ours
 *  that quotes the request it is answering would otherwise summon us to answer
 *  ourselves — forever, each round a real agent run on real quota. */
export function isSummon(body: string): boolean {
  return !body.includes(SUNDAY_MARKER) && SUNDAY_MENTION.test(body);
}
