# #90 — Stop returns success while next-server keeps running

## Root cause (confirmed)

`startProject` spawned with `shell: true, detached: false`. With `shell: true` the
tracked `child.pid` is the `sh -c "<command>"` wrapper, not the real dev server it
execs/forks. `stopProject` signalled only that tracked pid with `SIGTERM`, which
POSIX `sh` does not forward to its child, then returned `{ success: true }`
immediately, without ever checking whether the port was actually released. The
`ss` + `kill -9` fallback only ran when the tracked kill *threw*, which it never
does — so in the common case it was dead code.

## What changed, per function

### `startProject` (`src/lib/process-manager.ts`)

- `detached: false` → `detached: true`. On POSIX this makes the spawned child its
  own process-group leader (`pid === pgid`), so the whole tree — `sh` and whatever
  it forks — can be signalled together via `process.kill(-pid, …)`.
- **Did not** call `child.unref()`. stdout/stderr must keep flowing into the log
  buffer for as long as hexops is running; `unref()` would only affect whether the
  event loop keeps the parent alive on the child's account, which is irrelevant
  here since hexops itself is a long-lived server, but it's also irrelevant to the
  signal-forwarding fix, so I left it untouched per the constraint.
- No other change to the spawn call — `withoutInheritedBundlerEnv` (#111) and the
  `execFileSync` production build step are both untouched.

**Decision on `detached: true` orphaning consequence:** accepted. A detached child
is no longer auto-killed when hexops's own process exits. I concluded this is
correct for HexOps's actual job (managing long-lived dev servers independently of
its own lifecycle/restarts), and — concretely — the *old* `shell: true` setup was
**already** orphaning the real process in practice; that's precisely the incident
this bug report describes (two orphaned `sh -c node` / `node server.js` pairs
found alive after a supposed stop). Making the child detached doesn't introduce a
new failure mode; it makes an existing one **fixable**, because now there is a
single well-defined process group to signal instead of an untrackable descendant.

### `stopProject` — now `async`, returns `Promise<{ success, error? }>`

New flow:

1. Cancel any pending restart timer / clear restart count (unchanged).
2. If there's a **live** tracked entry (`pid` set, `exitCode === null`,
   `signalCode === null`):
   - Mark `stoppingProjects` **only now** (see bookkeeping note below), then
     `signalProcessGroup(entry.process, 'SIGTERM')`.
   - Poll `checkPort` (via new `waitUntilPortFree`) for up to 4s.
   - If still bound, escalate: `signalProcessGroup(entry.process, 'SIGKILL')`,
     poll again for up to 1.5s.
   - If the port is free at either point → `activeProcesses.delete`, return
     `{ success: true }`.
   - If still bound after both escalations → fall through (no early return).
3. **Port-based fallback (`stopByPort`)** — now a real path, not catch-only. Runs
   whenever step 2 didn't verifiably free the port, *including when there is no
   tracked entry at all* (orphan from before hexops launched, or from an earlier
   crash — exactly today's incident). Same `ss -tlnp` + `kill -9` approach as
   before, but now also polls `checkPort` afterward and only reports success if
   the port is actually free. If `ss` finds nothing and the port is still bound,
   or if it kills something and the port is *still* bound, it returns
   `{ success: false, error: '...' }`.

New helpers:

- `signalProcessGroup(child, signal)` — POSIX: `process.kill(-pid, signal)`
  (group). Windows: `child.kill(signal)` (single process — `process.kill(-pid)`
  is POSIX-only and would throw/behave unexpectedly on Windows, so it degrades
  rather than crashing). Swallows `ESRCH` ("already gone" = already stopped, not
  an error); rethrows anything else (e.g. `EPERM`) for the caller to log and
  route around via the port-based fallback.
- `waitUntilPortFree(port, timeoutMs, pollIntervalMs)` — polls `checkPort` (from
  `src/lib/port-checker.ts`) until it reports free or the budget elapses.
- `stopByPort(projectId, port)` — the promoted fallback described above.

Timing budgets: `STOP_SIGTERM_TIMEOUT_MS = 4000`, `STOP_SIGKILL_TIMEOUT_MS =
1500`, poll every `150ms`. Chosen to give a real Next.js dev server a fair chance
to shut down gracefully on SIGTERM, while keeping the SIGKILL confirmation window
short since a killed process frees its socket almost immediately.

### `runWithDevServerGuard` / `DevServerGuardDeps`

Read it before touching it, per the brief. `deps.stop` type changed to
`(projectId, port) => Promise<{ success, error? }>`; the one call site
(`const stopResult = deps.stop(...)`) became `await deps.stop(...)`. The
guard's own control flow was already fully `async`/`await`-based (it already
`await`s `operation()` and is itself declared `async`), so this was a
one-line change — nothing else in the guard assumed synchronous stop.
`defaultDevServerGuardDeps.stop = stopProject` still type-checks since
`stopProject` now returns a `Promise` natively.

