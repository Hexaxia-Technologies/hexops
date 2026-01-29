# HexOps Development Notes

**Current Version:** 0.8.0
**Purpose:** Internal development operations dashboard for managing Hexaxia project dev servers. Start/stop projects, view logs, manage patches, and monitor status from a single interface.

---

## Version History

### v0.8.0 (2026-01-29)
- **Feature:** Comprehensive logging system for debugging, auditing, and monitoring
  - JSON Lines log file format (one JSON object per line)
  - Log levels: debug, info, warn, error
  - Log categories: patches, projects, git, api, system
  - Automatic log rotation: 50MB per file, 100MB total cap (keeps 2 files max)
  - Logs stored in `.hexops/logs/system.log` (and `.1` for rotated)
- **Feature:** Logs dashboard page (`/logs`)
  - Filterable by level, category, project
  - Search across all log entries
  - Live mode with 2-second polling
  - Expandable rows to show full metadata/details
  - Load more pagination (100 entries at a time)
- **Feature:** Activity Log section in project detail page
  - Shows project-specific logs filtered by projectId
  - Reusable LogViewer component with configurable filters
- **Feature:** Dashboard link added to sidebar
  - Navigation order: Dashboard → Patches → Logs → Shell
  - Provides clear navigation back to main view from any page
- **Integration:** Logging added to existing operations
  - Project start/stop operations
  - Git commit/push operations
  - Package update operations

### v0.7.0 (2026-01-29)
- **Feature:** Patches dashboard now defaults to grouped view
- **Feature:** User preferences (view mode, show unfixable, show held) persist to localStorage
  - Key: `hexops-patches-preferences`
  - Filters (category, type) reset each session intentionally
- **Feature:** Rearranged project card header in grouped view
  - Select All moved to left (after patch count)
  - External link icon to jump to project details page
  - Git controls (Commit/Push) added on far right
- **Feature:** Inline commit UI after patches are applied
  - Shows summary of updated packages with security fixes highlighted
  - Auto-generated commit message in conventional format
  - Editable commit message via Edit button
  - Dismiss to clear without committing
- **Feature:** Per-project git controls in patches view
  - Commit button enabled when uncommitted patch changes exist
  - Push button shows ahead count (e.g., "Push (1↑)")
  - Loading states during commit/push operations
- **Feature:** Patch row details panel
  - Click info (?) icon to expand detailed information
  - Shows package type, severity, version details, dependency type
  - CVE badges with count when vulnerabilities have CVEs
  - Clickable CVE links to NVD (nvd.nist.gov)
  - Advisory links to npm/GitHub when available
- **UX:** Patch log timestamps now show full date and time (YYYY-MM-DD HH:MM:SS)
  - Changed from relative time (x hrs ago) to absolute format for sysadmin/devops needs
- **Fix:** Git status property name mismatch in patches view
  - API returned `isDirty`/`aheadCount`/`behindCount` but client parsed `dirty`/`ahead`/`behind`
  - Caused git controls to always show as disabled
- **Fix:** Project cards no longer disappear after committing all patches
  - Grouped view now shows ALL projects regardless of patch count
  - Uses `projectNames` map from API to ensure projects remain visible
- **Fix:** Git status now fetched on page load for all projects
  - Previously only fetched when expanding a project card

### v0.6.1 (2026-01-28)
- **Fix:** Git push/pull now show toast error messages instead of silently failing
  - Previously `handleGitPush` and `handleGitPull` had `// Silently fail` error handling
  - Now displays actual error message (e.g., "Write access to repository not granted")
  - Also shows success toast on successful push/pull
- **Fix:** Add 30s timeout to patch scanner exec calls to prevent infinite loading
  - `pnpm outdated` and `pnpm audit` commands could hang indefinitely
  - If any command hung, the entire `/api/patches` request would hang
- **Fix:** Add jitter to cache TTL to prevent thundering herd
  - All caches had same 1-hour TTL, expiring together and causing 20 simultaneous scans
  - Now uses 1 hour base + 0-15 min random jitter so caches expire gradually
- **Fix:** Package Health section now properly handles held packages
  - Badge shows gray "N outdated (held)" when all outdated packages are on hold
  - Selection actions (Select All, Update) hidden when all outdated packages are held
  - Previously showed yellow "N outdated" badge even when all were held (e.g., alyfe-v3 with only tailwindcss outdated and held)

### v0.6.0 (2026-01-25)
- **Shell Panel** - Integrated terminal in the right sidebar
  - Opens from sidebar (uses `projectsRoot` config) or project detail (uses project path)
  - Real PTY shell via node-pty with full terminal emulation
  - xterm.js for terminal rendering with proper colors and cursor
  - WebSocket connection for real-time I/O
  - Reconnect button when connection drops
