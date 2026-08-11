import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
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
  beforeEach(() => {
    spawnMock.mockReset();
    execFileSyncMock.mockReset();
    checkPortMock.mockReset();
    addNotificationMock.mockReset();
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
    trackProject('group-signal', 4242);
    checkPortMock.mockResolvedValue(false); // port already free once signalled
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);

    const result = await stopProject('group-signal', 3001);

    expect(result.success).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
  });

  it('returns success once the port is actually released after SIGTERM', async () => {
    trackProject('freed', 7777);
    checkPortMock.mockResolvedValue(false);
    vi.spyOn(process, 'kill').mockReturnValue(true);

    const result = await stopProject('freed', 3001);

    expect(result).toEqual({ success: true });
  });

  it('escalates to SIGKILL when the port is still bound after SIGTERM', async () => {
    vi.useFakeTimers();
    trackProject('escalate', 5555);
    let bound = true;
    checkPortMock.mockImplementation(async () => bound);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 'SIGKILL') bound = false; // SIGKILL is what actually frees it
      return true;
    });

    const resultPromise = stopProject('escalate', 3001);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await resultPromise;

    expect(killSpy).toHaveBeenCalledWith(-5555, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(-5555, 'SIGKILL');
    expect(result.success).toBe(true);
  });

  it('returns success: false with an error when the port is still bound after SIGTERM and SIGKILL', async () => {
    vi.useFakeTimers();
    trackProject('never-frees', 6666);
    checkPortMock.mockResolvedValue(true); // nothing ever frees it
    execFileSyncMock.mockReturnValue(''); // ss finds nothing either

    const resultPromise = stopProject('never-frees', 3001);
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('treats ESRCH from the kill syscall as already-stopped, not a failure', async () => {
    trackProject('esrch', 8888);
    checkPortMock.mockResolvedValue(false); // consistent with the process already being gone
    const esrch = Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw esrch;
    });

    const result = await stopProject('esrch', 3001);

    expect(result.success).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(-8888, 'SIGTERM');
  });

  it('runs the port-based fallback when there is no tracked entry at all (e.g. an orphaned server)', async () => {
    let bound = true;
    checkPortMock.mockImplementation(async () => bound);
    const killSpy = vi.spyOn(process, 'kill');
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
    expect(killSpy).not.toHaveBeenCalled(); // no tracked group to signal — this is the port-only path
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
});