### Call sites updated

- `src/app/api/projects/[id]/stop/route.ts:32` —
  `const result = stopProject(...)` → `const result = await stopProject(...)`.
- `src/lib/process-manager.ts:471` (`defaultDevServerGuardDeps.stop`) — no code
  change needed beyond the type; `stopProject` already matches the new async
  signature.

## Restart flow / `stoppingProjects` bookkeeping

- **Pending restart cancel**: unchanged, still the first thing `stopProject`
  does (`clearTimeout` + `restartTimers.delete` + `restartCounts.delete`),
  before any signalling/awaiting. Verified: if `stopProject` is called while a
  restart timer is pending, there's usually no tracked entry left (`close`
  already ran and deleted it), so execution goes straight to `stopByPort`,
  which sees the port already free and returns `{ success: true }` fast,
  without needing `ss`.
- **`stoppingProjects` and the async boundary — found and fixed a real bug
  while implementing this.** The original code called
  `stoppingProjects.add(projectId)` *unconditionally* at the top of
  `stopProject`, before even checking whether there was a tracked entry. That
  flag is only ever cleared by the child's `'close'` handler. For the
  **no-tracked-entry** path (an orphan with no `ChildProcess` object — exactly
  the scenario the port-based fallback is now designed to handle as a first-
  class case) there is no `'close'` event coming, ever, for that stop
  attempt — so the flag would leak forever. If that `projectId` was later
  started for real and *genuinely* crashed, the crash handler would read
  `stoppingProjects.has(projectId) === true` from the stale orphan-stop and
  silently treat the crash as "intentional," suppressing the crash
  notification and auto-restart with no observable cause. This bug pre-dates
  my change but the port-fallback becoming a *primary* path for exactly this
  scenario makes it far more likely to bite in practice, so I fixed it: I now
  only call `stoppingProjects.add(projectId)` right before signalling a
  **live** tracked entry, i.e. only in the branch that has a real `'close'`
  event coming to clean it back up. This is covered by a new regression test
  (`an untracked/orphan stop does not poison crash detection for a later real
  process with the same id`), which fails against the old unconditional-`add`
  behavior and passes now.
