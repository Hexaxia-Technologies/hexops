# HexOps Product Requirements Document

**Last Updated:** 2026-01-18
**Version:** 1.1

## Vision

HexOps is a "cPanel for local development" - a centralized dashboard to manage, monitor, and control all local dev servers from one interface.

## Current Features (v1.0)

### Dashboard
- Project list with sortable columns (name, category, port, status)
- Category filtering in left sidebar
- Status indicators (running/stopped)
- Quick actions (start, stop, view details)
- Real-time status updates via polling

### Project Detail Page
- **Control Panel Section:**
  - Project info (description, version, category, package manager, node version)
  - Git status and controls (branch, dirty indicator, pull/push)
  - Vercel integration (detect linked projects, deploy preview/production)
  - Performance metrics (uptime, memory, CPU, port status, PID)
  - Primary actions (Start, Stop, Restart)
  - Utility actions (Open IDE, Terminal, Files, Browser)
  - Cache tools (Clear .next, Delete Lock File)

- **Log Viewer:**
  - Live stdout/stderr streaming
  - Auto-scroll with manual override
  - Clear logs button
  - Collapsible section

---

## Backlog / Future Features

### High Priority

#### 1. Dual Start Modes (Dev/Production)
**Status:** Under consideration
**Rationale:** Let developers test production builds locally before deploying

**Implementation:**
- Primary "Start Dev" button runs `dev` script (current behavior)
- Secondary "Start Prod" button runs `build` then `start` scripts
- Only show "Start Prod" when both `build` and `start` scripts exist
- UI: Dropdown menu from Start button, or side-by-side buttons

**Considerations:**
- Production builds are slower
- Different ports may be needed
- Clear indication of which mode is running

#### 2. Toast Notifications
**Status:** Planned
**Rationale:** Provide feedback for async operations

**Implementation:**
- Add react-hot-toast or similar
- Show success/error toasts for:
  - Start/stop/restart operations
  - Git pull/push operations
  - Vercel deployments
  - Cache clear operations
- Include action context in messages

#### 3. Confirmation Dialogs
**Status:** Planned
**Rationale:** Prevent accidental destructive actions

**Implementation:**
- Add confirmation for:
  - Stopping a running server
  - Production deploys
  - Cache deletion
  - Lock file deletion
- Skip confirmation for non-destructive actions

#### 4. Loading Skeletons
**Status:** Planned
**Rationale:** Better perceived performance during data fetching

**Implementation:**
- Skeleton components for:
  - Project list rows
  - Control panel sections
  - Metrics cards
- Replace spinners with content-shaped placeholders

---

### Medium Priority

#### 5. Run Custom Scripts
**Status:** Planned
**Rationale:** Most projects have additional scripts (test, lint, build, etc.)

**Implementation:**
- Read all scripts from package.json
- Display in dropdown or expandable section
- Run scripts with output streaming
- Kill running scripts

#### 6. Environment Variable Viewer/Editor
**Status:** Planned
**Rationale:** Quick access to env configuration

**Implementation:**
- Read and display .env, .env.local, .env.development
- Show which vars are defined where
- Edit capability (v2)
- Restart prompt after changes

#### 7. Log Filtering/Search
**Status:** Planned
**Rationale:** Find specific log entries in verbose output

**Implementation:**
- Text search with highlighting
- Filter by log level (info/warn/error)
- Filter by timestamp range
- Export logs to file

#### 8. Dependency Health Dashboard
**Status:** Planned
**Rationale:** Proactive security and maintenance

**Implementation:**
- Run `pnpm outdated` on demand
- Run `pnpm audit` on demand
- Display CVE count with severity
- Link to advisory details
- Cache results with TTL

---

### Lower Priority / Nice-to-Have

#### 9. URL-Based Routing
**Status:** Backlog
**Rationale:** Bookmarkable project views

**Implementation:**
- Change from state-based to route-based navigation
- `/projects` for list view
- `/projects/[id]` for detail view

#### 10. Auto-Restart on Crash
**Status:** Backlog
**Rationale:** Keep dev servers running reliably

**Implementation:**
- Detect process exit
- Configurable auto-restart policy
- Max restart attempts
- Notification on crash

#### 11. Multi-Project Operations
**Status:** Backlog
**Rationale:** Batch operations for related projects

**Implementation:**
- Checkbox selection in list
- Bulk start/stop/restart
- Bulk git pull
- Project groups/tags

#### 12. Resource Graphs
**Status:** Backlog
**Rationale:** Historical view of resource usage

**Implementation:**
- Store metrics history (in-memory or SQLite)
- Line charts for memory/CPU over time
- Sparklines in list view

#### 13. Keyboard Shortcuts
**Status:** Backlog
**Rationale:** Power user efficiency

**Implementation:**
- `s` - Start selected project
- `x` - Stop selected project
- `r` - Restart
- `l` - Focus logs
- `b` - Open in browser
- Global shortcut help overlay

#### 14. Dark/Light Theme Toggle
**Status:** Backlog
**Rationale:** User preference

**Implementation:**
- Currently dark only
- Add theme toggle
- Persist preference
- System preference detection

---

## Technical Debt

- [ ] Add comprehensive error boundaries
- [ ] Improve TypeScript strictness
- [ ] Add unit tests for API routes
- [ ] Add E2E tests for critical flows
- [ ] Extract reusable components (badges, buttons)
- [ ] Consider state management library (Zustand)

---

## Non-Goals (Out of Scope)

- Remote server management
- Docker container management (separate tool)
- Database management
- Cloud deployment (beyond Vercel CLI passthrough)
- Team collaboration features

---

## Architecture Notes

### Tech Stack
- Next.js 16.1.2 with App Router
- React 19
- Tailwind CSS 4
- TypeScript 5

### Key Patterns
- Server-side config loading via JSON
- Child process management for dev servers
- Port-based status detection with `ss` command
- Process metrics via `ps` command
- Polling for real-time updates (5s intervals)

### File Structure
```
src/
  app/
    api/projects/[id]/        # Project-specific endpoints
    page.tsx                  # Main dashboard
  components/
    project-detail.tsx        # Detail page
    project-table.tsx         # List view
  lib/
    config.ts                 # Config loading
    process-manager.ts        # Process lifecycle
    port-checker.ts           # Port status
    types.ts                  # TypeScript interfaces
```
