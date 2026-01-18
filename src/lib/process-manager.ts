import { spawn, ChildProcess, execFileSync } from 'child_process';
import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ProjectConfig, LogEntry } from './types';

// Store active processes in memory with metadata
interface ProcessEntry {
  process: ChildProcess;
  startedAt: Date;
}
const activeProcesses = new Map<string, ProcessEntry>();

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

export function startProject(project: ProjectConfig): { success: boolean; error?: string } {
  if (activeProcesses.has(project.id)) {
    return { success: false, error: 'Project is already running' };
  }

  try {
    // Clear previous logs and start fresh log file
    ensureLogsDir();
    const logFile = getLogFilePath(project.id);
    const startTime = new Date().toISOString();
    writeFileSync(logFile, `${startTime} [SYS] === Starting ${project.name} ===\n`);

    // Parse the dev command - shell: true is intentional for npm/pnpm scripts
    // Security note: project.scripts comes from local config file, not user input
    const [cmd, ...args] = project.scripts.dev.split(' ');

    const child = spawn(cmd, args, {
      cwd: project.path,
      shell: true, // Required for pnpm/npm scripts
      detached: false,
      env: {
        ...process.env,
        PORT: project.port.toString(),
        FORCE_COLOR: '1',
      },
    });

    activeProcesses.set(project.id, {
      process: child,
      startedAt: new Date(),
    });

    child.stdout?.on('data', (data: Buffer) => {
      addLogEntry(project.id, 'stdout', data.toString());
    });

    child.stderr?.on('data', (data: Buffer) => {
      addLogEntry(project.id, 'stderr', data.toString());
    });

    child.on('close', (code) => {
      addLogEntry(project.id, 'stdout', `Process exited with code ${code}`);
      activeProcesses.delete(project.id);
    });

    child.on('error', (error) => {
      addLogEntry(project.id, 'stderr', `Process error: ${error.message}`);
      activeProcesses.delete(project.id);
    });

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

export function stopProject(projectId: string, port: number): { success: boolean; error?: string } {
  // First try to kill the tracked process
  const entry = activeProcesses.get(projectId);
  if (entry && !entry.process.killed) {
    try {
      entry.process.kill('SIGTERM');
      activeProcesses.delete(projectId);
      addLogEntry(projectId, 'stdout', 'Process stopped via SIGTERM');
      return { success: true };
    } catch {
      // Fall through to port-based kill
    }
  }

  // Fallback: kill by port using ss (lsof often needs sudo)
  // Security note: port is a number from config, not user string input
  try {
    let pids: string[] = [];
    try {
      // Use ss to find PIDs - format: users:(("process",pid=12345,fd=19))
      const result = execFileSync('ss', ['-tlnp', `sport = :${port}`], {
        encoding: 'utf-8',
      });
      // Extract PIDs from ss output using regex
      const pidMatches = result.matchAll(/pid=(\d+)/g);
      for (const match of pidMatches) {
        pids.push(match[1]);
      }
    } catch {
      // ss may fail, which is fine
    }

    if (pids.length > 0) {
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
      activeProcesses.delete(projectId);
      addLogEntry(projectId, 'stdout', `Process killed via port ${port}`);
      return { success: true };
    }

    return { success: false, error: 'No process found on port' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
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
