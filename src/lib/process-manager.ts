import { spawn, ChildProcess, execFileSync } from 'child_process';
import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'fs';
import { join } from 'path';
import type { ProjectConfig, LogEntry } from './types';
import { logger } from './logger';
import { getProjectSettings } from './settings';
import { addNotification } from './notifications';
import { checkPort } from './port-checker';

interface ProcessEntry {
  process: ChildProcess;
  startedAt: Date;
  mode: StartMode;
}
const activeProcesses = new Map<string, ProcessEntry>();
const stoppingProjects = new Set<string>();
const restartCounts = new Map<string, number>();
const restartTimers = new Map<string, ReturnType<typeof setTimeout>>();

const MAX_RESTARTS = 5;
const RESTART_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];

// Log directory path
const LOGS_DIR = join(process.cwd(), '.hexops', 'logs');

// Ensure logs directory exists
function ensureLogsDir() {
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true });
  }
}

function getLogFilePath(projectId: string): string {
  return join(LOGS_DIR, `${projectId}.log`);
}

// Read a project's .env.local (and .env) and return key-value pairs.
// This is needed because Next.js 16 + Turbopack bakes env vars at compile
// time — if DATABASE_URL isn't in the OS-level process.env when the Turbopack
// worker starts, it inlines undefined before .env.local ever loads.
function loadProjectEnvFile(projectPath: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const filename of ['.env', '.env.local']) {
    const filePath = join(projectPath, filename);
    if (!existsSync(filePath)) continue;
    try {
      const lines = readFileSync(filePath, 'utf-8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (key) result[key] = value;
      }
    } catch {
      // ignore unreadable files
    }
  }
  return result;
}

function addLogEntry(projectId: string, type: 'stdout' | 'stderr', message: string) {
  ensureLogsDir();
  const logFile = getLogFilePath(projectId);
  const timestamp = new Date().toISOString();
  const prefix = type === 'stderr' ? '[ERR]' : '[OUT]';
  const logLine = `${timestamp} ${prefix} ${message}`;

  try {
    appendFileSync(logFile, logLine + (message.endsWith('\n') ? '' : '\n'));
  } catch {
    // Ignore write errors
  }
}

export type StartMode = 'dev' | 'prod';

/**
 * Build a child project's environment without hexops's own bundler env.
 *
 * hexops itself runs on Turbopack, so its `process.env` carries `TURBOPACK=1`.
 * If that leaks into a managed project, any project whose dev/build script uses
 * `--webpack` fails with "Multiple bundler flags set: TURBOPACK=1, --webpack"
 * and exits 1 — but only when launched by hexops, not from a plain shell, which
 * makes it look like a flaky start path. A project that wants Turbopack still
 * gets it via Next's default or its own `--turbopack`/`.env`, so dropping the
 * inherited flag is safe. (#111)
 */
export function withoutInheritedBundlerEnv(
  env: Record<string, string | undefined>
): Record<string, string | undefined> {
  const rest = { ...env };
  delete rest.TURBOPACK;
  return rest;
}

