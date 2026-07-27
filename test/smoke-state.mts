// test/smoke-state.mts — hermetic smoke for per-item durable state (assignor/state.mts):
// the save data the parent asks whether an item is already being worked, and writes when
// an outcome is applied.
//   devbox run node test/smoke-state.mts
// The store takes its file path at construction, so this drives the real module against a
// throwaway file and never the real `var/state.json`. $0, no network, no GitHub.

import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { StateStore } from "#assignor/state.mts";

const dir = resolve(import.meta.dirname, "..", ".scratch", `smoke-state-${process.pid}`);

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

try {
  // ── the round trip: what the assignor recorded is what it reads back. An item nobody
  //    has run is unknown rather than an error — that is the answer on every delivery ──
  {
    const store = new StateStore(resolve(dir, "state.json"));
    ok("unknown: an item nothing has run yet has no state", store.get("acme/finance#57") === undefined, JSON.stringify(store.get("acme/finance#57")));

    store.set("acme/finance#57", { status: "in-flight" });
    ok(
      "round trip: a recorded item reads back as it was written",
      JSON.stringify(store.get("acme/finance#57")) === JSON.stringify({ status: "in-flight" }),
      JSON.stringify(store.get("acme/finance#57")),
    );
  }
  // ── durable, not remembered: the process that recorded an item is routinely not the
  //    one that asks about it later (a child outlives its parent, ADR-0001), so every
  //    answer comes off the disk and one item's record never overwrites another's ──
  {
    const path = resolve(dir, "restart", "state.json");
    new StateStore(path).set("acme/finance#57", { status: "in-flight" });
    new StateStore(path).set("acme/api#3", { status: "done" });

    const rebooted = new StateStore(path);
    ok("durable: a fresh store reads what an earlier one recorded", rebooted.get("acme/finance#57")?.status === "in-flight", JSON.stringify(rebooted.get("acme/finance#57")));
    ok("durable: recording one item leaves the others untouched", rebooted.get("acme/api#3")?.status === "done", JSON.stringify(rebooted.get("acme/api#3")));

    rebooted.set("acme/finance#57", { status: "done" });
    ok("durable: an item's later state replaces its earlier one", new StateStore(path).get("acme/finance#57")?.status === "done", readFileSync(path, "utf8"));
  }

  // ── atomic: the save data is rewritten on every transition and the parent can be
  //    killed in the instant one is being written. Temp-then-rename is what keeps the
  //    file readable — a torn state.json is EVERY item's state lost at once ──
  {
    const path = resolve(dir, "atomic", "state.json");
    const store = new StateStore(path);
    store.set("acme/finance#57", { status: "in-flight" });

    // An in-place rewrite keeps the same inode, and with it a window in which a reader
    // sees a truncated file. A temp-then-rename swaps the directory entry for a new one.
    const before = statSync(path).ino;
    store.set("acme/finance#57", { status: "done" });
    ok("atomic: a transition swaps the file for a new one rather than truncating in place", statSync(path).ino !== before, `inode ${before} unchanged`);

    // What a crash mid-write actually leaves: bytes in the temp file, none of them in
    // the file the next boot reads.
    writeFileSync(`${path}.tmp`, '{"acme/finance#57":{"stat');
    ok("atomic: a half-written temp file leaves the recorded state readable", new StateStore(path).get("acme/finance#57")?.status === "done", readFileSync(path, "utf8"));
    ok("atomic: the debris is not itself state anyone reads", readdirSync(resolve(dir, "atomic")).filter((f) => f.endsWith(".json")).join(",") === "state.json", readdirSync(resolve(dir, "atomic")).join(","));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
