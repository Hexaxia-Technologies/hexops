'use client';

import dynamic from 'next/dynamic';

// Dynamically import ApexCharts to avoid SSR issues
const Chart = dynamic(() => import('react-apexcharts'), { ssr: false });

interface RadialGaugeProps {
  value: number;
  label: string;
  subtitle?: string;
  size?: number;
}

function getColor(value: number): string {
  if (value < 60) return '#22c55e'; // green
  if (value < 80) return '#eab308'; // yellow
  return '#ef4444'; // red
}

export function RadialGauge({ value, label, subtitle, size = 140 }: RadialGaugeProps) {
  const color = getColor(value);

  const options: ApexCharts.ApexOptions = {
    chart: {
      type: 'radialBar',
      sparkline: {
        enabled: true,
      },
      animations: {
        enabled: true,
        speed: 800,
        dynamicAnimation: {
          enabled: true,
          speed: 350,
        },
      },
    },
    plotOptions: {
      radialBar: {
        startAngle: -135,
        endAngle: 135,
        hollow: {
          size: '60%',
        },
        track: {
          background: '#27272a',
          strokeWidth: '100%',
        },
        dataLabels: {
          name: {
            show: true,
            fontSize: '12px',
            fontFamily: 'inherit',
            fontWeight: 500,
            color: '#a1a1aa',
            offsetY: 20,
          },
          value: {
            show: true,
            fontSize: '24px',
            fontFamily: 'ui-monospace, monospace',
            fontWeight: 700,
            color: '#fafafa',
            offsetY: -10,
            formatter: (val: number) => `${Math.round(val)}%`,
          },
        },
      },
    },
    fill: {
      type: 'solid',
      colors: [color],
    },
    stroke: {
      lineCap: 'round',
    },
    labels: [label],
  };

  return (
    <div className="flex flex-col items-center">
      <Chart
        options={options}
        series={[value]}
        type="radialBar"
        height={size}
        width={size}
      />
      {subtitle && (
        <p className="text-xs text-zinc-500 -mt-2">{subtitle}</p>
      )}
    </div>
  );
}