- **System Health Dashboard** - Real-time system metrics on main dashboard
  - CPU, Memory, Disk radial gauges with color-coded thresholds
  - Sparkline history charts for CPU and Memory (60 seconds)
  - Patch status pie chart showing patched vs unpatched projects
  - 5-second polling interval
- **Custom Next.js Server** - Required for WebSocket support
  - `server.js` handles both HTTP and WebSocket connections
  - Uses `app.getUpgradeHandler()` to properly route Next.js HMR
  - Shell WebSocket at `/api/shell/ws`
- **Configuration** - Added `projectsRoot` to config for default shell directory

### v0.5.0 (2026-01-20)
- **Unified Patch Data** - Single source of truth for all patch/outdated data
  - Extended-status now reads from patch-scanner cache (no more dual systems)
  - Dashboard, detail page, and patches page all show consistent counts
  - Removed hexops self-exclusion (works fine in dev mode with hot reload)
- **Hold Support Across All Views**
  - Added `heldCount` to track how many outdated packages are held
  - Dashboard badge dims (gray) when all outdated packages are held
  - Package Health section shows "HELD" badge on held packages
  - Held packages disabled from selection/update in Package Health
  - "Select All" excludes held packages

### v0.4.0 (2026-01-19)
- **Patches Page** - Centralized vulnerability and outdated package management
  - Scan all projects for outdated packages (`pnpm outdated`) and vulnerabilities (`pnpm audit`)
  - Priority queue sorted by severity (critical > high > moderate > major > minor > patch)
  - Flat view and grouped-by-project view modes
  - Batch update selected packages across projects
  - Category filtering via left sidebar
  - Right sidebar shows update progress and history
- **Package Holds** - Skip problematic packages during updates
  - Per-project holds stored in config
  - Hold/unhold via pause/play icons
  - Held packages dimmed, excluded from selection
  - "On Hold" filter toggle to show/hide
- **Add/Edit Projects** - Manage projects from UI
  - Add project dialog with path scanning
  - Edit existing project configurations
  - Save changes to hexops.config.json
- **Transitive Vulnerability Info** - Shows dependency chain for unfixable vulns
  - `via` chain showing which direct dependency pulls in the vulnerable package
  - Indicator when parent package needs to update its dependencies

### v0.3.0 (2026-01-18)
- **Project Detail Page** - cPanel-style control panel for individual projects
- **Control Panel** with sections:
  - Project info (description, version, category, package manager, node version)
  - Git status and controls (branch, pull, push, dirty indicator)
  - Vercel integration (detect linked projects, deploy preview/production)
  - Performance metrics (uptime, memory, CPU, port status, PID)
  - Dual start mode (dev/prod) with dropdown when build+start scripts exist
  - Utility actions (IDE, Terminal, Files, Browser)
  - Cache tools (Clear .next, Delete Lock)
- **Collapsible sections**: Logs, Project Info, Git, Package Health
- Metrics now detect PID from port using `ss` command for externally started processes
- Added PRD document with feature roadmap

### v0.2.0 (2026-01-18)
- Refactored from card grid layout to row-based list layout
- Added right sidebar panel system (currently hosts log viewer)
- Fixed column alignment using CSS Grid with fixed widths
- Added column headers to project list
- Icons now always render (grayed out when inactive) for consistent spacing
- Added AnimatePresence for smooth sidebar transitions

### v0.1.0 (2026-01-16)
- Initial project creation with Create Next App
- Card-based project grid with responsive columns
- Left sidebar with category/status filtering
- Project actions: Start, Stop, View Logs, Clear Cache, Delete Lock
- Process manager for spawning/killing dev servers
- Log streaming with auto-scroll
- Toast notifications for action feedback

---

## Recent Changes

### Logging System (v0.8.0)

**Summary:** Added comprehensive file-based logging with UI dashboard. Logs all system operations with rotation to prevent disk bloat.

