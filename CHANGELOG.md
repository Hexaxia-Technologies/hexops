# Changelog

All notable changes to HexOps are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.21.0] - 2026-08-10

### Added
- **Override hygiene scanning** — `OverrideHygieneSource` runs cve-lite's `overrides` subcommand (rules OA001–OA009) as a fifth `ScanSource`, surfacing override-configuration defects as `config` findings on the fleet security view: orphaned targets, floating tags, wrong package-manager section, surpassed pins, nested ineffective overrides, and stale floors.
- **Override hygiene panel** on the per-project security view — rule id, severity, package, `file > jsonPath` location, and the runnable fix command for each finding, with a confirm-gated "Fix all" control.
- `GET /api/security/overrides/[id]` — cached override audit (1h TTL), `?force` bypasses.
- `POST /api/security/overrides/[id]/fix` — runs `cve-lite overrides --fix`, optionally scoped to a single OA rule. Gated by the new `OVERRIDE_HYGIENE_FIX_ENABLED` flag, which ships **disabled** and is enforced server-side with a 409 before any project lookup, so a stale browser tab cannot bypass it. The fix runs an install and is wrapped in the dev-server guard (#109).
- **Partial-scan reporting** — `scanCompleteness()` distinguishes a genuinely clean scan from one that could not check everything. An incomplete scan raises a warning banner naming the unresolved advisories and skipped dependencies, and marks the source degraded on the fleet cards, so it can no longer read as a green all-clear.
- `ScanSource.scan` now returns `{ findings, warning? }`, wiring the previously declared-but-unused `SourceResult.warning` end to end and rendering it on the source card.

### Changed
- `cve-lite-cli` 1.24.0 → 1.28.0.
- Scan cache entries record the resolved `cve-lite-cli` version; a mismatch is treated as a miss, so a dependency bump invalidates stale reports immediately instead of letting them age out over the TTL. This also closes the stale-fallback path, which could otherwise resurrect a pre-bump report when a scan fails.
- `json-cache.ts` is now the single namespaced cache implementation; `cve-lite-cache.ts` is a thin wrapper over it, preserving its own public API and on-disk filenames.
- cve-lite's phantom-dependency rules (PD001/PD002) are excluded from override-hygiene findings — `DependencyHealthSource` (#125) remains the single phantom-dep authority, and it models workspace boundaries correctly where cve-lite currently does not.

### Fixed
- Parent-upgrade confidence badges no longer render gray for every finding — cve-lite 1.28 renamed the `confidence` values from `exact-direct-child`/`best-effort` to `verified`/`unverified`, and the badge colour map still keyed on the old strings.
- Unverified parent-upgrade recommendations are now visually distinct from verified ones, rather than being presented as equally trustworthy. 1.28 only recommends a parent upgrade it has proven resolves the vulnerable package.
- A cache entry with a corrupt `cachedAt` is no longer served as fresh — a non-finite age is now a cache miss (previously `NaN > ttl` evaluated false).
- Override findings that share a rule id and message text no longer collapse into one in the merger; the `jsonPath` is folded into the finding path so each override entry stays distinct.

### Security
- **next 16.2.10 → 16.3.0** — clears 9 advisories, 4 of them high: middleware/proxy bypass in App Router with Turbopack and a single locale (GHSA-6gpp-xcg3-4w24), SSRF in Server Actions on custom servers (GHSA-89xv-2m56-2m9x), SSRF via attacker-controlled rewrite destination hostname (GHSA-p9j2-gv94-2wf4), and denial of service in App Router Server Actions (GHSA-m99w-x7hq-7vfj). 16.3.0 was chosen over the 16.2.11 minimum because it also resolves the `next → postcss` path.
- **postcss override floor `^8.5.15` → `^8.5.23`** — the previous floor resolved to 8.5.16, still exposed to path traversal via `sourceMappingURL` auto-loading (GHSA-r28c-9q8g-f849) and GHSA-fxqj-rqcc-2cmp. Now resolves 8.5.26. The override is flat, so it also covers the `@tailwindcss/postcss → postcss` path the next upgrade alone does not reach.
- `nanoid` and `sharp` advisories cleared as a side effect of the next upgrade.

---

## [0.20.1] - 2026-05-21

### Performance
- **Batch patching** — all packages for a project are now sent in a single `/update` call instead of one call per package. Eliminates N-1 redundant lockfile reconciliation installs, post-patch audits, and project rescans. A 10-package batch that previously triggered 10 sequential npm installs now triggers one (#98).

### Fixed
- Push button in Patches shows accurate ahead count — git route now runs `git fetch origin` before `rev-list` so `@{u}` resolves against the real remote state instead of a stale local tracking ref (#100).

### Changed
- Patches update status: single-project batches show an indeterminate pulsing bar + package count; multi-project batches show a per-project step counter ("project 1 of 3").
- Push button no longer shows a `↑` arrow suffix that rendered ambiguously alongside the count.

---

## [0.20.0] - 2026-05-21

### Added
- **CVE Lite dashboard** — OSV-backed per-project CVE triage powered by `cve-lite-cli`. Per-project scan with severity filters, fix plan table, and SBOM (CycloneDX) / SARIF export. Apply fixes directly or route through the patch pipeline.
- **Grype integration** — `GrypeSource` pulls container and filesystem vulnerability data alongside `pnpm audit`. Grype-confirmed chip surfaces on vulnerability rows; confirmed packages are unioned into `stillVulnerablePackages` for post-patch verification (#80).
- **Three-source security stack** — `PnpmAuditSource` + `GrypeSource` + `CveLiteSource` behind a unified `ScanSource` interface. Per-source timeouts, mutex-guarded atomic cache writes, severity reconciliation, and divergence flagging across sources.
- **Security page** (`/security`) — fleet-wide findings view with project selector, severity/source filters, rescan trigger, source badges, and divergence indicators.
- **Concurrent patch scanning** — `mapWithConcurrency` bounded worker-pool (limit 5) replaces serial scan loop. SSE progress events fire per-project as each scan completes. Projects previously blocked behind a slow registry no longer stall the queue.
- **OSV DB sync endpoint** — `/api/security/cve-lite/sync` keeps the local OSV database current; status indicator on the CVE Lite page.
- **Skill install endpoint** — `/api/security/cve-lite/install-skill` writes Claude Code AI skill files for CVE triage workflows.

### Changed
- `outdated` registry timeout reduced from 30s → 10s (`OUTDATED_TIMEOUT_MS`) — slow or unreachable registries no longer block the queue for 30 seconds each.

### Fixed
- Vulnerable version read from `npm audit` `nodes[]` path instead of top-level version field — was causing false-clear on nested transitive copies (#80).
- GHSA extracted from advisory URL so npm-project findings correctly merge and deduplicate with Grype findings.
- Findings sharing any advisory ID now merge across sources (postcss dedup fix #80).

### Security
- `/update`, `/cve-lite/fix`, and `override-remove` endpoints now return 409 when `AUTO_APPLY_ENABLED=false` — server-side kill-switch that stale UI tabs cannot bypass (#96, #97).
- `FIX_VIA_OVERRIDE_ENABLED` flag gates the Patches "fix now" (fixViaOverride) button independently of the main apply flag — prevents the cascading install footgun while keeping all other apply actions enabled (#94).
- Fleet-wide `postcss` pinned to 8.5.15 (GHSA-qx2v-qp2m-jg93 / CVE-2026-41305) across all managed projects. npm projects with stranded `pnpm.overrides` given correct top-level `overrides` blocks.
- vitest bumped to 4.x; `vite` and `esbuild` pinned via overrides to clear dev-dep advisories (GHSA-67mh-4wv8-2f99, GHSA-4w7w-66w2-5vf9) (#93).

---

## [0.14.0] - 2026-05-11

### Added
- Inline "fix now" action on `fixViaOverride` patch rows — chains override-remove → update in a single click with loading state

### Fixed
- `resolve-latest` target version now bypasses the downgrade guard in the update route (was being parsed as `0.0.0`, causing all transitive override patches to be refused)
- `override-remove` 404 response treated as no-op in the fix-override flow — allows patching transitive deps that have no pre-existing override written
- Active overrides panel is now scrollable (`max-h-64 overflow-y-auto`) and supports `forceExpand` prop

### Security
- next 16.2.4 → 16.2.6 (7 high CVEs: middleware bypass, DoS, SSRF, XSS)
- fast-uri 3.1.0 → 3.1.2 (GHSA-q3j6-qgpj-74h6, GHSA-v39h-62p7-jpjc)

---

## [0.13.0] - 2026-04-21

### Added
- **MCP server** — 16 tools exposing HexOps APIs to Claude Code and any MCP-compatible client (`list_projects`, `start_project`, `stop_project`, `scan_patches`, `apply_patches`, `get_vulnerabilities`, `git_status`, `git_commit`, `git_push`, `get_logs`, and more). Register with `claude mcp add hexops`.
- **Static code security scanner** — 16 grep-based PCRE rules covering hardcoded secrets, dangerous APIs, command injection, weak crypto, and misconfigurations. Supports per-project `.hexops-ignore` rule suppression.
- **Supply chain scanner** — detects install scripts, invalid npm signatures, and typosquatted package names via Levenshtein distance.
- **Escalate / triage mode** — when a standard patch fails, choose `force_override`, `force_major`, or `accept_risk` with optional expiry. Downgrade guard on all paths.
- **Dependency graph** — bar chart of top 20 most-shared packages across all projects, color-coded by vulnerability status.
- **Notifications system** — in-app bell for security events, crashes, and patch results. Optional webhook for critical alerts.
- **Background scheduler** — configurable cron-style intervals for auto patch-scan and health-check.
- **Patch trends dashboard** (`/patches/trends`) — 26-week rolling chart, KPI cards, per-project breakdown.
- **Branch switcher and stash management** in the git UI.
- **Vercel deployment history** and streaming build logs.
- **Dependabot integration** — monitor mode for Dependabot-managed repos; branch propagation syncs `package.json` and regenerates lockfiles after merges.

### Fixed
- Post-patch audit verification now confirms advisories actually cleared, not just that the top-level version changed. Banner reports which advisories remain after update.
- Cross-project collateral downgrade detection: after any patch, all projects sharing the same package are checked for unintended version rollbacks.
- Override-aware patching with stale override cleanup — injects `pnpm.overrides` / npm `overrides` / yarn `resolutions` for transitive deps and removes stale entries after direct dep supersedes them.

---

## [0.10.2] - 2026-03-21

### Added
- Progressive loading with SSE for patches dashboard (#27)
  - Real-time progress bar showing scan status per project
  - Fast path: instant load when all caches are warm
  - "Scan All" button uses SSE with forced rescan
- Pnpm lockfile health check and auto-repair before patching (#23)
  - Detects broken lockfiles (cross-platform entries, merge conflicts)
  - Automatically regenerates lockfile before applying patches
- Patch history reconciliation (#24)
  - Retroactively marks false-success entries when rescan reveals version unchanged
- Post-install version verification (#22)
  - Confirms installed version actually changed after patching

### Fixed
- Pnpm audit path parsing misclassifying direct deps as transitive (#19)
  - Paths like `.>next` now correctly recognized as direct dependencies
- Vulnerability entries now show latest version instead of minimum fix (#21)
  - Dashboard shows best upgrade target (e.g., 16.2.0 instead of just 16.1.7)
- Pnpm soft failures (exit 0 with ERR_PNPM_*) no longer recorded as success (#22)
- Dashboard stale data after successful patch (#25)
  - Update route now triggers forced rescan before returning
- Post-update refresh no longer triggers full 30s rescan (#28)
  - Uses fast-path cache read instead of forced rescan of all projects
- Stale data closure in fetchPatches callback
  - Removed `data` dependency from useCallback to prevent stale closures
- HMR re-mount no longer replaces patch data during active updates
- Hydration mismatch on patches loading state
- Added 60s timeout to patches fetch to prevent silent failures

### Changed
- Migrated from ESLint to Biome for linting
- Updated all dependencies (5 Next.js security fixes)
- Version bump to 0.10.2

## [0.10.1] - 2026-03-10

### Fixed
- Per-project audit endpoint now checks isDirect for transitive vulns (#17)

## [0.10.0] - 2026-03-08

### Fixed
- Update route guards against transitive dependency installs (#16)
  - No longer promotes transitive deps to direct dependencies via `pnpm add`
  - Uses package manager overrides for transitive vulnerability fixes

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
