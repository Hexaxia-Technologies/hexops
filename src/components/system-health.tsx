'use client';

import { useState, useEffect, useCallback } from 'react';
import { RadialGauge } from './radial-gauge';
import { Sparkline } from './sparkline';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';

interface SystemMetrics {
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

interface PatchStatus {
  patched: number;
  unpatched: number;
  heldPackages: number;
  total: number;
}

interface SystemHealthProps {
  patchStatus?: PatchStatus;
}

const HISTORY_SIZE = 12; // 60 seconds at 5-second intervals
const POLL_INTERVAL = 5000; // 5 seconds

export function SystemHealth({ patchStatus }: SystemHealthProps) {
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const [memoryHistory, setMemoryHistory] = useState<number[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchMetrics = useCallback(async () => {
    try {
      const res = await fetch('/api/system/metrics');
      const data = await res.json();
      setMetrics(data);

      // Update history
      setCpuHistory(prev => {
        const next = [...prev, data.cpu.percent];
        return next.slice(-HISTORY_SIZE);
      });
      setMemoryHistory(prev => {
        const next = [...prev, data.memory.percent];
        return next.slice(-HISTORY_SIZE);
      });
    } catch (error) {
      console.error('Failed to fetch system metrics:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMetrics();
    const interval = setInterval(fetchMetrics, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchMetrics]);

  // Patch status pie chart data (just patched vs unpatched)
  const patchData = patchStatus ? [
    { name: 'Patched', value: patchStatus.patched, color: '#22c55e' },
    { name: 'Unpatched', value: patchStatus.unpatched, color: '#f97316' },
  ].filter(d => d.value > 0) : [];

  if (isLoading) {
    return (
      <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-4 mb-6">
        <div className="flex items-center justify-center h-32">
          <span className="text-zinc-500 text-sm">Loading system metrics...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-4 mb-6">
      <h3 className="text-sm font-medium text-zinc-400 mb-4">System Health</h3>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {/* CPU Gauge */}
        <div className="flex flex-col items-center p-2 bg-zinc-900 rounded-lg border border-zinc-800">
          <RadialGauge
            value={metrics?.cpu.percent ?? 0}
            label="CPU"
            subtitle={`${metrics?.cpu.cores ?? 0} cores`}
            size={120}
          />
          <div className="w-full mt-2 px-2">
            <Sparkline
              data={cpuHistory.length > 0 ? cpuHistory : [0]}
              color="#a855f7"
              height={24}
            />
          </div>
        </div>

        {/* Memory Gauge */}
        <div className="flex flex-col items-center p-2 bg-zinc-900 rounded-lg border border-zinc-800">
          <RadialGauge
            value={metrics?.memory.percent ?? 0}
            label="Memory"
            subtitle={`${metrics?.memory.usedGB ?? 0} / ${metrics?.memory.totalGB ?? 0} GB`}
            size={120}
          />
          <div className="w-full mt-2 px-2">
            <Sparkline
              data={memoryHistory.length > 0 ? memoryHistory : [0]}
              color="#3b82f6"
              height={24}
            />
          </div>
        </div>

        {/* Disk Gauge */}
        <div className="flex flex-col items-center p-2 bg-zinc-900 rounded-lg border border-zinc-800">
          <RadialGauge
            value={metrics?.disk.percent ?? 0}
            label="Disk"
            subtitle={`${metrics?.disk.usedGB ?? 0} / ${metrics?.disk.totalGB ?? 0} GB`}
            size={120}
          />
          <div className="w-full mt-2 px-2">
            <div className="h-6 flex items-center justify-center">
              <span className="text-[10px] text-zinc-600">stable</span>
            </div>
          </div>
        </div>

        {/* Patch Status Pie */}
        <div className="flex flex-col items-center p-2 bg-zinc-900 rounded-lg border border-zinc-800">
          <div className="h-[120px] w-full flex items-center justify-center">
            {patchData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={patchData}
                    cx="50%"
                    cy="50%"
                    innerRadius={30}
                    outerRadius={45}
                    paddingAngle={2}
                    dataKey="value"
                  >
                    {patchData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    content={({ active, payload }) => {
                      if (active && payload && payload.length) {
                        const data = payload[0].payload;
                        return (
                          <div className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs">
                            <span className="text-zinc-100">{data.name}: {data.value}</span>
                          </div>
                        );
                      }
                      return null;
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="text-zinc-500 text-sm">No data</div>
            )}
          </div>
          <p className="text-xs text-zinc-400 font-medium -mt-1">Patches</p>
          <p className="text-[10px] text-zinc-500">
            {patchStatus?.total ?? 0} projects
          </p>
          <div className="flex flex-col items-center gap-1 mt-2 text-[10px]">
            <div className="flex gap-3">
              {patchStatus && patchStatus.patched > 0 && (
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-green-500" />
                  {Math.round((patchStatus.patched / patchStatus.total) * 100)}%
                </span>
              )}
              {patchStatus && patchStatus.unpatched > 0 && (
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-orange-500" />
                  {Math.round((patchStatus.unpatched / patchStatus.total) * 100)}%
                </span>
              )}
            </div>
            {patchStatus && patchStatus.heldPackages > 0 && (
              <span className="text-zinc-500">
                {patchStatus.heldPackages} on hold
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
