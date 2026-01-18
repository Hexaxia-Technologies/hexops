import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/lib/config';
import { getProcessInfo } from '@/lib/process-manager';
import { checkPort } from '@/lib/port-checker';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface ProcessMetrics {
  pid: number | null;
  uptime: number | null; // seconds
  memoryMB: number | null;
  cpuPercent: number | null;
  command: string | null;
}

interface PortMetrics {
  isOpen: boolean;
  responseTimeMs: number | null;
}

// Find PID listening on a port using ss
async function findPidOnPort(port: number): Promise<number | null> {
  try {
    const { stdout } = await execAsync(`ss -tlnp sport = :${port}`, { timeout: 5000 });
    // Parse output like: users:(("node",pid=12345,fd=19))
    const pidMatch = stdout.match(/pid=(\d+)/);
    if (pidMatch) {
      return parseInt(pidMatch[1]);
    }
  } catch {
    // ss may fail or port may not be in use
  }
  return null;
}

// Get process metrics from PID using ps
async function getProcessMetricsFromPid(pid: number): Promise<Partial<ProcessMetrics>> {
  try {
    const { stdout } = await execAsync(
      `ps -p ${pid} -o pid,etime,rss,%cpu,command --no-headers`,
      { timeout: 5000 }
    );

    if (stdout.trim()) {
      const parts = stdout.trim().split(/\s+/);
      if (parts.length >= 4) {
        return {
          pid,
          uptime: parseElapsedTime(parts[1]),
          memoryMB: Math.round(parseInt(parts[2]) / 1024),
          cpuPercent: parseFloat(parts[3]),
          command: parts.slice(4).join(' ').substring(0, 50),
        };
      }
    }
  } catch {
    // Process might have died
  }
  return { pid };
}

// Parse ps elapsed time format: [[DD-]HH:]MM:SS
function parseElapsedTime(etime: string): number {
  let seconds = 0;
  let parts = etime.split('-');

  // Handle days
  if (parts.length === 2) {
    seconds += parseInt(parts[0]) * 86400;
    etime = parts[1];
  } else {
    etime = parts[0];
  }

  // Handle HH:MM:SS or MM:SS
  parts = etime.split(':');
  if (parts.length === 3) {
    seconds += parseInt(parts[0]) * 3600;
    seconds += parseInt(parts[1]) * 60;
    seconds += parseInt(parts[2]);
  } else if (parts.length === 2) {
    seconds += parseInt(parts[0]) * 60;
    seconds += parseInt(parts[1]);
  }

  return seconds;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const project = getProject(id);

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

    // Initialize metrics
    let processMetrics: ProcessMetrics = {
      pid: null,
      uptime: null,
      memoryMB: null,
      cpuPercent: null,
      command: null,
    };

    const portMetrics: PortMetrics = {
      isOpen: false,
      responseTimeMs: null,
    };

    // Check port status first
    try {
      const startTime = Date.now();
      const isOpen = await checkPort(project.port);
      const responseTime = Date.now() - startTime;

      portMetrics.isOpen = isOpen;
      if (isOpen) {
        portMetrics.responseTimeMs = responseTime;
      }
    } catch (error) {
      console.error('Failed to check port:', error);
    }

    // Try to get PID from our internal tracking first
    const processInfo = getProcessInfo(project.id);
    let pid: number | null = processInfo?.pid ?? null;

    // If not tracked internally but port is open, find PID from port
    if (!pid && portMetrics.isOpen) {
      pid = await findPidOnPort(project.port);
    }

    // If we have a PID, get detailed process metrics
    if (pid) {
      const stats = await getProcessMetricsFromPid(pid);
      processMetrics = {
        pid: stats.pid ?? pid,
        uptime: stats.uptime ?? null,
        memoryMB: stats.memoryMB ?? null,
        cpuPercent: stats.cpuPercent ?? null,
        command: stats.command ?? null,
      };
    }

    const isRunning = portMetrics.isOpen || pid !== null;

    return NextResponse.json({
      status: isRunning ? 'running' : 'stopped',
      process: processMetrics,
      port: portMetrics,
      startedAt: processInfo?.startedAt || null,
    });
  } catch (error) {
    console.error('Error fetching metrics:', error);
    return NextResponse.json(
      { error: 'Failed to fetch metrics' },
      { status: 500 }
    );
  }
}
