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

    // Get process info from process manager
    const processInfo = getProcessInfo(project.id);

    // Initialize metrics
    const processMetrics: ProcessMetrics = {
      pid: processInfo?.pid || null,
      uptime: null,
      memoryMB: null,
      cpuPercent: null,
      command: null,
    };

    const portMetrics: PortMetrics = {
      isOpen: false,
      responseTimeMs: null,
    };

    // If we have a PID, get detailed process metrics
    if (processInfo?.pid) {
      try {
        // Get process stats using ps command (works on Linux/macOS)
        const { stdout } = await execAsync(
          `ps -p ${processInfo.pid} -o pid,etime,rss,%cpu,command --no-headers`,
          { timeout: 5000 }
        );

        if (stdout.trim()) {
          const parts = stdout.trim().split(/\s+/);
          if (parts.length >= 4) {
            // Parse elapsed time (format: [[DD-]HH:]MM:SS)
            const etime = parts[1];
            processMetrics.uptime = parseElapsedTime(etime);

            // RSS is in KB, convert to MB
            processMetrics.memoryMB = Math.round(parseInt(parts[2]) / 1024);

            // CPU percentage
            processMetrics.cpuPercent = parseFloat(parts[3]);

            // Command (rest of the line)
            processMetrics.command = parts.slice(4).join(' ').substring(0, 50);
          }
        }
      } catch (error) {
        // Process might have died
        console.error('Failed to get process metrics:', error);
      }
    }

    // Check port status and response time
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

    return NextResponse.json({
      status: processInfo ? 'running' : 'stopped',
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
