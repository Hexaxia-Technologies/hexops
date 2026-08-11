import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import type { ProjectConfig } from './types';

// ---------------------------------------------------------------------------
// #90 — mocks for the real-process-touching parts of stopProject/startProject.
// vi.mock factories are hoisted above all imports by vitest's transform, so
// they must close over vi.hoisted() values rather than plain module consts.
// ---------------------------------------------------------------------------
const { spawnMock, execFileSyncMock, checkPortMock, addNotificationMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  checkPortMock: vi.fn(),
  addNotificationMock: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: spawnMock, execFileSync: execFileSyncMock };
});

vi.mock('./port-checker', () => ({ checkPort: checkPortMock }));
vi.mock('./notifications', () => ({ addNotification: addNotificationMock }));

import {
  withoutInheritedBundlerEnv,
  decideDevServerGuard,
  isHexopsSelf,
  runWithDevServerGuard,
  startProject,
  stopProject,
  signalProcessGroup,
  shutdownTrackedProcesses,
  type DevServerGuardDeps,
} from './process-manager';

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: 'proj',
    name: 'Proj',
    path: '/tmp/some-other-project',
    port: 3001,
    category: 'app',
    scripts: { dev: 'next dev', build: 'next build' },
    ...overrides,
  };
}

describe('withoutInheritedBundlerEnv (#111)', () => {
  it('strips TURBOPACK so hexops\'s own bundler env does not leak into --webpack child projects', () => {
    const result = withoutInheritedBundlerEnv({ TURBOPACK: '1', PATH: '/usr/bin', FOO: 'bar' });
    expect(result.TURBOPACK).toBeUndefined();
    expect(result.PATH).toBe('/usr/bin');
    expect(result.FOO).toBe('bar');
  });

  it('does not mutate the input env', () => {
    const input = { TURBOPACK: '1', FOO: 'bar' };
    withoutInheritedBundlerEnv(input);
    expect(input.TURBOPACK).toBe('1');
  });

  it('is a no-op when TURBOPACK is absent', () => {
    expect(withoutInheritedBundlerEnv({ FOO: 'bar' })).toEqual({ FOO: 'bar' });
  });
});

describe('decideDevServerGuard (#109)', () => {
  it('blocks when patching hexops itself, even if also tracked', () => {
    // You cannot stop->apply->restart the server that is serving the request.
    expect(decideDevServerGuard({ isSelf: true, isTracked: true }).action).toBe('block-self');
    expect(decideDevServerGuard({ isSelf: true, isTracked: false }).action).toBe('block-self');
  });

  it('orchestrates when a tracked managed project is running', () => {
    expect(decideDevServerGuard({ isSelf: false, isTracked: true }).action).toBe('orchestrate');
  });

  it('passes through when nothing is running', () => {
    expect(decideDevServerGuard({ isSelf: false, isTracked: false }).action).toBe('passthrough');
  });
});

describe('isHexopsSelf (#109)', () => {
  it('is true when the project path is hexops own cwd', () => {
    expect(isHexopsSelf(makeProject({ path: process.cwd() }))).toBe(true);
  });

  it('is false for a different project path', () => {
    expect(isHexopsSelf(makeProject({ path: '/tmp/definitely-not-hexops' }))).toBe(false);
  });
});