| File | Change |
|------|--------|
| `src/lib/logger.ts` | New - Core logger with JSON Lines format, file writing, rotation |
| `src/lib/log-reader.ts` | New - Log reading with filtering, search, pagination |
| `src/app/api/logs/route.ts` | New - API endpoint for log queries |
| `src/app/logs/page.tsx` | New - Logs dashboard page |
| `src/components/log-viewer.tsx` | New - Reusable log viewer with filters, live mode |
| `src/components/ui/select.tsx` | New - Radix UI Select component for dropdowns |
| `src/components/detail-sections/system-logs-section.tsx` | New - Activity Log section for project detail |
| `src/components/project-detail.tsx` | Added Activity Log collapsible section |
| `src/components/sidebar.tsx` | Added Dashboard and Logs links |
| `src/app/api/projects/[id]/start/route.ts` | Added logging for start operations |
| `src/app/api/projects/[id]/stop/route.ts` | Added logging for stop operations |
| `src/app/api/projects/[id]/git-commit/route.ts` | Added logging for commit operations |
| `src/app/api/projects/[id]/git-push/route.ts` | Added logging for push operations |
| `src/app/api/projects/[id]/update/route.ts` | Added logging for package updates |

**Key Insights:**
- JSON Lines format (one JSON object per line) is ideal for append-only logs - easy to parse, stream, and rotate
- Log rotation checks file size before each write; rotates when exceeding 50MB threshold
- Keeping only 2 files (current + 1 rotated) with 50MB each caps total at ~100MB
- Radix UI Select component requires careful styling to match existing UI theme

---

### Shell Panel & System Health (v0.6.0)

**Summary:** Added integrated terminal and system monitoring. Required custom Next.js server for WebSocket support.

| File | Change |
|------|--------|
| `server.js` | New - Custom Next.js server with WebSocket handling |
| `src/components/shell-panel.tsx` | New - xterm.js terminal component |
| `src/components/system-health.tsx` | New - System metrics dashboard |
| `src/components/radial-gauge.tsx` | New - Circular gauge component |
| `src/components/sparkline.tsx` | New - Mini line chart component |
| `src/app/api/system/metrics/route.ts` | New - CPU/memory/disk metrics endpoint |
| `src/app/api/config/route.ts` | New - Config endpoint for projectsRoot |
| `src/lib/system-metrics.ts` | New - System metrics collection |
| `src/lib/types.ts` | Added `projectsRoot` to HexOpsConfig |
| `src/lib/config.ts` | Added `getProjectsRoot()` function |
| `src/components/right-sidebar.tsx` | Added shell panel type |
| `src/components/sidebar.tsx` | Added Shell button |
| `src/app/page.tsx` | Added handleOpenShell, projectsRoot state |
| `public/xterm.css` | Copied from @xterm/xterm for terminal styling |
| `.npmrc` | Added node-linker=hoisted for node-pty |
| `package.json` | Changed dev script to use custom server |

**Key Insights:**
- node-pty requires native compilation; pnpm's default linking breaks it. Fixed with `node-linker=hoisted` in `.npmrc`
- xterm.js CSS can't be imported directly in Next.js client components - must load via public folder
- Custom Next.js server must use `app.getUpgradeHandler()` to properly handle HMR WebSocket, otherwise causes periodic page refreshes
- React StrictMode double-mounts components in dev, which can cause WebSocket connect/disconnect cycles

---

### Unified Patch Data & Hold Support (v0.5.0)

**Summary:** Eliminated dual patch systems that caused inconsistent counts between views. Now all views (dashboard, detail, patches) read from a single cache. Added full hold support across all views.

| File | Change |
|------|--------|
| `src/lib/extended-status.ts` | Reads from patch-scanner cache instead of running own `pnpm outdated` |
| `src/lib/types.ts` | Added `heldCount` to `ProjectExtendedStatus.packages` |
| `src/app/api/patches/route.ts` | Removed hexops exclusion |
| `src/app/api/patches/scan/route.ts` | Removed hexops exclusion |
| `src/components/project-row.tsx` | Dashboard badge dims when all packages are held |
| `src/components/project-detail.tsx` | Passes `holds` to PackageHealthSection |
| `src/components/detail-sections/package-health-section.tsx` | Shows HELD badge, disables selection for held packages |

**Key Insights:**
- Two systems were fighting: extended-status (5-min cache) vs patch-scanner (1-hr cache)
- hexops exclusion ("can't patch itself") was overly cautious - dev mode hot reload handles it fine
- Hold status should be display-layer, not filtering - show held packages but disable actions

---

### Project Detail Page & Control Panel (v0.3.0)

**Summary:** Added comprehensive project detail page with cPanel-style control panel. Consolidates all project management actions and status info in one view.