- Order-of-events concern ("`close` may now fire at a different time relative
  to `stopProject` returning"): this was already inherently async even before
  my change (Node's `'close'` event needs at least one event-loop turn after
  `kill()`). My change makes it *more* likely `'close'` has already fired by
  the time `stopProject` resolves (since we now actively poll for hundreds of
  ms to seconds before returning) rather than less — which is fine, since the
  `'close'` handler's `activeProcesses.delete` / `stoppingProjects.delete`
  calls are idempotent and `stopProject` doesn't rely on ordering relative to
  it, only on the `checkPort` poll result.

## Windows

`signalProcessGroup` branches on `process.platform === 'win32'` and uses
`child.kill(signal)` (single process, not a negative pid) there, so a non-POSIX
platform degrades gracefully instead of crashing on an invalid `process.kill(-pid,
…)` call. Not exercised by a real Windows run (this project targets Linux/WSL2
per the brief) but the branch is simple and directly testable if needed later.

## TURBOPACK env fix (#111) / prod build step

Untouched. `withoutInheritedBundlerEnv(process.env)` is still spread into the
long-lived `spawn` call's `env`. The prod-mode build step's `execFileSync` call
(synchronous, run before the dev/start script spawn) is unchanged — I only
touched the long-lived `spawn` options and added a *second*, separate use of
`execFileSync` inside `stopByPort` for the `ss`/`kill -9` fallback, which existed
before too (same shape, just promoted from catch-only to a real path).

## Testing

### Unit tests (`src/lib/process-manager.test.ts`)

`child_process.spawn`/`execFileSync`, `./port-checker`'s `checkPort`, and
`./notifications`'s `addNotification` are mocked (`vi.mock` + `vi.hoisted`); no
real process is spawned and no real port is bound in the unit suite. A tracked
entry is created via the *real* `startProject` path with a fake
`EventEmitter`-based `ChildProcess` stand-in, so `activeProcesses`/`close`
bookkeeping runs unmodified. Fake timers (`vi.useFakeTimers` +
`vi.advanceTimersByTimeAsync`) are used for the two tests that exercise the
SIGTERM→SIGKILL escalation windows, so the suite stays fast.

Added 9 tests, all requested cases covered:

1. `spawns with detached: true so the whole process tree can be signalled`
2. `signals the whole process group (-pid), not the bare pid`
3. `returns success once the port is actually released after SIGTERM`
4. `escalates to SIGKILL when the port is still bound after SIGTERM`
5. `returns success: false with an error when the port is still bound after
   SIGTERM and SIGKILL`
6. `treats ESRCH from the kill syscall as already-stopped, not a failure`
7. `runs the port-based fallback when there is no tracked entry at all (e.g.
   an orphaned server)`
8. `reports failure (not success) when the port-based fallback finds nothing
   and the port stays bound` (bonus — untracked-orphan version of case 5)
9. `an untracked/orphan stop does not poison crash detection for a later real
   process with the same id` (the `stoppingProjects` bookkeeping regression
   test described above)

Full suite: **391 passed / 46 files** (baseline 382/46 + 9 new). Nothing deleted
or weakened.

`pnpm typecheck` (`tsc --noEmit`): **clean**, no errors.

### Real-process verification (required — mocked-spawn tests can't catch this class of bug)

Ran the real `startProject`/`stopProject` (via `tsx`, no mocks) against a
trivial Node HTTP listener on port **39123** (never 3000), spawned exactly like
a real project: `dev: "echo starting && node server.js"` under `shell: true` —
the `&&` forces `/bin/sh` to actually fork a child instead of tail-call-exec'ing
into `node`, reproducing the real `sh(parent) → node(child)` shape from the
incident. Script + harness live in the scratchpad
(`/tmp/claude-1000/.../scratchpad/verify90/`), not in this repo. hexops' own
dev server on port 3000 was left completely untouched throughout (confirmed
before and after).

Transcript (trimmed of noise):

```
=== #90 real-process verification ===
Target port: 39123 (never 3000)
startProject -> {"success":true}
Port 39123 bound within 5s: true
Tracked pid (this is the `sh` wrapper pid, not node): 495119

--- ss before stop ---
LISTEN 0 511 *:39123 *:* users:(("MainThread",pid=495120,fd=21))

--- process tree before stop (pstree) ---
sh(495119)---MainThread(495120)-+-{MainThread}(495121)
                                 |-{MainThread}(495122)
                                 |-{MainThread}(495123)
                                 |-{MainThread}(495124)
                                 |-{MainThread}(495125)
                                 `-{MainThread}(495126)
Wrapper pid: 495119, real child pid(s) found via pstree: 495120, 495121, 495122, 495123, 495124, 495125, 495126

calling real stopProject...
stopProject -> {"success":true}

--- ss after stop ---
(empty)
Port 39123 still listening after stop: false

--- orphan check: is the specific wrapper pid or its specific child pid(s) still alive? ---
wrapper pid 495119 alive: false
child pid(s) still alive: (none — all gone)

isTracked after stop: false

=== RESULT: PASS ===
```

Confirmed separately afterward: `ss -tlnp 'sport = :3000'` still shows the
original hexops dev server's `MainThread` listener untouched; `ss -tlnp 'sport =
:39123'` is empty; no leftover processes referencing the scratch app dir.

(Note: `ss -p` on this WSL2 box reports Node's main OS thread as
`"MainThread"` rather than `"node"` — a cosmetic quirk of this environment's
`ss`/procfs, not a correctness issue; the pid identity checks and `pstree`
output make the parent/child relationship unambiguous.)

## Things I'm unsure about / would flag for review

1. **Timing budgets are a judgment call.** 4s for SIGTERM + 1.5s for SIGKILL
   confirmation is reasonable for Next dev servers in practice, but a project
   with an unusually slow graceful-shutdown path could still get force-killed
   sooner than ideal. These aren't currently configurable per-project; if a
   project needs a longer grace period this would be the place to add a setting.
2. **`stopByPort`'s `ss` output parsing is unchanged from the original** (regex
   `pid=(\d+)` over `ss -tlnp` output) — it's still a heuristic string parse, not
   hardened against unusual `ss` output formats. I didn't expand its robustness
   beyond making it a real (polled-and-verified) path, since that was explicitly
   in scope and re-parsing `ss` output wasn't.