describe('runWithDevServerGuard (#109)', () => {
  function makeDeps(overrides: Partial<DevServerGuardDeps> = {}): DevServerGuardDeps {
    return {
      isSelf: () => false,
      isRunning: () => false,
      getMode: () => 'dev',
      stop: vi.fn(async () => ({ success: true })),
      start: vi.fn(() => ({ success: true })),
      clearBuildDir: vi.fn(),
      ...overrides,
    };
  }

  it('passthrough: runs the operation, never stops or starts', async () => {
    const deps = makeDeps();
    const op = vi.fn(async () => 'done');
    const out = await runWithDevServerGuard(makeProject(), op, {}, deps);
    expect(out.decision).toBe('passthrough');
    expect(out.blocked).toBe(false);
    expect(out.result).toBe('done');
    expect(op).toHaveBeenCalledTimes(1);
    expect(deps.stop).not.toHaveBeenCalled();
    expect(deps.start).not.toHaveBeenCalled();
  });

  it('block-self: does NOT run the operation and reports blocked', async () => {
    const deps = makeDeps({ isSelf: () => true });
    const op = vi.fn(async () => 'done');
    const out = await runWithDevServerGuard(makeProject(), op, {}, deps);
    expect(out.decision).toBe('block-self');
    expect(out.blocked).toBe(true);
    expect(out.result).toBeUndefined();
    expect(op).not.toHaveBeenCalled();
    expect(deps.stop).not.toHaveBeenCalled();
    expect(deps.start).not.toHaveBeenCalled();
  });

  it('orchestrate: stop -> op -> clear -> restart, in order, with the captured mode', async () => {
    const calls: string[] = [];
    const deps = makeDeps({
      isRunning: () => true,
      getMode: () => 'prod',
      stop: vi.fn(async () => { calls.push('stop'); return { success: true }; }),
      start: vi.fn((_p, mode) => { calls.push(`start:${mode}`); return { success: true }; }),
      clearBuildDir: vi.fn(() => { calls.push('clear'); }),
    });
    const op = vi.fn(async () => { calls.push('op'); return 'r'; });
    const out = await runWithDevServerGuard(makeProject(), op, { clearBuildDir: true }, deps);
    expect(out.decision).toBe('orchestrate');
    expect(out.result).toBe('r');
    expect(out.stopped).toBe(true);
    expect(out.restarted).toBe(true);
    expect(calls).toEqual(['stop', 'op', 'clear', 'start:prod']);
  });

  it('orchestrate: does not clear the build dir unless asked', async () => {
    const deps = makeDeps({ isRunning: () => true });
    await runWithDevServerGuard(makeProject(), async () => 'r', {}, deps);
    expect(deps.clearBuildDir).not.toHaveBeenCalled();
    expect(deps.start).toHaveBeenCalledTimes(1);
  });

  it('orchestrate: restarts the server even when the operation throws, then rethrows', async () => {
    const deps = makeDeps({ isRunning: () => true });
    const op = vi.fn(async () => { throw new Error('install failed'); });
    await expect(runWithDevServerGuard(makeProject(), op, {}, deps)).rejects.toThrow('install failed');
    expect(deps.stop).toHaveBeenCalledTimes(1);
    expect(deps.start).toHaveBeenCalledTimes(1); // server restored in finally
  });

  it('orchestrate: surfaces a restart failure without masking the operation result', async () => {
    const deps = makeDeps({
      isRunning: () => true,
      start: vi.fn(() => ({ success: false, error: 'port in use' })),
    });
    const out = await runWithDevServerGuard(makeProject(), async () => 'ok', {}, deps);
    expect(out.result).toBe('ok');
    expect(out.restarted).toBe(false);
    expect(out.restartError).toBe('port in use');
  });

  it('orchestrate: aborts (blocked, operation never runs) when stop fails to actually free the server (#90 review finding I2)', async () => {
    // Before #90, stopProject effectively always reported success, so a
    // failed stop here was unreachable. Now it's real: running an install
    // against a dev server that may still be live is exactly the hazard
    // #109 exists to prevent.
    const deps = makeDeps({
      isRunning: () => true,
      stop: vi.fn(async () => ({ success: false, error: 'still bound after SIGKILL' })),
    });
    const op = vi.fn(async () => 'should never run');
    const out = await runWithDevServerGuard(makeProject(), op, {}, deps);
    expect(out.blocked).toBe(true);
    expect(out.ranOperation).toBe(false);
    expect(out.result).toBeUndefined();
    expect(op).not.toHaveBeenCalled();
    expect(deps.start).not.toHaveBeenCalled(); // never tries to restart something it never actually stopped
    expect(out.reason).toContain('still bound after SIGKILL');
  });
});

// ---------------------------------------------------------------------------
// #90 — Stop returns success while next-server keeps running
//
// child_process.spawn/execFileSync and port-checker.checkPort are mocked
// (see top of file); no real dev server or port is ever bound here. A fake
// ChildProcess-like EventEmitter stands in for the tracked child so
// startProject's real bookkeeping (activeProcesses, close handling) runs
// unmodified.
// ---------------------------------------------------------------------------

