// test/smoke-preflight.mts — no-docker smoke for the boot image preflight.
//   devbox run node test/smoke-preflight.mts
// Drives the PURE half (isScaffoldPlaceholder) with fixtures; the impure half
// (the sandcastle builds) is exercised live at boot and by the setup watcher.

import { isScaffoldPlaceholder } from "../listener/preflight.mts";

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

// ── isScaffoldPlaceholder: the unedited `sandcastle init` Dockerfile is refused ──
{
  const scaffold = "# EDIT ME: base this on YOUR child's own dev image.\nFROM your-child-dev-image\n";
  ok("placeholder: scaffold detected", isScaffoldPlaceholder(scaffold));
  ok("placeholder: a real Dockerfile passes", !isScaffoldPlaceholder("FROM node:22-alpine\nRUN apk add bash\n"));
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