export function startProject(
  project: ProjectConfig,
  mode: StartMode = 'dev'
): { success: boolean; error?: string } {
  if (activeProcesses.has(project.id)) {
    return { success: false, error: 'Project is already running' };
  }

  try {
    // Clear previous logs and start fresh log file
    ensureLogsDir();
    const logFile = getLogFilePath(project.id);
    const startTime = new Date().toISOString();
    const modeLabel = mode === 'prod' ? 'PRODUCTION' : 'DEVELOPMENT';
    writeFileSync(logFile, `${startTime} [SYS] === Starting ${project.name} (${modeLabel}) ===\n`);

    // For production mode, run build first if available
    if (mode === 'prod') {
      if (!project.scripts.build) {
        return { success: false, error: 'No build script defined for production mode' };
      }
      if (!project.scripts.start) {
        addLogEntry(project.id, 'stdout', 'No start script defined, falling back to dev script');
      }

      // Run build synchronously
      addLogEntry(project.id, 'stdout', '=== Running build... ===');
      try {
        const [buildCmd, ...buildArgs] = project.scripts.build.split(' ');
        execFileSync(buildCmd, buildArgs, {
          cwd: project.path,
          shell: true,
          stdio: 'pipe',
          env: {
            ...withoutInheritedBundlerEnv(process.env),
            ...loadProjectEnvFile(project.path),
            NODE_ENV: 'production',
          },
        });
        addLogEntry(project.id, 'stdout', '=== Build completed ===');
      } catch (buildError) {
        const msg = buildError instanceof Error ? buildError.message : 'Build failed';
        addLogEntry(project.id, 'stderr', `Build failed: ${msg}`);
        return { success: false, error: `Build failed: ${msg}` };
      }
    }

    // Determine which script to run
    const script = mode === 'prod'
      ? (project.scripts.start || project.scripts.dev)
      : project.scripts.dev;
    if (!script) {
      return { success: false, error: `No ${mode} script defined` };
    }

    // Parse the command - shell: true is intentional for npm/pnpm scripts
    // Security note: project.scripts comes from local config file, not user input
    const [cmd, ...args] = script.split(' ');

    // Merge per-project env vars from settings
    const projectSettings = getProjectSettings(project.id);
    const projectEnv = projectSettings.env ?? {};

    // Read project's own .env / .env.local so Turbopack sees vars at compile
    // time (not just after @next/env runs). Explicit projectEnv overrides these.
    const projectFileEnv = loadProjectEnvFile(project.path);

    const child = spawn(cmd, args, {
      cwd: project.path,
      shell: projectSettings.shell ?? true,
      // detached: true makes the child its own process-group leader (POSIX
      // setsid). With shell: true the tracked pid is the `sh -c "<cmd>"`
      // wrapper, not the real dev server it execs/forks — a plain SIGTERM to
      // that pid only reaches `sh`, which does not forward signals to its
      // child, so the real process (e.g. next-server) survives and keeps the
      // port bound (#90). Putting the child in its own group lets stopProject
      // signal the whole group via `process.kill(-pid, ...)`.
      //
      // Consequence: a detached child is no longer auto-killed when hexops's
      // own process exits. That's accepted here — these are long-lived dev
      // servers hexops is meant to manage independently of its own restarts,
      // and the previous shell-wrapper setup was *already* orphaning the
      // real process in practice (this bug is proof of that). We deliberately
      // do NOT call child.unref() — stdout/stderr must keep flowing into the
      // log buffer for as long as hexops is up to observe them.
      detached: true,
      env: {
        ...withoutInheritedBundlerEnv(process.env),
        ...projectFileEnv,
        ...projectEnv,
        PORT: project.port.toString(),
        FORCE_COLOR: '1',
        NODE_ENV: mode === 'prod' ? 'production' : 'development',
      },
    });

    const startedAt = new Date();
    activeProcesses.set(project.id, { process: child, startedAt, mode });

    child.on('spawn', () => {
      const pid = child.pid;
      addLogEntry(project.id, 'stdout', `[SYS] Process started — PID ${pid ?? 'unknown'}, port ${project.port}, mode ${mode}`);
      logger.info('projects', 'process:started', `${project.name} started`, {
        projectId: project.id,
        meta: { pid, port: project.port, mode, command: script },
      });
    });

    child.stdout?.on('data', (data: Buffer) => {
      addLogEntry(project.id, 'stdout', data.toString());
    });

    child.stderr?.on('data', (data: Buffer) => {
      addLogEntry(project.id, 'stderr', data.toString());
    });

    child.on('close', (code, signal) => {
      const intentional = stoppingProjects.has(project.id);
      stoppingProjects.delete(project.id);
      activeProcesses.delete(project.id);

      const isCrash = !intentional && code !== 0;

      if (!isCrash) {
        addLogEntry(project.id, 'stdout', `[SYS] Process stopped (code ${code ?? signal})`);
        logger.info('projects', 'process:stopped', `${project.name} stopped`, {
          projectId: project.id,
          meta: { code, signal, intentional },
        });
        restartCounts.delete(project.id);
        return;
      }

      addLogEntry(project.id, 'stderr', `[SYS] Process crashed — exit code ${code ?? 'null'}, signal ${signal ?? 'none'}`);
      logger.error('projects', 'process:crashed', `${project.name} crashed`, {
        projectId: project.id,
        meta: { code, signal },
      });
      addNotification({
        severity: 'error',
        category: 'application',
        title: `${project.name} crashed`,
        message: `Process exited with code ${code ?? 'null'}, signal ${signal ?? 'none'}`,
        projectId: project.id,
        actionUrl: '/',
      });

      // Auto-restart if configured
      const crashSettings = getProjectSettings(project.id);
      if (!crashSettings.monitoring.restartOnCrash) return;

      const attempts = (restartCounts.get(project.id) ?? 0) + 1;
      restartCounts.set(project.id, attempts);

      if (attempts > MAX_RESTARTS) {
        addLogEntry(project.id, 'stderr', `[SYS] Max restarts (${MAX_RESTARTS}) reached — giving up`);
        logger.error('projects', 'process:restart_limit', `${project.name} exceeded restart limit`, { projectId: project.id });
        restartCounts.delete(project.id);
        return;
      }

      const delay = RESTART_BACKOFF_MS[attempts - 1] ?? RESTART_BACKOFF_MS[RESTART_BACKOFF_MS.length - 1];
      addLogEntry(project.id, 'stdout', `[SYS] Restarting in ${delay / 1000}s (attempt ${attempts}/${MAX_RESTARTS})`);
      logger.info('projects', 'process:restarting', `${project.name} restarting`, {
        projectId: project.id,
        meta: { attempt: attempts, delayMs: delay },
      });

      const timer = setTimeout(() => {
        restartTimers.delete(project.id);
        startProject(project, mode);
      }, delay);
      restartTimers.set(project.id, timer);
    });

    child.on('error', (error) => {
      addLogEntry(project.id, 'stderr', `[SYS] Process error: ${error.message}`);
      logger.error('projects', 'process:error', `${project.name} process error`, {
        projectId: project.id,
        meta: { error: error.message },
      });
      activeProcesses.delete(project.id);
    });

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

// stopProject timing budgets (#90). Real dev servers (esp. Next.js) can take
// a moment to shut down gracefully on SIGTERM; SIGKILL should free the port
// almost immediately once the OS reaps the process, so it gets a much
// shorter window.
const STOP_SIGTERM_TIMEOUT_MS = 4000;
const STOP_SIGKILL_TIMEOUT_MS = 1500;
const STOP_POLL_INTERVAL_MS = 150;
const STOP_PORT_CHECK_TIMEOUT_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll checkPort until it reports the port free, or timeoutMs elapses. */
async function waitUntilPortFree(
  port: number,
  timeoutMs: number,
  pollIntervalMs: number = STOP_POLL_INTERVAL_MS
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // Always check at least once, even for a zero-length budget.
  if (!(await checkPort(port, STOP_PORT_CHECK_TIMEOUT_MS))) return true;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    if (!(await checkPort(port, STOP_PORT_CHECK_TIMEOUT_MS))) return true;
  }
  return false;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/**
 * Signal a tracked child's whole process group, not just the tracked pid
 * (#90). Children are spawned with `detached: true`, making them their own
 * group leader on POSIX, so `-pid` reliably reaches the wrapper shell *and*
 * whatever it execs/forks. Windows has no equivalent of negative-pid group
 * signalling, so there we degrade to signalling just the tracked pid.
 *
 * A group/process that is already gone answers with ESRCH — that is treated
 * as "already stopped," not an error, and is swallowed here. Any other
 * failure (e.g. EPERM) is rethrown for the caller to log and route around.
 */
function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;

  try {
    if (process.platform === 'win32') {
      child.kill(signal);
    } else {
      process.kill(-pid, signal);
    }
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ESRCH') {
      return;
    }
    throw error;
  }
}