class FakeChildProcess extends EventEmitter {
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn((_signal?: NodeJS.Signals | number) => {
    this.killed = true;
    return true;
  });
  constructor(pid: number) {
    super();
    this.pid = pid;
  }
}

describe('stopProject (#90 — verify before reporting success)', () => {
  // Structural safety net (review finding C1): a prior revision left one
  // test with no mock on process.kill at all — after vi.restoreAllMocks()
  // ran in the previous test's afterEach, that test's process.kill(-pid,
  // 'SIGTERM'/'SIGKILL') calls hit the REAL syscall against a fabricated
  // pid, on a box that runs ~35 real dev servers. Spying here, before any
  // test body runs, means no test in this describe block can ever reach the
  // real syscall — even one that forgets to stub it itself. Individual
  // tests only ever call `.mockImplementation`/`.mockReturnValue` on this
  // shared spy, never `vi.spyOn(process, 'kill')` again.
  function spyOnProcessKill() {
    return vi.spyOn(process, 'kill').mockReturnValue(true);
  }
  let processKillSpy: ReturnType<typeof spyOnProcessKill>;

  beforeEach(() => {
    spawnMock.mockReset();
    execFileSyncMock.mockReset();
    checkPortMock.mockReset();
    addNotificationMock.mockReset();
    processKillSpy = spyOnProcessKill();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** Spawn a project via the real startProject path with a fake child, so it lands in activeProcesses. */
  function trackProject(id: string, pid: number, port = 3001): FakeChildProcess {
    const fake = new FakeChildProcess(pid);
    spawnMock.mockReturnValueOnce(fake);
    const result = startProject(makeProject({ id, port }));
    expect(result.success).toBe(true);
    return fake;
  }

  it('spawns with detached: true so the whole process tree can be signalled', () => {
    const fake = new FakeChildProcess(1234);
    spawnMock.mockReturnValueOnce(fake);
    const result = startProject(makeProject({ id: 'spawn-opts' }));
    expect(result.success).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const options = spawnMock.mock.calls[0][2] as { detached?: boolean };
    expect(options.detached).toBe(true);
  });

  it('signals the whole process group (-pid), not the bare pid', async () => {
    const fake = trackProject('group-signal', 4242);
    checkPortMock.mockResolvedValue(false); // port already free once signalled
    processKillSpy.mockImplementation((_pid, signal) => {
      if (signal === 'SIGTERM') fake.exitCode = 0; // simulate the real process actually exiting
      return true;
    });

    const result = await stopProject('group-signal', 3001);

    expect(result.success).toBe(true);
    expect(processKillSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
  });

  it('returns success once the port is actually released after SIGTERM', async () => {
    const fake = trackProject('freed', 7777);
    checkPortMock.mockResolvedValue(false);
    processKillSpy.mockImplementation(() => {
      fake.exitCode = 0;
      return true;
    });

    const result = await stopProject('freed', 3001);

    expect(result).toEqual({ success: true });
  });

  it('escalates to SIGKILL when the port is still bound after SIGTERM', async () => {
    vi.useFakeTimers();
    const fake = trackProject('escalate', 5555);
    let bound = true;
    checkPortMock.mockImplementation(async () => bound);
    processKillSpy.mockImplementation((_pid, signal) => {
      if (signal === 'SIGKILL') {
        bound = false; // SIGKILL is what actually frees it
        fake.exitCode = null;
        fake.signalCode = 'SIGKILL';
      }
      return true;
    });

    const resultPromise = stopProject('escalate', 3001);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await resultPromise;

    expect(processKillSpy).toHaveBeenCalledWith(-5555, 'SIGTERM');
    expect(processKillSpy).toHaveBeenCalledWith(-5555, 'SIGKILL');
    expect(result.success).toBe(true);
  });

  it('returns success: false with an error when the port is still bound after SIGTERM and SIGKILL', async () => {
    vi.useFakeTimers();
    trackProject('never-frees', 6666);
    checkPortMock.mockResolvedValue(true); // nothing ever frees it
    execFileSyncMock.mockReturnValue(''); // ss finds nothing either
    // processKillSpy keeps its safe default from beforeEach (returns true,
    // no side effects) — this test intentionally does not override it, to
    // prove the describe-level default alone is what keeps it safe.

    const resultPromise = stopProject('never-frees', 3001);
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(processKillSpy).toHaveBeenCalledWith(-6666, 'SIGTERM');
    expect(processKillSpy).toHaveBeenCalledWith(-6666, 'SIGKILL');
  });

  it('treats ESRCH from the kill syscall as already-stopped, not a failure', async () => {
    trackProject('esrch', 8888);
    checkPortMock.mockResolvedValue(false); // consistent with the process already being gone
    const esrch = Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    processKillSpy.mockImplementation(() => {
      throw esrch;
    });

    const result = await stopProject('esrch', 3001);

    expect(result.success).toBe(true);
    expect(processKillSpy).toHaveBeenCalledWith(-8888, 'SIGTERM');
  });

  it('an EPERM on the tracked group kill does not crash stopProject — it logs and falls through to the port-based fallback', async () => {
    // Review finding M4: ESRCH-swallowing was tested, but the "most
    // dangerous" branch — a real signalling failure like EPERM — had no
    // coverage at the stopProject level at all.
    vi.useFakeTimers();
    trackProject('eperm-fallback', 4444);
    let bound = true;
    checkPortMock.mockImplementation(async () => bound);
    const eperm = Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    processKillSpy.mockImplementation(() => {
      throw eperm;
    });
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'ss') return 'LISTEN 0 511 *:3001 *:* users:(("node",pid=4445,fd=19))';
      if (cmd === 'kill') {
        bound = false;
        return '';
      }
      return '';
    });

    const resultPromise = stopProject('eperm-fallback', 3001);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledWith('kill', ['-9', '4445']);
  });

  it('runs the port-based fallback when there is no tracked entry at all (e.g. an orphaned server)', async () => {
    let bound = true;
    checkPortMock.mockImplementation(async () => bound);
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'ss') return 'LISTEN 0 511 *:3001 *:* users:(("node",pid=9999,fd=19))';
      if (cmd === 'kill') {
        bound = false;
        return '';
      }
      return '';
    });

    const result = await stopProject('never-tracked', 3001);

    expect(result.success).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledWith('ss', expect.arrayContaining(['-tlnp']), expect.anything());
    expect(execFileSyncMock).toHaveBeenCalledWith('kill', ['-9', '9999']);
    expect(processKillSpy).not.toHaveBeenCalled(); // no tracked group to signal — this is the port-only path
  });

  it('reports failure (not success) when the port-based fallback finds nothing and the port stays bound', async () => {
    checkPortMock.mockResolvedValue(true);
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'ss') return ''; // nothing found
      return '';
    });

    const result = await stopProject('untracked-stuck', 3001);

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('refuses to kill hexops itself (or its parent) even if ss lists it on the port (review finding I1)', async () => {
    vi.useFakeTimers();
    checkPortMock.mockResolvedValue(true); // stays "bound" from hexops' own listener's point of view
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'ss') return `LISTEN 0 511 *:3001 *:* users:(("node",pid=${process.pid},fd=19))`;
      return '';
    });

    const resultPromise = stopProject('self-guard', 3001);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(execFileSyncMock).not.toHaveBeenCalledWith('kill', expect.anything());
  });

  it('an untracked/orphan stop does not poison crash detection for a later real process with the same id', async () => {
    // Reproduces the exact #90 incident: an orphaned server with no tracked
    // entry gets stopped via the port-based fallback. Before the fix,
    // stoppingProjects was marked unconditionally and never cleaned up when
    // there was no ChildProcess to fire a 'close' event — silently disabling
    // crash notifications for this projectId forever.
    checkPortMock.mockResolvedValue(false); // nothing listening; fallback no-ops to success
    const orphanStop = await stopProject('orphan-then-real', 3001);
    expect(orphanStop.success).toBe(true);
    expect(addNotificationMock).not.toHaveBeenCalled();

    const fake = trackProject('orphan-then-real', 2222);
    fake.emit('close', 1, null); // a genuine crash: non-zero exit, no signal, no stop in flight

    expect(addNotificationMock).toHaveBeenCalledTimes(1);
    expect(addNotificationMock.mock.calls[0][0]).toMatchObject({
      severity: 'error',
      projectId: 'orphan-then-real',
    });
  });

  it('marks intentional even when the tracked child already looks exited but its close is still pending (review finding C2 regression)', async () => {
    // With shell: true, the direct child (sh) can look exited while a
    // grandchild that inherited its stdio pipes is still holding them open
    // — and, in the real #90 shape, still holding the port. Node defers
    // 'close' until those pipes finish draining. An earlier revision of this
    // fix only marked stoppingProjects when the tracked entry was "live"
    // (exitCode === null), so this exact routine case fell through
    // unmarked: the pending close later fired with intentional=false — a
    // false "crashed" notification, and with restartOnCrash on, hexops
    // would relaunch the server the user had just deliberately stopped.
    const fake = trackProject('exited-but-pending-close', 3333);
    fake.exitCode = 1; // direct child already looks exited...

    let bound = true;
    checkPortMock.mockImplementation(async () => bound);
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'ss') return 'LISTEN 0 511 *:3001 *:* users:(("node",pid=3334,fd=19))';
      if (cmd === 'kill') {
        bound = false;
        return '';
      }
      return '';
    });

    const stopResult = await stopProject('exited-but-pending-close', 3001);
    expect(stopResult.success).toBe(true);
    // isLive was false, so the tracked signalling branch never ran — this
    // was resolved entirely by the port-based fallback, exactly as it would
    // be in the real grandchild-holds-the-port shape.
    expect(processKillSpy).not.toHaveBeenCalled();

    // ...and now its 'close' fires late, as it would for real once the
    // grandchild's pipes finally drain. It must be read as intentional.
    addNotificationMock.mockClear();
    fake.emit('close', 1, null);
    expect(addNotificationMock).not.toHaveBeenCalled();
  });

  it('port released but the process itself has not exited yet: sends a defensive final SIGKILL rather than trusting the port alone (review finding M3)', async () => {
    const fake = trackProject('hung-after-close', 5678);
    checkPortMock.mockResolvedValue(false); // socket already released...
    // ...but the process itself never actually exits (fake.exitCode stays
    // null throughout) — e.g. it closed its listener but hung.
    processKillSpy.mockReturnValue(true);

    const result = await stopProject('hung-after-close', 3001);

    expect(result.success).toBe(true); // #90's contract (port released) is still honored
    expect(processKillSpy).toHaveBeenCalledWith(-5678, 'SIGTERM');
    // A second, defensive SIGKILL must have been sent once the grace window
    // for the process to actually exit elapsed without it doing so.
    expect(processKillSpy).toHaveBeenCalledWith(-5678, 'SIGKILL');
  });
});

