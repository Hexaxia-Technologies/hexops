# HexOps Development Notes

**Current Version:** 0.4.0
**Purpose:** Internal development operations dashboard for managing Hexaxia project dev servers. Start/stop projects, view logs, manage patches, and monitor status from a single interface.

---

## Version History

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
├── Sidebar (left) - navigation, filters
├── main
│   ├── header - title, refresh button
│   └── ProjectList
│       └── ProjectRow[] - each project
└── RightSidebar - panels (logs, future: details)
    └── LogPanel - live log streaming
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
| Next.js | React framework, API routes | 16.1.2 |
| React | UI library | 19.2.3 |
| TypeScript | Type safety | ^5 |
| Tailwind CSS | Styling | ^4 |
| Framer Motion | Animations | ^12.26.2 |
| Radix UI | Accessible primitives (Dialog, ScrollArea) | Various |
| shadcn/ui | Component library (Button, Badge, Card) | N/A (copied) |
| Lucide React | Icons | ^0.562.0 |
| Sonner | Toast notifications | ^2.0.7 |
| pnpm | Package manager | Latest |

---

## Configuration

### hexops.config.json Structure

```json
{
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
- [ ] Keyboard shortcuts (j/k navigation, Enter to start)
- [x] Toast notifications for async operations
- [ ] Confirmation dialogs for destructive actions
- [ ] Log filtering and search
- [ ] Environment variable viewer
- [ ] Auto-update minor/patch dependencies on schedule
