# Changelog

All notable changes to HexOps are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.0] - 2026-01-29

### Added
- Global Settings page at `/settings`
  - System paths configuration (projects root, logs, cache)
  - Git defaults (default branch, commit prefix, auto-push)
  - Vercel integration with token verification
- Per-project Settings section in project detail page
  - Environment variables, Node version, shell selection
  - Git behavior (auto-pull, commit template, preferred branch)
  - Deploy settings (Vercel project ID, auto-deploy branch)
  - Monitoring (health check URL, restart on crash, log retention)

### Changed
- Settings now require explicit save button (previously auto-saved on blur)
- Save/Discard buttons appear when unsaved changes exist

## [0.8.1] - 2026-01-29

### Added
- Static sidebar architecture (sidebar no longer reloads on navigation)
- Lightweight `/api/sidebar` endpoint for faster loading
- SidebarProvider context for shared sidebar data

### Fixed
- Double sidebar issue when opening shell from Dashboard
- Shell panel scrollbar overflow

## [0.8.0] - 2026-01-29

### Added
- Comprehensive logging system with JSON Lines format
- Log rotation (50MB per file, 100MB total cap)
- Logs dashboard page at `/logs` with filtering and search
- Live mode with 2-second polling
- Activity Log section in project detail page
- Dashboard link in sidebar

## [0.7.0] - 2026-01-29

### Added
- Patches dashboard defaults to grouped view
- User preferences persist to localStorage
- Inline commit UI after patches are applied
- Per-project git controls in patches view
- Patch row details panel with CVE badges and links

### Changed
- Patch log timestamps now show full date and time

### Fixed
- Git status property name mismatch in patches view
- Project cards no longer disappear after committing all patches
- Git status now fetched on page load for all projects

## [0.6.1] - 2026-01-28

### Fixed
- Git push/pull now show toast error messages instead of failing silently
- Added 30s timeout to patch scanner to prevent infinite loading
- Added jitter to cache TTL to prevent thundering herd
- Package Health section properly handles held packages

## [0.6.0] - 2026-01-25

### Added
- Shell Panel with integrated terminal (xterm.js + node-pty)
- System Health Dashboard with CPU, memory, disk gauges
- Sparkline history charts for metrics
- Custom Next.js server for WebSocket support
- `projectsRoot` configuration option

## [0.5.0] - 2026-01-20

### Added
- Unified patch data across all views
- Hold count tracking for held packages
- Dashboard badge dims when all packages are held

### Changed
- Extended-status now reads from patch-scanner cache

## [0.4.0] - 2026-01-19

### Added
- Patches page for vulnerability and outdated package management
- Priority queue sorted by severity
- Flat view and grouped-by-project view modes
- Batch update selected packages
- Package holds (skip problematic packages)
- Add/Edit projects from UI
- Transitive vulnerability info with dependency chains

## [0.3.0] - 2026-01-18

### Added
- Project detail page with cPanel-style control panel
- Git status and controls (branch, pull, push, dirty indicator)
- Vercel integration (detect linked projects, deploy)
- Performance metrics (uptime, memory, CPU, port, PID)
- Dual start mode (dev/prod)
- Utility actions (IDE, Terminal, Files, Browser)
- Collapsible sections for Logs, Project Info, Git, Package Health

## [0.2.0] - 2026-01-18

### Changed
- Refactored from card grid to row-based list layout
- Added right sidebar panel system

### Fixed
- Column alignment using CSS Grid with fixed widths

## [0.1.0] - 2026-01-16

### Added
- Initial release
- Card-based project grid with responsive columns
- Left sidebar with category/status filtering
- Project actions: Start, Stop, View Logs, Clear Cache, Delete Lock
- Process manager for spawning/killing dev servers
- Log streaming with auto-scroll
- Toast notifications