| File | Change |
|------|--------|
| `src/components/project-detail.tsx` | New - Main detail page with control panel |
| `src/components/detail-sections/*.tsx` | New - Collapsible sections (logs, info, git, health) |
| `src/app/api/projects/[id]/info/route.ts` | New - Package.json info endpoint |
| `src/app/api/projects/[id]/git/route.ts` | New - Git status endpoint |
| `src/app/api/projects/[id]/git-pull/route.ts` | New - Git pull action |
| `src/app/api/projects/[id]/git-push/route.ts` | New - Git push action |
| `src/app/api/projects/[id]/metrics/route.ts` | New - Process metrics with PID detection |
| `src/app/api/projects/[id]/vercel/route.ts` | New - Vercel status and deploy |
| `src/lib/process-manager.ts` | Added StartMode, production build support |
| `src/lib/types.ts` | Added description field to ProjectConfig |
| `docs/PRD.md` | New - Product requirements and roadmap |

**Key Insights:**
- Use `ss -tlnp sport = :PORT` to detect PID from port (works without sudo, unlike lsof)
- Production mode runs build synchronously before spawning start script
- Vercel CLI integration via `vercel ls --json` and `vercel --prod --yes`
- Dropdown menus need click-outside handlers via useRef + useEffect

---

### Row Layout & Right Sidebar (v0.2.0)

**Summary:** Replaced card grid with a row-based list for better scanning. Added extensible right sidebar for panels (logs first, more to come).

| File | Change |
|------|--------|
| `src/components/project-row.tsx` | New - horizontal row component with CSS Grid layout |
| `src/components/project-list.tsx` | New - vertical list container with sticky header |
| `src/components/right-sidebar.tsx` | New - animated panel container, hosts LogPanel |
| `src/components/project-card.tsx` | Deprecated - replaced by project-row |
| `src/components/project-grid.tsx` | Deprecated - replaced by project-list |
| `src/app/page.tsx` | Updated layout for 3-column structure, added AnimatePresence |

**Key Insights:**
- CSS Grid (`grid-cols-[24px_1fr_80px_64px_200px]`) is better than flexbox for table-like layouts - ensures columns stay aligned regardless of content
- Always-render pattern for optional icons: render but style as invisible (`text-zinc-700`) to maintain layout consistency
- Framer Motion width animations are tricky in flex containers; x-translate with fixed width is more reliable
- `flex-shrink-0` is essential on sidebars to prevent compression

---

## Architecture Patterns

### Data Flow

```
hexops.config.json → API routes → React state → Components
       ↓
   Project paths → Process Manager → Child processes (dev servers)
       ↓
   .hexops/logs/ → Log API → LogPanel component
```

### Component Hierarchy

```
page.tsx
├── Sidebar (left) - navigation, filters, shell button
├── main
│   ├── header - title, refresh button
│   ├── SystemHealth - CPU/memory/disk gauges, patch status
│   └── ProjectList
│       └── ProjectRow[] - each project
└── RightSidebar - panels
    ├── LogPanel - live log streaming
    ├── PackageHealthPanel - outdated/audit output
    └── ShellPanel - integrated terminal (xterm.js)
```

### State Management

- **Local React state** - No external state library needed at this scale
- `projects[]` - All project configs with runtime status
- `selectedProjectId` - Currently highlighted row
- `rightPanel` - Discriminated union: `{ type: 'logs', projectId } | null`
- `selectedCategory` - Filter state for left sidebar

### API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/projects` | GET | List all projects with status |
| `/api/projects/[id]/start` | POST | Start dev server (accepts `mode: 'dev' \| 'prod'`) |
| `/api/projects/[id]/stop` | POST | Stop dev server |
| `/api/projects/[id]/logs` | GET | Get recent log entries |
| `/api/projects/[id]/clear-cache` | POST | Delete .next directory |
| `/api/projects/[id]/delete-lock` | POST | Remove lock files |
| `/api/projects/[id]/info` | GET | Package.json info, node version, package manager |
| `/api/projects/[id]/git` | GET | Git status (branch, dirty, last commit) |
| `/api/projects/[id]/git-pull` | POST | Execute git pull |
| `/api/projects/[id]/git-push` | POST | Execute git push |
| `/api/projects/[id]/metrics` | GET | Process metrics (PID, uptime, memory, CPU, port) |
| `/api/projects/[id]/vercel` | GET | Vercel project status and latest deployment |
| `/api/projects/[id]/vercel` | POST | Deploy to Vercel (accepts `production: boolean`) |
| `/api/projects/[id]/outdated` | GET | Run pnpm outdated |
| `/api/projects/[id]/audit` | GET | Run pnpm audit |
| `/api/projects/[id]/update` | POST | Update specific packages |
| `/api/projects/[id]/holds` | GET/POST/DELETE | Manage package holds |
| `/api/projects/save` | POST | Save project config changes |
| `/api/projects/scan-path` | POST | Scan path for project info |
| `/api/patches` | GET | Get all patches across projects |
| `/api/patches/scan` | POST | Force rescan all projects |
| `/api/patches/history` | GET | Get patch update history |
| `/api/system/metrics` | GET | System CPU, memory, disk metrics |
| `/api/config` | GET | Get config (projectsRoot) |
| `/api/shell/ws` | WS | WebSocket for shell terminal |
| `/api/logs` | GET | Query system logs with filters (level, category, project, search) |