3. **The pre-existing `stoppingProjects` leak I fixed** was not explicitly called
   out in the bug report, but I judged it directly load-bearing for the
   port-fallback becoming a first-class path (it's now hit routinely for the
   orphan/no-tracked-entry case the incident describes). Flagging it explicitly
   in case there's a reason it was left as-is that I'm not seeing — I don't see
   one, and the regression test demonstrates the failure mode concretely, but
   it's a slightly larger blast radius than the literal ask.
4. I did not change anything about how `startProject`'s production build step
   (`execFileSync` for `build`) works, and did not touch Windows behavior beyond
   the documented single-process degrade — neither was exercised by a real run
   (no Windows box here, and prod-mode build wasn't part of this bug).

---

## Addendum — response to independent review of `4e8c550`

The review returned do-not-ship with two Critical and three Important findings.
I agree with all five diagnoses (including that C2 was a real regression I
introduced), fixed all five plus all four Minors, and added targeted
regression coverage for each. Summary below; see the commit for the full diff.

### C1 (Critical) — a shipped test could signal a real process group

Confirmed: the "still bound after SIGTERM and SIGKILL" test was the one test
in the file with no mock on `process.kill`, so after the previous test's
`afterEach` ran `vi.restoreAllMocks()`, its `process.kill(-6666, 'SIGTERM'/
'SIGKILL')` calls would hit the real syscall against a fabricated pid — on a
box running ~35 real dev servers. This wasn't a per-test oversight I could
patch one at a time with any confidence; I fixed it structurally.

`process.kill` is now spied in the `stopProject` describe block's own
`beforeEach`, before any test body runs, with a safe no-op default
(`mockReturnValue(true)`, no side effects). Every test that needs custom
kill behavior calls `.mockImplementation`/`.mockReturnValue` on that one
shared `processKillSpy` — no test in this file calls `vi.spyOn(process,
'kill')` a second time. The previously-unmocked test now inherits the safe
default explicitly and unconditionally (and says so in a comment, so a
future editor doesn't "helpfully" remove the now-apparently-redundant spy).
`shutdownTrackedProcesses` and `signalProcessGroup`'s own describe blocks
each spy `process.kill` locally per test, in the same pattern.

### C2 (Critical) — the `stoppingProjects` guard was over-narrowed (regression, confirmed)

Agreed with the diagnosis. I had gated `stoppingProjects.add` on `isLive`
(tracked child, not yet exited), reasoning that only a live child has a
`close` still pending. That reasoning was wrong: with `shell: true`, Node
defers `'close'` until every stdio pipe finishes draining, and a grandchild
holding those pipes open — while still holding the real port, exactly the
#90 shape — can keep `close` pending well after the *direct* child
(`exitCode`) already looks exited. Gating on `isLive` meant that routine
case fell through unmarked: the deferred `close` later fired with
`intentional=false`, producing a false "crashed" notification, and with
`restartOnCrash` on, would relaunch the server the user had just
deliberately stopped.

Fixed exactly as suggested: `stoppingProjects.add(projectId)` now runs
whenever a tracked `ChildProcess` exists at all (`if (entry)`), not only
when it's live. Signalling itself is still gated on `isLive` (unchanged) —
only the bookkeeping guard moved. Added
`marks intentional even when the tracked child already looks exited but its
close is still pending` in `process-manager.test.ts`, which constructs
exactly that shape (tracked entry with `exitCode` already set, port freed
via the fallback, then a late `close` fired manually) and asserts no crash
notification fires. It fails against the `isLive`-gated version and passes
now.

### I1 (Important) — `stopByPort` could kill hexops itself

Agreed — this was a real new route in, since the fallback is now reachable
from a tracked stop whose group died but whose port is held by something
else, not just the pre-existing fully-untracked-orphan case. Added an
ownership guard in `stopByPort`: any pid `ss` reports that equals
`process.pid` or `process.ppid` is skipped (logged, not killed) rather than
sent `SIGKILL`. Each pid that *is* killed is now logged individually before
the kill, for auditability. Covered by
`refuses to kill hexops itself (or its parent) even if ss lists it on the port`.

### I2 (Important) — `runWithDevServerGuard` ignored a failed stop

Agreed — before #90 this branch was unreachable (stop effectively always
"succeeded"), so it was never exercised. `runWithDevServerGuard` now checks
`stopResult.success` immediately after awaiting it and, if false, returns
`{ blocked: true, ranOperation: false, ... }` with a reason explaining the
operation was refused because the server may still be live, without ever
calling `operation()`. All four existing call sites (`override-remove`,
`security/overrides/[id]/fix`, `update`, `security/cve-lite/[id]/fix`)
already branch on `guardOutcome.blocked` generically (checked all four before
making this change) and return a 409 with the reason, so none needed
updating. One exception worth flagging separately: `override-remove/route.ts`
does **not** check `blocked` at all before using `guardOutcome.result` — that
gap pre-dates this change (it already mishandled `block-self` the same way)
and is out of scope here, but it means a stop-failure on that specific route
will currently return a misleading `{success:true, output:''}` rather than a
409. Flagging for a follow-up, not fixing in this patch.

Covered by `orchestrate: aborts (blocked, operation never runs) when stop
fails to actually free the server` in the `runWithDevServerGuard` describe
block.

### I3 (Important) — `detached: true` orphans every server on Ctrl-C/terminal close

Agreed, and the report's original claim was wrong — corrected here.
`detached: false` didn't prevent orphaning on its own, but it kept tracked
children in hexops's own foreground process group and session, so a
terminal Ctrl-C (SIGINT to the foreground group) or terminal close (SIGHUP
to the session) reaped them as a side effect, without any explicit cleanup
code. `detached: true` calls `setsid()`, which severs both — Ctrl-C no
longer reaches tracked children at all once this patch landed, and there
was no code anywhere filling that gap.

Added `shutdownTrackedProcesses(signal)`, which group-signals every
currently-tracked child, and wired it to real `SIGINT`/`SIGTERM` with
`process.exit()` afterward — but only outside test runs
(`process.env.VITEST === 'true' || process.env.NODE_ENV === 'test'`) and
only on POSIX. Registering unconditionally would have installed a real
`process.on('SIGTERM', ...)` handler on every vitest worker process that
imports this module, calling `process.exit()` — and vitest's own pool
workers are routinely sent `SIGTERM` for normal lifecycle reasons (timeouts,
`--watch` restarts, teardown), so intercepting that unconditionally would
have been its own hazard. `shutdownTrackedProcesses` itself is exported and
tested directly (`signals the process group of every currently tracked
child`) without going through a real OS signal.

### Minors

- **M1** — applied exactly as suggested: the `close` handler now guards
  `activeProcesses.delete(project.id)` on `activeProcesses.get(project.id)
  ?.process === child`, so a late `close` from a superseded child can't
  untrack its replacement.
- **M2** — reverted the tightened 300ms `checkPort` timeout back to its
  1000ms default everywhere `stopProject`/`stopByPort` call it (removed the
  `STOP_PORT_CHECK_TIMEOUT_MS` override entirely). Agreed a shortened
  per-attempt timeout was a false-success path in exactly the function meant
  to eliminate them.
- **M3** — `stopProject`'s tracked-success path now also confirms the
  process itself, not just the port: once the port is free, it waits up to
  500ms (`STOP_PROCESS_EXIT_GRACE_MS`) for `exitCode`/`signalCode` to be set,
  and if it still hasn't exited, sends one more defensive `SIGKILL` before
  reporting success (still port-gated per #90's actual contract, but no
  longer silently trusting a released port over a `ChildProcess` handle we
  are already holding). Covered by `port released but the process itself has
  not exited yet: sends a defensive final SIGKILL`.
- **M4** — exported `signalProcessGroup` (documented as test-only, not part
  of the module's intended public surface) and added two direct unit tests
  pinning that ESRCH is swallowed and EPERM is rethrown — the previous ESRCH
  test only proved the *overall* stop still succeeded (via mocked
  `checkPort`), which would have passed identically whether ESRCH was
  swallowed inside `signalProcessGroup` or merely caught by `stopProject`'s
  outer try/catch. Also added an integration-level EPERM test (`an EPERM on
  the tracked group kill does not crash stopProject`) covering the case the
  review called out as unprotected and most dangerous: a real signalling
  failure that must log and fall through to the port-based fallback rather
  than crashing or hanging.

### Verification after the addendum fixes

- Full suite: **399 passed / 46 files** (was 391/46; +8 new tests — 4 in the
  `stopProject` block, 2 in a new `signalProcessGroup` block, 1 in a new
  `shutdownTrackedProcesses` block, 1 in `runWithDevServerGuard`). Nothing
  removed or weakened.
- `tsc --noEmit`: clean.
- Re-ran the real-process verification (same scratch port 39123, same
  `sh(parent) -> node(child)` shape) against the fixed code: `stopProject ->
  {"success":true}`, port confirmed released, tracked wrapper pid and all
  real child pids confirmed dead by `kill -0`, hexops' own port-3000 server
  confirmed untouched throughout. Same PASS outcome as the original
  transcript, now against code that also survives the C1/C2/I1/I2/I3/M1–M4
  fixes.
