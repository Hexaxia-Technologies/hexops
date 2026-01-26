import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface SystemMetrics {
  cpu: {
    percent: number;
    cores: number;
    model: string;
  };
  memory: {
    percent: number;
    usedGB: number;
    totalGB: number;
  };
  disk: {
    percent: number;
    usedGB: number;
    totalGB: number;
  };
  timestamp: number;
}

/**
 * Get CPU usage percentage
 * Uses a sampling approach to measure CPU usage over 100ms
 */
async function getCpuUsage(): Promise<number> {
  try {
    const cpus = os.cpus();
    if (!cpus || cpus.length === 0) return 0;

    // Calculate initial CPU times
    const startMeasure = cpus.map(cpu => ({
      idle: cpu.times.idle,
      total: Object.values(cpu.times).reduce((a, b) => a + b, 0)
    }));

    // Wait 100ms for sampling
    await new Promise(resolve => setTimeout(resolve, 100));

    // Get new CPU times
    const endCpus = os.cpus();
    if (!endCpus || endCpus.length === 0) return 0;

    const endMeasure = endCpus.map(cpu => ({
      idle: cpu.times.idle,
      total: Object.values(cpu.times).reduce((a, b) => a + b, 0)
    }));

    // Calculate average CPU usage across all cores
    let totalUsage = 0;
    const coreCount = Math.min(cpus.length, endCpus.length);
    for (let i = 0; i < coreCount; i++) {
      const idleDiff = endMeasure[i].idle - startMeasure[i].idle;
      const totalDiff = endMeasure[i].total - startMeasure[i].total;
      const usage = totalDiff > 0 ? 100 - (idleDiff / totalDiff * 100) : 0;
      totalUsage += usage;
    }

    const result = Math.round(totalUsage / coreCount);
    return isNaN(result) ? 0 : result;
  } catch (error) {
    console.error('Error getting CPU usage:', error);
    return 0;
  }
}

/**
 * Get memory usage
 */
function getMemoryUsage(): { percent: number; usedGB: number; totalGB: number } {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  return {
    percent: Math.round((usedMem / totalMem) * 100),
    usedGB: Math.round((usedMem / (1024 * 1024 * 1024)) * 10) / 10,
    totalGB: Math.round((totalMem / (1024 * 1024 * 1024)) * 10) / 10,
  };
}

/**
 * Get disk usage for the root filesystem
 */
async function getDiskUsage(): Promise<{ percent: number; usedGB: number; totalGB: number }> {
  try {
    const { stdout } = await execAsync("df -B1 / | tail -1 | awk '{print $2, $3, $5}'", {
      timeout: 5000,
    });
    const parts = stdout.trim().split(/\s+/);
    if (parts.length < 3) {
      return { percent: 0, usedGB: 0, totalGB: 0 };
    }

    const [total, used, percentStr] = parts;
    const totalBytes = parseInt(total, 10);
    const usedBytes = parseInt(used, 10);
    const percent = parseInt(percentStr?.replace('%', '') || '0', 10);

    const usedGB = isNaN(usedBytes) ? 0 : Math.round((usedBytes / (1024 * 1024 * 1024)) * 10) / 10;
    const totalGB = isNaN(totalBytes) ? 0 : Math.round((totalBytes / (1024 * 1024 * 1024)) * 10) / 10;

    return {
      percent: isNaN(percent) ? 0 : percent,
      usedGB,
      totalGB,
    };
  } catch (error) {
    console.error('Error getting disk usage:', error);
    return { percent: 0, usedGB: 0, totalGB: 0 };
  }
}

/**
 * Get all system metrics
 */
export async function getSystemMetrics(): Promise<SystemMetrics> {
  try {
    const cpus = os.cpus();
    const [cpuPercent, disk] = await Promise.all([
      getCpuUsage(),
      getDiskUsage(),
    ]);

    const memory = getMemoryUsage();

    return {
      cpu: {
        percent: cpuPercent,
        cores: cpus?.length || 0,
        model: cpus?.[0]?.model || 'Unknown',
      },
      memory,
      disk,
      timestamp: Date.now(),
    };
  } catch (error) {
    console.error('Error getting system metrics:', error);
    // Return safe defaults
    return {
      cpu: { percent: 0, cores: 0, model: 'Unknown' },
      memory: { percent: 0, usedGB: 0, totalGB: 0 },
      disk: { percent: 0, usedGB: 0, totalGB: 0 },
      timestamp: Date.now(),
    };
  }
}