### Process Management

- Uses Node.js `child_process.spawn()` for dev servers
- PIDs tracked in memory (ProcessManager singleton)
- Logs written to `.hexops/logs/{projectId}.log`
- Graceful shutdown with SIGTERM, fallback to SIGKILL

---

## Common Issues & Solutions

### Column Alignment Shifts
**Problem:** Columns misalign when content differs (e.g., running vs stopped projects)
**Solution:** Use CSS Grid with fixed column widths. Always render all elements, use opacity/color to hide inactive ones.

### Right Sidebar Not Appearing
**Problem:** Width animation from 0 doesn't work well in flex containers
**Solution:** Use fixed width (`w-[400px]`) with x-translate animation instead. Add `flex-shrink-0` to prevent compression.

### Framer Motion Exit Animations Not Working
**Problem:** Components disappear instantly without exit animation
**Solution:** Wrap conditional renders in `<AnimatePresence>` at the parent level, ensure `key` prop is set on animated elements.

### Port Already in Use
**Problem:** Project won't start because port is occupied
**Solution:** Check `.hexops/logs/` for orphaned processes. Use `lsof -i :PORT` to find and kill. Consider adding port-check before start.

### Stale Process State
**Problem:** UI shows "running" but dev server crashed
**Solution:** Refresh fetches fresh status every 5 seconds. Could add health checks in future.

---

## Tech Stack Reference

| Technology | Purpose | Version |
|------------|---------|---------|
| Next.js | React framework, API routes | 16.1.3 |
| React | UI library | 19.2.3 |
| TypeScript | Type safety | ^5 |
| Tailwind CSS | Styling | ^4 |
| Framer Motion | Animations | ^12.26.2 |
| Radix UI | Accessible primitives (Dialog, ScrollArea) | Various |
| shadcn/ui | Component library (Button, Badge, Card) | N/A (copied) |
| Lucide React | Icons | ^0.562.0 |
| Sonner | Toast notifications | ^2.0.7 |
| Recharts | Charts (pie, sparklines) | ^2.15.3 |
| xterm.js | Terminal emulator | @xterm/xterm |
| node-pty | PTY shell spawning | ^1.0.0 |
| ws | WebSocket server | ^8.18.0 |
| pnpm | Package manager | Latest |

---

## Configuration

### hexops.config.json Structure

```json
{
  "projectsRoot": "/home/user/Projects",  // Default shell directory
  "projects": [
    {
      "id": "project-id",
      "name": "Display Name",
      "path": "/absolute/path/to/project",
      "port": 3000,
      "category": "Product|Client|Internal|Personal",
      "description": "Optional project description",
      "scripts": {
        "dev": "pnpm dev",
        "build": "pnpm build"
      },
      "holds": ["package-name"]  // Optional: packages to skip during updates
    }
  ],
  "categories": ["Product", "Client", "Internal", "Personal"]
}
```

### Adding a New Project

1. Add entry to `hexops.config.json`
2. Ensure unique port number (check existing assignments)
3. Verify path exists and has valid package.json
4. Refresh HexOps UI

---

## Future Considerations

- [ ] Project health checks (ping endpoints)
- [x] Dependency vulnerability scanning (pnpm audit integration added)
- [x] Patches page with batch updates
- [x] Package holds (skip problematic packages)
- [ ] Batch operations (start all, stop all)
- [x] Project details panel (full detail page with control panel)
- [x] Git status integration (branch, dirty, pull/push)
- [x] Build/deploy triggers (Vercel deploy, dual start mode)
- [x] Add/Edit projects from UI
- [x] Integrated terminal (shell panel with xterm.js)
- [x] System health monitoring (CPU, memory, disk gauges)
- [ ] Keyboard shortcuts (j/k navigation, Enter to start)
- [x] Toast notifications for async operations
- [ ] Confirmation dialogs for destructive actions
- [x] Log filtering and search (logging system with dashboard)
- [ ] Environment variable viewer
- [ ] Auto-update minor/patch dependencies on schedule
- [ ] Enhanced patch error logging - show actual error message/output when patches fail, not just red indicator
- [ ] Handle deprecated packages - currently shown as "outdated" but can't be updated (e.g., @types/dompurify). Should detect "Latest: Deprecated" and suggest removal instead of update
