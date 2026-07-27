// test/smoke-receiver.mts — hermetic smoke for the front door: the real receiver, on a
// real socket, answering real requests. What is asserted is what a delivery BECOMES —
// the receiver decides nothing, so every case here is about the shape handed on and
// about a delivery never being dropped in silence.
//   devbox run node test/smoke-receiver.mts
// Port 0 asks the OS for a free one, so this never collides with a live pipeline. $0,
// loopback only, no network, no GitHub.

import type { Delivery } from "../assignor/index.mts";
import { createReceiver } from "../services/github/receiver.mts";
import { Logger, type Destinations, type LogLine } from "../services/logger.mts";

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

/** Did the receiver say anything at all about it? Constraint 10: every delivery is
 *  accounted for by a line, including the ones nothing could be made of. */
const said = (lines: LogLine[], text: string) => lines.some((l) => l.message.includes(text));

/** A real receiver on a free port, with the one thing it reaches — the Assignor's
 *  handler — substituted, so what is asserted is the deliveries it produces. */
async function harness(onDelivery: (delivery: Delivery) => void = () => {}) {
  /** Every line the receiver emits, at any level — the run log is the one destination
   *  every level routes to. */
  const lines: LogLine[] = [];
  /** What would reach the issue as a comment. */
  const comments: LogLine[] = [];
  const dests: Destinations = {
    console: () => {},
    runLog: (line) => void lines.push(line),
    eventLog: () => {},
    github: (line) => void comments.push(line),
    phone: () => {},
  };

  const delivered: Delivery[] = [];
  const receiver = createReceiver({
    port: 0,
    log: new Logger(dests).child("receiver"),
    onDelivery: (delivery) => {
      delivered.push(delivery);
      onDelivery(delivery);
    },
  });
  const port = await receiver.start();
  const url = `http://127.0.0.1:${port}/`;

  return {
    delivered,
    lines,
    comments,
    url,
    stop: () => receiver.stop(),
    get: () => fetch(url),
    post: (event: string, body: unknown) =>
      fetch(url, {
        method: "POST",
        headers: { "x-github-event": event },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
  };
}

// ── the readiness answer: process-compose holds the forwarders back until the receiver
//    says it is serving, so this GET is what stops events arriving at a closed socket ──
{
  const h = await harness();
  const res = await h.get();

  ok("readiness: a GET is answered 200 the moment the receiver is serving", res.status === 200, String(res.status));
  ok("readiness: it says who is up, for a human curling it", (await res.text()).length > 0);
  ok("readiness: a probe is not a delivery", h.delivered.length === 0, JSON.stringify(h.delivered));
  await h.stop();
}

// ── the delivery itself: the event is a HEADER and everything else is the body, and the
//    Assignor only ever sees what comes out of here. It is normalised, not judged — the
//    repo and the number are still the payload's own spelling (constraint 14) ──
{
  const h = await harness();
  const res = await h.post("issues", {
    action: "labeled",
    repository: { full_name: "acme/finance" },
    issue: { number: 57, labels: [{ name: "sunday" }, { name: "ready-for-agent" }] },
  });

  ok("delivery: a POST is answered, so the forwarder is not left holding it", res.status === 200, String(res.status));
  ok("delivery: exactly one delivery reaches the Assignor", h.delivered.length === 1, JSON.stringify(h.delivered));
  ok(
    "delivery: the event comes off the X-GitHub-Event header, the action off the body",
    h.delivered[0]?.event === "issues" && h.delivered[0].action === "labeled",
    JSON.stringify(h.delivered[0]),
  );
  ok(
    "delivery: it names the repo and the issue the payload was about",
    h.delivered[0]?.repo === "acme/finance" && h.delivered[0].number === 57,
    JSON.stringify(h.delivered[0]),
  );
  ok(
    "delivery: labels arrive as the names admission compares against, not as objects",
    JSON.stringify(h.delivered[0]?.labels) === JSON.stringify(["sunday", "ready-for-agent"]),
    JSON.stringify(h.delivered[0]?.labels),
  );
  await h.stop();
}

// ── a pull_request payload carries its number and labels under `pull_request`, not
//    `issue`. #42/#43 route these; the spine's job is that they arrive whole — and a
//    CLOSED one carries the two fields #43's restack is seeded from: whether it merged,
//    and which branch it merged. The head ref is the only place the merged ISSUE number
//    is written down (the delivery's own number is the PR's) ──
{
  const h = await harness();
  await h.post("pull_request", {
    action: "closed",
    repository: { full_name: "acme/finance" },
    pull_request: { number: 61, labels: [{ name: "stacked" }], merged: true, head: { ref: "feat/9" } },
  });

  ok(
    "delivery: a PR payload's number and labels are found where a PR keeps them",
    h.delivered[0]?.number === 61 && JSON.stringify(h.delivered[0].labels) === JSON.stringify(["stacked"]),
    JSON.stringify(h.delivered[0]),
  );
  ok(
    "delivery: a merged close says it merged — GitHub sends no `merged` action, so this flag is the whole signal",
    h.delivered[0]?.merged === true,
    JSON.stringify(h.delivered[0]),
  );
  ok(
    "delivery: and which branch merged, which is where the merged issue number is written down",
    h.delivered[0]?.head === "feat/9",
    JSON.stringify(h.delivered[0]),
  );
  await h.stop();
}

// ── a PR closed WITHOUT merging looks identical bar one field, and it must not seed a
//    restack: nothing landed, so nothing stacked on it has moved ──
{
  const h = await harness();
  await h.post("pull_request", {
    action: "closed",
    repository: { full_name: "acme/finance" },
    pull_request: { number: 61, labels: [], merged: false, head: { ref: "feat/9" } },
  });

  ok("delivery: a PR closed unmerged says so", h.delivered[0]?.merged === false, JSON.stringify(h.delivered[0]));
  await h.stop();
}

// ── a comment delivery carries the two things a gate resume is decided on: what the
//    human wrote, and whether they wrote it on an ISSUE. GitHub files a pull request's
//    conversation comments under `issue` as well, with a `pull_request` key inside it as
//    the only tell — and a run resumed off a PR comment is #44's, not this one's ──
{
  const h = await harness();
  await h.post("issue_comment", {
    action: "created",
    repository: { full_name: "acme/finance" },
    issue: { number: 57, labels: [{ name: "awaiting-human" }] },
    comment: { body: "Use the OAuth flow." },
  });
  await h.post("issue_comment", {
    action: "created",
    repository: { full_name: "acme/finance" },
    issue: { number: 61, labels: [], pull_request: { url: "https://api.github.com/repos/acme/finance/pulls/61" } },
    comment: { body: "@sunday the rebase dropped a commit" },
  });

  ok(
    "comment: the body reaches the Assignor — it IS the reply a gated run resumes on",
    h.delivered[0]?.comment === "Use the OAuth flow.",
    JSON.stringify(h.delivered[0]),
  );
  ok("comment: one on an issue is said to be one", h.delivered[0]?.onPullRequest === false, JSON.stringify(h.delivered[0]));
  ok(
    "comment: a PR's conversation comment arrives under `issue`, and is still known for a PR's",
    h.delivered[1]?.onPullRequest === true,
    JSON.stringify(h.delivered[1]),
  );
  ok(
    "comment: and it did not merge anything — a comment on a merged PR's thread must not read as the merge (#43)",
    h.delivered[1]?.merged === false && h.delivered[1].head === undefined,
    JSON.stringify(h.delivered[1]),
  );
  await h.stop();
}

// ── a payload with no issue or PR in it (a `ping`, a `push`) is still a delivery. The
//    receiver judges nothing: it hands on a number that is not one, and the Assignor
//    refuses to build a work-item key out of it (constraint 14, already smoke-covered) ──
{
  const h = await harness();
  await h.post("ping", { repository: { full_name: "acme/finance" }, zen: "Non-blocking is better than blocking." });

  ok("delivery: a payload about no issue still reaches the Assignor", h.delivered.length === 1, JSON.stringify(h.delivered));
  ok(
    "delivery: with a number that is plainly not one, rather than a plausible wrong one",
    Number.isNaN(h.delivered[0]?.number),
    JSON.stringify(h.delivered[0]),
  );
  ok("delivery: and no labels invented for it", h.delivered[0]?.labels.length === 0, JSON.stringify(h.delivered[0]));
  await h.stop();
}

// ── a body that is not the JSON it claims to be. The receiver runs the whole parent
//    process, so a delivery it cannot read has to cost that delivery and nothing else —
//    and it is RECORDED (constraint 10): a work item dropped with no line anywhere is
//    the defect class this rewrite exists to kill ──
{
  const h = await harness();
  const res = await h.post("issues", "{not json");
  const after = await h.post("issues", {
    action: "opened",
    repository: { full_name: "acme/finance" },
    issue: { number: 58, labels: [] },
  });

  ok("unreadable: nothing is handed to the Assignor from a body nobody could read", h.delivered.length === 1, JSON.stringify(h.delivered));
  ok("unreadable: it is recorded, naming the event it came in as", said(h.lines, "issues"), JSON.stringify(h.lines.map((l) => l.message)));
  ok("unreadable: the request is still answered rather than left hanging", res.status === 200, String(res.status));
  ok("unreadable: and the receiver is still serving the next delivery", after.status === 200 && h.delivered[0]?.number === 58, JSON.stringify(h.delivered));
  await h.stop();
}

// ── neither a probe nor a delivery. Refused outright, rather than read as an empty body
//    and routed as one ──
{
  const h = await harness();
  const res = await fetch(h.url, { method: "DELETE" });

  ok("method: anything that is not a GET or a POST is refused", res.status === 405, String(res.status));
  ok("method: and is not routed as a delivery", h.delivered.length === 0, JSON.stringify(h.delivered));
  await h.stop();
}

// ── the handler runs SYNCHRONOUSLY inside this request, and what it does reaches the
//    world: admission claims the issue over the `gh` CLI, which throws when the CLI is
//    missing, unauthenticated or rate-limited. One such delivery must cost that delivery
//    — not the process that every other repo's forwarder is pointed at ──
{
  let thrown = 0;
  const h = await harness(() => {
    if (thrown++ === 0) throw new Error("gh: HTTP 401");
  });
  const res = await h.post("issues", {
    action: "labeled",
    repository: { full_name: "acme/finance" },
    issue: { number: 57, labels: [{ name: "sunday" }] },
  });
  const after = await h.post("issues", {
    action: "labeled",
    repository: { full_name: "acme/finance" },
    issue: { number: 58, labels: [{ name: "sunday" }] },
  });

  ok("handler: a delivery the Assignor choked on is still answered", res.status === 200, String(res.status));
  ok("handler: and the receiver is still serving the next one", after.status === 200 && h.delivered.length === 2, JSON.stringify(h.delivered));
  ok(
    "handler: the failure is recorded, naming the work item it was about and what broke",
    said(h.lines, "acme/finance#57") && said(h.lines, "gh: HTTP 401"),
    JSON.stringify(h.lines.map((l) => l.message)),
  );
  ok(
    "handler: and nothing is posted to the issue — a redelivered event would comment on every retry",
    h.comments.length === 0,
    JSON.stringify(h.comments.map((l) => l.message)),
  );
  await h.stop();
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
