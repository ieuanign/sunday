// lib/markers.mts — how a comment Sunday authored is recognisable, to a machine and
// to a human. Ported from v1 (`listener/helper.mts`). The literals are UNCHANGED —
// live issue threads already carry them.

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

/** Hidden marker on a comment that ANSWERS a summon, carried in addition to
 *  `SUNDAY_MARKER`. Separate because "is this ours" and "has this summon been served"
 *  are different questions: Sunday posts milestone comments on the same thread it
 *  replies on, and judged by `SUNDAY_MARKER` alone a milestone would look like an
 *  answer — burying a summon that landed mid-run under a comment that never addressed
 *  it, forever. */
export const SUNDAY_REPLY_MARKER = "<!-- sunday:reply -->";

/** The reply marker for a reply that NAMES the summon it answers. The bare marker above
 *  could only say "something at or below here was served", which is a single watermark
 *  over the whole stream — so a reply to one summon buried every LOWER-id summon that had
 *  never been addressed, permanently and invisibly. The id is what makes "answered" a fact
 *  about one comment instead of a position in the stream. */
export function replyMarkerFor(comment: number): string {
  return `<!-- sunday:reply:${comment} -->`;
}

/** Every comment id a body claims to have answered. */
const ANSWERED_ID = /<!-- sunday:reply:(\d+) -->/g;

/** Compose a REPLY to a summon: the reply marker naming the comment it answers, on top of
 *  an ordinary Sunday comment — so it still reads as ours (`isSummon`) while being the
 *  only thing that counts as an answer, and only for the one summon it names. */
export function sundayReply(body: string, comment: number): string {
  return `${replyMarkerFor(comment)}\n${sundayComment(body)}`;
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

/** The summons in one comment stream that Sunday has not answered: the ones NEWER than
 *  its newest reply. Decidable with no state of ours because GitHub's comment ids are
 *  monotonic, which is what makes a crashed or retried run idempotent — the replies it
 *  already posted are visible to the next attempt, on this boot and every boot after.
 *
 *  PURE, and per stream: ids are only comparable inside one id space, so a PR's
 *  conversation and its inline review comments are filtered separately.
 *
 *  Judged on the REPLY marker alone (constraint 7): the milestone comments a work item
 *  posts land on the same thread, and counting one as an answer would bury a summon that
 *  arrived mid-run under a comment that never addressed it.
 *
 *  A reply NAMES what it answers, so a run that served one summon cannot bury another
 *  that merely has a lower id — the case a single watermark got wrong, and got wrong
 *  silently and forever: a comment written while a run was in flight is skipped as
 *  in-flight, is not in the set that run gathered, and then sinks under the replies that
 *  run did post. */
export function unansweredSummons<T extends { id: number; body: string }>(comments: T[]): T[] {
  // The LEGACY floor, and the only thing the bare marker can still mean. Replies written
  // before the id existed recorded no comment, so everything below the newest of them
  // stays answered — drop this and every summon a previous Sunday already served re-fires
  // on the next boot, in every repo at once, on real quota. A marker that names its
  // comment raises no floor, which is the whole point.
  const floor = comments.reduce((max, c) => (c.body.includes(SUNDAY_REPLY_MARKER) && c.id > max ? c.id : max), 0);
  const answered = new Set<number>();
  for (const c of comments) for (const [, id] of c.body.matchAll(ANSWERED_ID)) answered.add(Number(id));
  return comments.filter((c) => isSummon(c.body) && c.id > floor && !answered.has(c.id));
}