describe('signalProcessGroup (#90 — review finding M4: ESRCH vs EPERM must be genuinely distinguished)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('swallows ESRCH (group already gone) rather than throwing', () => {
    const fake = new FakeChildProcess(1111);
    const esrch = Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw esrch;
    });

    expect(() => signalProcessGroup(fake as unknown as ChildProcess, 'SIGTERM')).not.toThrow();
    expect(killSpy).toHaveBeenCalledWith(-1111, 'SIGTERM');
  });

  it('rethrows EPERM (permission denied) rather than swallowing it', () => {
    const fake = new FakeChildProcess(2222);
    const eperm = Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw eperm;
    });

    expect(() => signalProcessGroup(fake as unknown as ChildProcess, 'SIGTERM')).toThrow('kill EPERM');
    expect(killSpy).toHaveBeenCalledWith(-2222, 'SIGTERM');
  });
});

describe('shutdownTrackedProcesses (#90 — review finding I3: detached children need explicit cleanup)', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('signals the process group of every currently tracked child', () => {
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);

    const fakeA = new FakeChildProcess(6001);
    spawnMock.mockReturnValueOnce(fakeA);
    expect(startProject(makeProject({ id: 'shutdown-a', port: 4101 })).success).toBe(true);

    const fakeB = new FakeChildProcess(6002);
    spawnMock.mockReturnValueOnce(fakeB);
    expect(startProject(makeProject({ id: 'shutdown-b', port: 4102 })).success).toBe(true);

    shutdownTrackedProcesses('SIGTERM');

    expect(killSpy).toHaveBeenCalledWith(-6001, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(-6002, 'SIGTERM');

    // Tidy up module state for later tests: let both children's 'close'
    // fire as a clean, non-crash exit.
    fakeA.emit('close', 0, null);
    fakeB.emit('close', 0, null);
  });
});