/**
 * Port-based fallback (#90). Finds whatever is actually listening on `port`
 * via `ss` and SIGKILLs it directly. This is the only path available when
 * there is no tracked entry at all — a server started before hexops
 * launched, or orphaned by an earlier crash/restart — and it's also the
 * last resort when a tracked kill escalated through SIGTERM+SIGKILL and
 * still didn't free the port.
 */
async function stopByPort(projectId: string, port: number): Promise<{ success: boolean; error?: string }> {
  if (!(await checkPort(port, STOP_PORT_CHECK_TIMEOUT_MS))) {
    return { success: true };
  }

  try {
    let pids: string[] = [];
    try {
      // Use ss to find PIDs - format: users:(("process",pid=12345,fd=19))
      // Security note: port is a number from config, not user string input
      const result = execFileSync('ss', ['-tlnp', `sport = :${port}`], {
        encoding: 'utf-8',
      });
      const pidMatches = result.matchAll(/pid=(\d+)/g);
      for (const match of pidMatches) {
        pids.push(match[1]);
      }
    } catch {
      // ss may fail, which is fine
    }

    for (const pid of pids) {
      // Validate pid is numeric before using
      if (/^\d+$/.test(pid)) {
        try {
          execFileSync('kill', ['-9', pid]);
        } catch {
          // Ignore errors (process may have already exited)
        }
      }
    }

    const freed = await waitUntilPortFree(port, STOP_SIGKILL_TIMEOUT_MS);
    if (freed) {
      addLogEntry(projectId, 'stdout', `[SYS] Process killed via port ${port}`);
      return { success: true };
    }

    return {
      success: false,
      error: pids.length > 0
        ? `Sent SIGKILL to pid(s) ${pids.join(', ')} on port ${port}, but the port is still bound`
        : `No process found on port ${port} via ss, but the port is still bound`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

export async function stopProject(projectId: string, port: number): Promise<{ success: boolean; error?: string }> {
  // Cancel any pending restart timer
  const timer = restartTimers.get(projectId);
  if (timer) { clearTimeout(timer); restartTimers.delete(projectId); }
  restartCounts.delete(projectId);

  const entry = activeProcesses.get(projectId);
  const isLive = entry != null && entry.process.pid != null
    && entry.process.exitCode === null && entry.process.signalCode === null;

  if (entry && isLive) {
    // Mark this projectId as an intentional stop *before* signalling, since
    // the child's 'close' handler can fire at any point during the awaits
    // below and needs to see this to avoid treating it as a crash. Only set
    // when there's a live tracked process — a 'close' event will eventually
    // clean this back up. (Setting it unconditionally, including for the
    // port-only fallback below, would leak forever for a projectId with no
    // tracked entry, silently disabling crash detection on a later start.)
    stoppingProjects.add(projectId);

    try {
      signalProcessGroup(entry.process, 'SIGTERM');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      addLogEntry(projectId, 'stderr', `[SYS] Failed to send SIGTERM to process group: ${message}`);
    }

    let portFreed = await waitUntilPortFree(port, STOP_SIGTERM_TIMEOUT_MS);

    if (!portFreed) {
      addLogEntry(projectId, 'stdout', '[SYS] Still bound after SIGTERM — escalating to SIGKILL');
      try {
        signalProcessGroup(entry.process, 'SIGKILL');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        addLogEntry(projectId, 'stderr', `[SYS] Failed to send SIGKILL to process group: ${message}`);
      }
      portFreed = await waitUntilPortFree(port, STOP_SIGKILL_TIMEOUT_MS);
    }

    if (portFreed) {
      activeProcesses.delete(projectId);
      addLogEntry(projectId, 'stdout', '[SYS] Process stopped');
      return { success: true };
    }

    addLogEntry(
      projectId,
      'stderr',
      '[SYS] Process group survived SIGTERM+SIGKILL — falling back to port-based kill'
    );
  }

  // Port-based fallback — runs whenever the tracked route (or lack thereof)
  // did not verifiably free the port, including when there is no tracked
  // entry at all. Reporting success without this check is exactly bug #90.
  const fallback = await stopByPort(projectId, port);
  if (fallback.success) {
    activeProcesses.delete(projectId);
  }
  return fallback;
}

// Strip ANSI escape codes for clean display
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

export function getLogs(projectId: string, limit = 100): LogEntry[] {
  const logFile = getLogFilePath(projectId);

  if (!existsSync(logFile)) {
    return [];
  }

  try {
    const content = readFileSync(logFile, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const recentLines = lines.slice(-limit);

    return recentLines.map((line) => {
      // Parse: 2026-01-16T14:30:00.000Z [OUT] message
      const match = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+\[(\w+)\]\s+(.*)$/);
      if (match) {
        return {
          timestamp: new Date(match[1]),
          type: match[2] === 'ERR' ? 'stderr' : 'stdout',
          message: stripAnsi(match[3]),
        };
      }
      // Fallback for unparseable lines
      return {
        timestamp: new Date(),
        type: 'stdout' as const,
        message: stripAnsi(line),
      };
    });
  } catch {
    return [];
  }
}

export function isTracked(projectId: string): boolean {
  return activeProcesses.has(projectId);
}

export function getProcessInfo(projectId: string): { pid: number | null; startedAt: Date } | null {
  const entry = activeProcesses.get(projectId);
  if (!entry) return null;

  return {
    pid: entry.process.pid ?? null,
    startedAt: entry.startedAt,
  };
}

export function getTrackedProcesses(): string[] {
  return Array.from(activeProcesses.keys());
}

// ---------------------------------------------------------------------------
// #109 — dev-server-aware patching
//
// Applying a patch runs `pnpm install`, which churns node_modules. If the target
// project's dev server is live (esp. Turbopack), it loses node_modules/next
// mid-reinstall and dies. This guard stops a managed server, applies, then
// restarts it — and refuses outright when the target is hexops itself, because
// the apply request is served by that very process (you cannot stop->apply->
// restart the server handling the request).
// ---------------------------------------------------------------------------

export type DevServerGuardAction = 'passthrough' | 'orchestrate' | 'block-self';

export interface DevServerGuardDecision {
  action: DevServerGuardAction;
  reason: string;
}

/** Decide how a patch/install against a project should treat its dev server. */
export function decideDevServerGuard(input: {
  isSelf: boolean;
  isTracked: boolean;
}): DevServerGuardDecision {
  if (input.isSelf) {
    return {
      action: 'block-self',
      reason:
        'This patch targets hexops itself while its dev server is serving the request. ' +
        'Applying here would run an install, churn node_modules, and kill the server ' +
        'mid-apply. Apply from the CLI instead (or stop hexops first).',
    };
  }
  if (input.isTracked) {
    return {
      action: 'orchestrate',
      reason: 'A managed dev server is running; it will be stopped, patched, then restarted.',
    };
  }
  return { action: 'passthrough', reason: 'No managed dev server is running for this project.' };
}

/** True when the project being patched is the hexops checkout we are running from. */
export function isHexopsSelf(project: ProjectConfig): boolean {
  const resolve = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return resolve(project.path) === resolve(process.cwd());
}

/** Mode a tracked project was started in (defaults to 'dev' when unknown). */
export function getProcessMode(projectId: string): StartMode {
  return activeProcesses.get(projectId)?.mode ?? 'dev';
}

function clearNextBuildDir(projectPath: string): void {
  try {
    rmSync(join(projectPath, '.next'), { recursive: true, force: true });
  } catch {
    // best-effort: a missing or locked .next must not abort the restart
  }
}

export interface DevServerGuardDeps {
  isSelf: (project: ProjectConfig) => boolean;
  isRunning: (projectId: string) => boolean;
  getMode: (projectId: string) => StartMode;
  stop: (projectId: string, port: number) => Promise<{ success: boolean; error?: string }>;
  start: (project: ProjectConfig, mode: StartMode) => { success: boolean; error?: string };
  clearBuildDir: (projectPath: string) => void;
}

const defaultDevServerGuardDeps: DevServerGuardDeps = {
  isSelf: isHexopsSelf,
  isRunning: isTracked,
  getMode: getProcessMode,
  stop: stopProject,
  start: startProject,
  clearBuildDir: clearNextBuildDir,
};

export interface DevServerGuardOutcome<T> {
  decision: DevServerGuardAction;
  reason: string;
  blocked: boolean;
  ranOperation: boolean;
  stopped: boolean;
  restarted: boolean;
  restartError?: string;
  result?: T;
}

/**
 * Run a patch/install `operation` against `project`, guarding its dev server (#109).
 *
 * - block-self: refuses (operation never runs); caller should return an error.
 * - orchestrate: stop -> operation -> (optional .next clear) -> restart. The server
 *   is restored even if the operation throws (the error then propagates).
 * - passthrough: runs the operation directly.
 *
 * `deps` is injectable for testing; defaults are bound to the real process manager.
 */
export async function runWithDevServerGuard<T>(
  project: ProjectConfig,
  operation: () => Promise<T>,
  opts: { clearBuildDir?: boolean } = {},
  deps: DevServerGuardDeps = defaultDevServerGuardDeps,
): Promise<DevServerGuardOutcome<T>> {
  const decision = decideDevServerGuard({
    isSelf: deps.isSelf(project),
    isTracked: deps.isRunning(project.id),
  });

  if (decision.action === 'block-self') {
    return {
      decision: decision.action,
      reason: decision.reason,
      blocked: true,
      ranOperation: false,
      stopped: false,
      restarted: false,
    };
  }

  if (decision.action === 'passthrough') {
    const result = await operation();
    return {
      decision: decision.action,
      reason: decision.reason,
      blocked: false,
      ranOperation: true,
      stopped: false,
      restarted: false,
      result,
    };
  }

  // orchestrate: capture the mode before stopping, restore in finally
  const mode = deps.getMode(project.id);
  const stopResult = await deps.stop(project.id, project.port);
  let result: T | undefined;
  let restarted = false;
  let restartError: string | undefined;
  try {
    result = await operation();
  } finally {
    if (opts.clearBuildDir) deps.clearBuildDir(project.path);
    const startResult = deps.start(project, mode);
    restarted = startResult.success;
    if (!startResult.success) restartError = startResult.error;
  }

  return {
    decision: decision.action,
    reason: decision.reason,
    blocked: false,
    ranOperation: true,
    stopped: stopResult.success,
    restarted,
    restartError,
    result,
  };
}
