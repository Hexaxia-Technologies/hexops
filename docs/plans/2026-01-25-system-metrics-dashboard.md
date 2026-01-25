# System Metrics Dashboard Design

**Date:** 2026-01-25
**Status:** Approved

## Overview

Add a system health metrics panel to the hexops dashboard showing CPU, memory, disk usage, and patch status at a glance. Uses Recharts for sparklines and ApexCharts for radial gauges.

## Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ Sidebar │              Main Content                   │ Right Sidebar│
│         │  ┌──────────────────────────────────────┐   │              │
│         │  │         SYSTEM HEALTH (NEW)          │   │              │
│         │  │ [CPU] [Memory] [Disk] [Patch Status] │   │              │
│         │  │  + sparklines                        │   │              │
│         │  └──────────────────────────────────────┘   │              │
│         │  ┌──────────────────────────────────────┐   │              │
│         │  │      EXISTING PROJECT LIST           │   │              │
│         │  │      (unchanged)                     │   │              │
│         │  └──────────────────────────────────────┘   │              │
└──────────────────────────────────────────────────────────────────────┘
```

## System Health Component

Four panels in a horizontal bar:

| Panel | Type | Data |
|-------|------|------|
| CPU | Radial gauge + sparkline | Percentage, cores, 60s history |
| Memory | Radial gauge + sparkline | Percentage, used/total GB, 60s history |
| Disk | Radial gauge + sparkline | Percentage, used/total GB |
| Patch Status | Pie chart | % Patched, % Unpatched, % Held |

### Color Coding (Gauges)
- Green: < 60%
- Yellow: 60-80%
- Red: > 80%

### Patch Status Pie
- **Green (Patched):** Projects with no outstanding updates or vulnerabilities
- **Orange (Unpatched):** Projects with pending patches (updates or vulns)
- **Gray (Held):** Projects where all pending patches are on hold

## API Design

### `GET /api/system/metrics`

```json
{
  "cpu": {
    "percent": 45,
    "cores": 8,
    "idle": 4.4
  },
  "memory": {
    "percent": 68,
    "usedGB": 5.2,
    "totalGB": 16
  },
  "disk": {
    "percent": 23,
    "usedGB": 120,
    "totalGB": 512
  },
  "timestamp": 1706198400000
}
```

**Implementation:** Uses Node.js `os` module for CPU/memory, `df` command for disk.

**Polling:** Frontend calls every 5 seconds, stores 12 data points for 60-second sparkline history.

## Dependencies

```json
{
  "recharts": "^3.7.0",
  "react-apexcharts": "^1.6.0",
  "apexcharts": "^4.3.0"
}
```

## File Structure

```
src/
├── app/
│   └── api/
│       └── system/
│           └── metrics/
│               └── route.ts        # System metrics endpoint
├── components/
│   ├── ui/
│   │   └── chart.tsx               # shadcn chart wrapper
│   ├── system-health.tsx           # Main health bar component
│   ├── radial-gauge.tsx            # ApexCharts gauge wrapper
│   └── sparkline.tsx               # Recharts mini line chart
└── lib/
    └── system-metrics.ts           # CPU/memory/disk collection logic
```

## Integration

Add `<SystemHealth />` component to `src/app/page.tsx` above the existing `<ProjectList />`.

---

## Future UI/UX Notes

**Patches inconsistency:** The standalone `/patches` page and the project detail patches section have different designs. These should be unified - detail view patching should match the main patches page style.

---

## Open Source Considerations

All libraries chosen are MIT licensed and suitable for open source release:
- Recharts (MIT)
- ApexCharts (MIT)
- shadcn/ui (MIT)
