# HexOps Logging System Design

**Date:** 2026-01-29
**Status:** Approved

## Overview

Comprehensive logging system for debugging, auditing, and monitoring all HexOps operations. Logs are stored in a single JSON log file with rotation, viewable both via CLI tools and an in-app dashboard.

## Requirements

- **Scope:** Full system logging (patches, projects, git, API, system events)
- **Output:** Both file-based logs and UI dashboard
- **Retention:** Indefinite with 100MB size cap, rotate oldest
- **Filtering:** By project, category, level, and full-text search

## Log File Structure

**Location:** `.hexops/logs/hexops.log`

**Format:** JSON Lines (one JSON object per line)

```json
{
  "ts": "2026-01-29T10:30:45.123Z",
  "level": "info",
  "category": "patches",
  "action": "package_updated",
  "message": "Updated next from 14.0.0 to 14.1.0",
  "projectId": "agent-forge",
  "meta": {
    "package": "next",
    "fromVersion": "14.0.0",
    "toVersion": "14.1.0",
    "duration": 3420
  }
}
```

### Log Levels

| Level | Use Case |
|-------|----------|
| `debug` | Verbose debugging info (disabled in production) |
| `info` | Normal operations (updates, starts, commits) |
| `warn` | Potential issues (vulnerabilities, deprecations) |
| `error` | Failures (API errors, crashes, failed updates) |

### Categories

| Category | Events |
|----------|--------|
| `patches` | Package updates, scans, vulnerabilities detected |
| `projects` | Start/stop, builds, config changes |
| `git` | Commits, pushes, branch operations |
| `api` | HTTP requests/responses, errors |
| `system` | App startup/shutdown, errors, metrics |

### Rotation

- Rotate when `hexops.log` exceeds 50MB
- Keep rotated files: `hexops.log.1`, `hexops.log.2`, etc.
- Delete oldest when total exceeds 100MB

## Logger Implementation

### Core Logger (`src/lib/logger.ts`)

```typescript
interface LogEntry {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  category: 'patches' | 'projects' | 'git' | 'api' | 'system';
  action: string;
  message: string;
  projectId?: string;
  meta?: Record<string, unknown>;
}

// Usage:
logger.info('patches', 'package_updated', 'Updated next', {
  projectId: 'agent-forge',
  meta: { package: 'next', fromVersion: '14.0.0', toVersion: '14.1.0' }
});
```

### Log Reader (`src/lib/log-reader.ts`)

```typescript
interface LogQuery {
  level?: string;
  category?: string;
  projectId?: string;
  search?: string;
  limit?: number;
  before?: string;  // For pagination
}

function readLogs(query: LogQuery): LogEntry[]
function streamLogs(query: LogQuery): AsyncGenerator<LogEntry>
```

## API Endpoints

### `GET /api/logs`

Query parameters:
- `level` - Filter by level (debug, info, warn, error)
- `category` - Filter by category
- `projectId` - Filter by project
- `search` - Full-text search
- `limit` - Max entries (default 100)
- `before` - Cursor for pagination (timestamp)
- `live` - SSE stream for real-time updates

### `GET /api/logs/stats`

Returns aggregate stats:
- Total entries
- Entries by level
- Entries by category
- File size

## Dashboard UI

### Global Logs Page (`/logs`)

```
┌─────────────────────────────────────────────────────────────────┐
│ Logs                                                    [Live ●] │
├─────────────────────────────────────────────────────────────────┤
│ Level: [All ▾]  Category: [All ▾]  Project: [All ▾]  [Search...] │
├─────────────────────────────────────────────────────────────────┤
│ 10:32:45 INFO  patches   agent-forge    Updated next 14.0→14.1  │
│ 10:32:41 INFO  git       agent-forge    Committed: chore(deps)  │
│ 10:30:12 WARN  patches   hexops         Vulnerability in lodash │
│ 10:28:55 INFO  projects  sailbot        Project started (pid 42)│
│ 10:28:01 ERROR api       —              POST /api/update failed │
│ ...                                                              │
├─────────────────────────────────────────────────────────────────┤
│ Showing 150 of 2,847 entries                      [Load More ▾] │
└─────────────────────────────────────────────────────────────────┘
```

### Features

- **Live mode** - Toggle auto-refresh (2s interval), new entries animate in
- **Filters** - Dropdowns for level, category, project
- **Search** - Full-text across message and metadata
- **Expand row** - Click to show full JSON metadata
- **Color coding** - Red=error, Yellow=warn, Gray=debug, White=info
- **Keyboard shortcuts** - `L` toggle live, `Esc` clear search

### Sidebar Integration

Add "Logs" link to sidebar navigation with icon, below "Patches"

### Project Details Integration

Add "Logs" tab to project detail modal/page, pre-filtered to that project

## Files to Create/Modify

### New Files
- `src/lib/logger.ts` - Core logger with file writing and rotation
- `src/lib/log-reader.ts` - Log reading and filtering
- `src/app/api/logs/route.ts` - Logs API endpoint
- `src/app/logs/page.tsx` - Logs dashboard page
- `src/components/log-viewer.tsx` - Reusable log viewer component

### Modified Files
- `src/components/sidebar.tsx` - Add Logs link
- `src/app/page.tsx` - Add Logs tab to project details
- Various API routes - Add logging calls throughout

## Implementation Order

1. Core logger with file writing and rotation
2. Log reader with filtering
3. API endpoint
4. Dashboard UI page
5. Sidebar link
6. Integrate logging into existing operations
7. Project details integration
