// services/logger.mts — the one Logger. Everything Sunday says goes through it.
//
// The LEVEL selects the destinations (one table, below): a call site says how
// important a line is and never which sinks to hit, so no single call can forget to
// route an important one. The MODULE TAG is bound when a child logger is created and
// the emitting object takes no tag argument, so a caller cannot omit it.

/** info: routine progress — durable and on screen, nowhere else.
 *  milestone: a work-item state change worth reporting to humans watching the issue.
 *  alert: operator-facing but NOT a failure (a PR opened, a pause armed).
 *  error: something broke. */
export type Level = "info" | "milestone" | "alert" | "error";

/** What a line is about. `repo` + `target` are what the GitHub destination addresses;
 *  a pipeline-scope line (boot, a halt) simply carries no target and therefore
 *  reaches no issue — v1's "no pipeline state on issues" rule, with no special case. */
export interface LogContext {
  /** `<owner>/<repo>`. */
  repo?: string;
  /** The issue or PR number this line concerns. */
  target?: number;
}

export interface LogLine {
  /** ISO timestamp, stamped once per line so every destination records the same one. */
  ts: string;
  level: Level;
  module: string;
  message: string;
  context: LogContext;
}

/** A sink. May be async (the phone posts over HTTP); a rejection degrades exactly
 *  like a synchronous throw. */
export type Destination = (line: LogLine) => void | Promise<void>;

/** The five sinks, injected — the Logger constructs none of them, which is what lets
 *  a test substitute the lot and what keeps a smoke out of the real `var/`. */
export interface Destinations {
  console: Destination;
  runLog: Destination;
  eventLog: Destination;
  github: Destination;
  phone: Destination;
}

type DestinationName = keyof Destinations;

/** Durable first (a line survives even if what follows blows up), then the screen,
 *  then the best-effort external sinks. */
const ORDER: readonly DestinationName[] = ["eventLog", "runLog", "console", "github", "phone"];

/** THE routing table. The only place a level becomes a set of destinations. */
const ROUTES: Record<Level, readonly DestinationName[]> = {
  info: ["runLog", "console"],
  milestone: ["eventLog", "runLog", "console", "github"],
  // alert and error share their destinations DELIBERATELY: an alert is operator-facing
  // but not a failure (a PR opened, a pause armed). They differ in the level recorded
  // on the durable event — which is what the act layer branches on — not in reach.
  alert: ["eventLog", "runLog", "console", "github", "phone"],
  error: ["eventLog", "runLog", "console", "github", "phone"],
};

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A line GitHub can be told about: it names both the repo and the issue/PR number. */
function addressable(context: LogContext): boolean {
  return context.repo !== undefined && context.target !== undefined;
}

/** The emitting half: carries its module tag and nothing else. */
export class ModuleLogger {
  // Declared, not parameter properties: Node runs `.mts` in strip-only mode, which
  // rejects `constructor(private x)`.
  private readonly module: string;
  private readonly dests: Destinations;

  constructor(module: string, dests: Destinations) {
    this.module = module;
    this.dests = dests;
  }

  info(message: string, context: LogContext = {}): void {
    this.emit("info", message, context);
  }

  milestone(message: string, context: LogContext = {}): void {
    this.emit("milestone", message, context);
  }

  alert(message: string, context: LogContext = {}): void {
    this.emit("alert", message, context);
  }

  error(message: string, context: LogContext = {}): void {
    this.emit("error", message, context);
  }

  private emit(level: Level, message: string, context: LogContext): void {
    const line: LogLine = { ts: new Date().toISOString(), level, module: this.module, message, context };
    for (const name of ORDER) {
      if (!ROUTES[level].includes(name)) continue;
      // The table's one condition: GitHub needs something to address. A pipeline-scope
      // line carries no target and therefore lands on no issue.
      if (name === "github" && !addressable(context)) continue;
      this.send(name, line);
    }
  }

  /** Best-effort, always: a destination that fails must not stop the ones after it,
   *  and must never reach the caller. The Logger sits on every failure path, so a
   *  throw here would turn a handled failure into a crash. */
  private send(name: DestinationName, line: LogLine): void {
    try {
      const pending = this.dests[name](line);
      if (pending) void pending.catch((err: unknown) => this.degraded(name, line, err));
    } catch (err) {
      this.degraded(name, line, err);
    }
  }

  /** Record a sink failure STRAIGHT onto the event log, bypassing the routing table —
   *  routing it would send a broken sink's failure back through the broken sink. When
   *  the event log is itself what broke there is nowhere left to record it. */
  private degraded(name: DestinationName, line: LogLine, err: unknown): void {
    try {
      this.dests.eventLog({
        ts: new Date().toISOString(),
        level: "error",
        module: "logger",
        message: `${name} destination failed — ${describe(err)} (dropped: ${line.module}: ${line.message})`,
        context: line.context,
      });
    } catch {
      // Nowhere left to put it. Swallowing is the contract.
    }
  }
}

/** The root: creation only, no emit methods — the tag cannot be skipped. */
export class Logger {
  private readonly dests: Destinations;

  constructor(dests: Destinations) {
    this.dests = dests;
  }

  /** A logger tagged with the module that owns it (`"assignor"`, `"github"`, …). */
  child(module: string): ModuleLogger {
    return new ModuleLogger(module, this.dests);
  }
}
