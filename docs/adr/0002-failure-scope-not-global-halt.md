# A failure stops only what it must, not the whole pipeline

Sunday v1 treats an unrecognised failure as a fail-safe global halt: `classify`
returns `unknown` and the act layer pauses both scheduler lanes until a human
resumes. That is why the pipeline sits halted for long stretches. V2 classifies every
failure into a **scope** instead, and only pipeline-scope failures stop everything.

| Class | Scope | Why |
| --- | --- | --- |
| `quota` | pipeline | Every sandbox spends the same subscription token against one window. Quarantining a single item would feed the whole backlog into the same wall within a minute. |
| `auth` | pipeline | The credential is process-wide; every subsequent run fails identically and instantly. |
| `setup` | repo | The sandbox image is per-repo. Only a dead Docker daemon escalates to pipeline. |
| `transient` | item | Already bounded backoff. |
| `run-failed`, `summarize-failed` | item | The agent ran; the issue is the problem. |
| `unknown` | item | See below. |

`unknown` is the substantive change. It now posts the raw error as a comment, retries
the item **once** with that error injected into the prompt so the agent can react,
and only then quarantines it — labelled, notified at P1, and left untouched until a
human relabels. Everything else keeps running throughout.

## Consequences

- The forcing function that made `unknown` a global halt — "a human must look, so the
  classifier gets tightened" — is weakened. It is preserved by the raw excerpt still
  landing in the durable event log, plus a P1 notification on every quarantine.
- Quarantine is a new durable state, distinct from `failed`. A `failed` item is
  re-admitted by reconcile on the next boot; a quarantined one deliberately is not,
  so it cannot loop.
- One retry per unknown failure costs at most one extra agent run of quota.
