# AGENT_CONTEXT.md — HexOps

**Last updated:** 2026-08-11
**Maintained by:** Aaron Lamb (aaron.lamb@hexaxia.tech)

---

## 1. TL;DR + Identity

HexOps is a local-first developer operations dashboard. It manages multiple Node.js projects from a single web UI: start/stop dev servers, scan for vulnerabilities, batch-patch packages, run git operations, deploy to Vercel, and inspect security findings. It runs exclusively on `localhost` and provides full shell access via an integrated PTY terminal.

| Field | Value |
|---|---|
| slug | hexops |
| division | hexaxia-labs |
| type | oss-library (developer tool / self-hosted web app) |
| status | active |
| version | 0.21.0 |
| owner | Aaron Lamb |
| repo | github.com/Hexaxia-Technologies/hexops (301 redirects to github.com/Hexaxia-Labs/hexops) |
| license | MIT |
| port | 3000 (default, configurable via `PORT` env var) |
| package manager | pnpm 10 |
| node | 24 |

---

## 2. Most Important Facts

**Public/private boundary.** HexOps is fully open source (MIT). There is no commercial or private layer inside this repo. The one potential future private hook is a premium threat-intel feed for the supply-chain scanner (`data/` directory, not yet implemented). All current scanner logic is open. See issue #102 for the planned `supply-sentinel` npm integration path.

**Never expose to the internet.** HexOps grants full shell access and process control over every configured project. It has no authentication layer. The README says this explicitly; enforcing it is the operator's responsibility. Always run on `localhost`. SSH tunnel or VPN if remote access is needed.

**`hexops.config.json` is gitignored.** It contains absolute project paths, per-project package holds, and optionally a Vercel API token. Never commit it. The example config at `hexops.config.example.json` is the template.

**Custom server required for WebSocket.** `pnpm dev` invokes `node server.js`, NOT `next dev`. The custom server handles WebSocket upgrades for the PTY shell (`/api/shell/ws`) while routing HMR to Next.js. Running `next dev` directly breaks the shell terminal.

**`node-pty` requires native build + hoisted linking.** `.npmrc` sets `node-linker=hoisted`. `pnpm.onlyBuiltDependencies` includes `node-pty`. Breaking either causes the shell panel to fail silently. **Note this is a HexOps-specific setting, not a fleet convention** — most managed pnpm projects use the default isolated linker, which changes where dependencies live on disk (see Gotchas).

**Security sources are five-way.** The scanner unions `PnpmAuditSource`, `GrypeSource`, `CveLiteSource`, `DependencyHealthSource` (phantom dependencies) and `OverrideHygieneSource` (cve-lite OA rules), behind one `ScanSource` interface with per-source timeouts and a merger. Grype (`~/.local/bin/grype`) and `cve-lite-cli` are external binaries; the server detects availability at boot and marks sources unavailable rather than hard-failing.

**A source can report partial coverage.** `ScanSource.scan` returns `{ findings, warning? }`. A source that succeeded but could not check everything sets `warning`, which surfaces on the source card as a degraded state — so a partial scan never renders as a green all-clear. `scanCompleteness()` in `cve-lite-view.ts` derives this for cve-lite.

**Kill switches are source constants, NOT environment variables.** `src/lib/auto-apply-flag.ts` exports three plain booleans. Changing one requires a code edit and restart — there is no env override:

| Flag | Default | Gates |
|---|---|---|
| `AUTO_APPLY_ENABLED` | `true` | `/update`, `/cve-lite/fix`, `/override-remove` |
| `FIX_VIA_OVERRIDE_ENABLED` | `false` | The Patches "fix now" (fixViaOverride) button |
| `OVERRIDE_HYGIENE_FIX_ENABLED` | `false` | `POST /api/security/overrides/[id]/fix` |

All are enforced **server-side with a 409** before any project lookup, so a stale browser tab cannot bypass them.

**The override writer emits `>=` floors, not exact pins.** `src/lib/updaters/override.ts` writes `>=8.5.26` rather than `8.5.26`. This is deliberate: an exact override *forces* a version, so a routine update can never move it — that is how 8 fleet projects ended up held on a vulnerable postcss by their own overrides. Dist-tags, git URLs, `workspace:*` and npm aliases pass through untouched. `removeOverrideConflicts` uses semver satisfaction (not string equality) so it never deletes a floor it just wrote, and `cleanStaleOverrides` deliberately skips range-valued overrides.

**A `>=` floor has no ceiling.** It resolves to `maxSatisfying`, so an override can install a newer major than targeted. `applyOverrides` therefore records the **actually resolved** version alongside the requested target (`UpdateResult.resolvedVersion`, `PatchHistoryEntry.resolvedVersion`) and logs `override_major_jump` when the resolved major exceeds the target's. Verification probes root `node_modules`, then pnpm's `.pnpm` store, collecting **every** copy — a top-level fix leaving a vulnerable nested copy is the #80 false-clear class.

**CVE Lite offline mode.** `cve-lite-cli` defaults to the live OSV API. In network-restricted environments it silently returns no findings. `runCveLiteRaw` falls back to `--offline-db ~/.cache/cve-lite/advisories.db`. Run `cve-lite advisories sync` once to populate it. The path constant is `CVE_LITE_DB_PATH` in `src/lib/security/cve-lite-db.ts`.

**Scan caches are tool-version-gated.** Cache entries record the resolved `cve-lite-cli` version; a mismatch is a miss. A dependency bump invalidates stale reports immediately rather than letting them age out over the TTL — including on the `ignoreTtl` stale-fallback path.

**Dependency commits stage only dependency files.** `POST /api/projects/[id]/git-commit` accepts `scope: 'dependencies'` (resolved server-side to `package.json` + whichever lockfiles git reports as changed, at any depth) or an explicit validated `files` list. Both the staging **and** the commit carry the pathspec, so a developer's pre-staged work is neither committed nor reset. With neither option it falls back to `git add -A` — which `project-detail.tsx` and the MCP `git_commit` tool deliberately still use.

**Versioning.** Semantic versioning. CHANGELOG.md is the authoritative version source; `package.json` version and the latest CHANGELOG entry must always match. No automated publish step — this tool is self-hosted, not on npm.

**Do not apply patches to a running dev server.** `pnpm install` while a Turbopack/Next dev server is live churns `node_modules` mid-serve. `runWithDevServerGuard` handles this (#109); it now **aborts** rather than proceeding when it cannot stop the server.

**Biome lint is non-blocking in CI.** `pnpm lint` exits 1 on pre-existing warnings; the CI step runs `continue-on-error: true` until #103 is resolved. `pnpm typecheck` and `pnpm test` ARE blocking gates.

---

## 3. Repo Map

```
hexops/
  server.js                  Custom Next.js HTTP + WebSocket server (entry point for `pnpm dev`)
  hexops.config.example.json Config schema reference
  hexops.config.json         Runtime config — projects, paths, holds, Vercel token (NOT committed)
  CHANGELOG.md               Version history (source of truth for current version)
  TASKS.md                   Open/queued work items
  PATCHING_HEALTH_REPORT.md  Fleet-wide patch status snapshot

  src/
    app/
      page.tsx               Main dashboard
      patches/               Patch scanner UI + trends
      security/              Fleet security findings; per-project CVE Lite + override hygiene panels
      logs/ deps/ settings/  Activity log, dependency graph, settings
      api/
        projects/[id]/       start, stop, git-commit, update, escalate, holds, security-scan, ...
        patches/             Fleet scan, SSE stream, history, trends
        security/
          findings/          Merged multi-source findings
          cve-lite/[id]/     Scan, artifact, report, fix, install-skill
          overrides/[id]/    Override-hygiene audit (GET) + gated fix (POST)
        system/metrics/      CPU/memory/disk
        scheduler/           Background task cron config

    components/
      ui/                    shadcn/ui primitives
      detail-sections/       Project detail collapsible panels
      security/
        cve-lite/            Toolbar, scan controls, findings, fix plan, confirm dialog,
                             override-hygiene-panel.tsx, completeness-banner.tsx
        source-card.tsx      Per-source status incl. degraded/partial state
      shell-panel.tsx        xterm.js PTY terminal

    lib/
      auto-apply-flag.ts     The three kill-switch constants
      config.ts types.ts     Config loading; all shared types
      process-manager.ts     Dev server spawn/kill/track (detached + process-group kill, #90)
      port-checker.ts        checkPort / checkPorts
      patch-scanner.ts       pnpm outdated + audit runner + cache
      updaters/              override.ts (floor writer), install.ts, npm/pnpm/yarn, common.ts
                             — override.test.ts and install.test.ts live here
      security/
        sources/             pnpm-audit, grype, cve-lite, dependency-health, override-hygiene
        override-audit.ts    Runs `cve-lite <path> overrides --json`
        json-cache.ts        Shared namespaced TTL cache (cve-lite-cache.ts wraps it)
        merger.ts runner.ts  Dedup/reconciliation; concurrent runner with per-source timeout
        cve-lite-view.ts     Browser-safe pure helpers: selectFixPlan, findingRows, scanCompleteness
        finding-states.ts    Finding lifecycle; exceptions.ts — suppression store
      logger.ts scan-scheduler.ts notifications.ts shell-manager.ts branch-propagator.ts

    mcp/server.ts            MCP stdio server — 16 tools exposing HexOps APIs

  .hexops/                   Runtime data (gitignored): logs, cache, patches, notifications
  docs/                      development/, features/, getting-started.md, configuration.md
```

**Where to look:**

| Task | Start here |
|---|---|
| Add an API endpoint | `src/app/api/` |
| Add a security scan source | `src/lib/security/sources/` + implement `ScanSource` |
| Change what gets written to overrides | `src/lib/updaters/override.ts` |
| Dev server lifecycle | `src/lib/process-manager.ts` + `src/lib/port-checker.ts` |
| Patch scanner logic | `src/lib/patch-scanner.ts` + `src/lib/updaters/` |
| MCP tool definitions | `src/mcp/server.ts` |
| All TypeScript types | `src/lib/types.ts` |

---

## 4. Stack

| Layer | Technology | Version |
|---|---|---|
| Framework | Next.js App Router | 16.3.0 |
| UI | React | 19.2.7 |
| Styling | Tailwind CSS v4 + shadcn/ui + Radix UI | 4.3.2 |
| Language | TypeScript (strict mode) | ^6.0.3 — **held at 6.x, see Gotchas** |
| Linter | Biome | 2.5.2 |
| Test runner | Vitest (node environment, `globals: false`) | ^4.1.9 |
| Terminal | @xterm/xterm + node-pty | ^6.0.0 / ^1.1.0 |
| Charts | Recharts + ApexCharts | ^3.8.1 / ^5.15.2 |
| Animations | Framer Motion | ^12.40.0 |
| WebSocket | ws | ^8.21.0 |
| Semver | semver | ^7.8.5 (declared — was previously only transitive) |
| MCP | @modelcontextprotocol/sdk | ^1.29.0 |
| Security CLI | cve-lite-cli (OWASP) | 1.28.0 (exact pin, devDependency) |
| External bins | Grype | `~/.local/bin/grype` |
| Package manager | pnpm | 10 |

**Ports:** 3000 (HTTP + WebSocket at `/api/shell/ws`). No other services.

**Tests:** all `src/**/*.test.ts`, run with `pnpm test`. **399 tests across 46 files** as of 0.21.0. Vitest runs with `globals: false`, so every test file must import `describe`/`it`/`expect` from `'vitest'`.

**`cve-lite-cli` is pinned exactly (no caret)** because HexOps parses its JSON as a structural contract in `parseCveLiteJson`, `selectFixPlan` and `findingRows`. A floating range would let a patch release reshape the UI without review.

---

## 5. Active Work (as of 2026-08-11)

**Current version:** 0.21.0 — cve-lite 1.28 + override hygiene, plus the next 16.3.0 / postcss security fixes.

**Recently landed:** #90 (Stop actually kills the server — detached spawn, process-group kill, port-verified success), the override floor writer, `OverrideHygieneSource`, scoped dependency commits, partial-scan reporting.

**Open issues worth knowing about** (full list on GitHub):

| Issue | Description |
|---|---|
| #137 | Residual of #90 — Stop's exit check inspects the `sh` wrapper, so a server that *traps* SIGTERM can still be orphaned while Stop reports success |
| #138 | The SIGINT/SIGTERM shutdown handler leaks listeners across HMR reloads; the oldest wins with a stale map, so Ctrl-C silently reaps nothing. SIGHUP unhandled |
| #139 | `override-remove` reports success when the dev-server guard blocked the operation |
| #131 | Outdated sweeps apply major bumps in bulk with no build verification — this is how TypeScript 7 reached the fleet |
| #126 | Bare `>=` overrides can silently resolve out-of-range under `node-linker=hoisted` — always verify the resolved version |
| #91 | Metrics endpoint reports single-PID RSS, undercounts the process tree ~25% |
| #115 | Detect cross-PM stranded overrides (`pnpm.overrides` in an npm project is a silent no-op) |
| #113/#114 | Lockfile vs installed `node_modules` divergence; dual-lockfile scanner confusion |
| #103 | Drive Biome lint to zero, then remove `continue-on-error` |

---

## 6. Gotchas

**Package holds live in `hexops.config.json`, per project, and coverage is easy to get wrong.**
`holds: string[]` on each project excludes those packages from updates. The mechanism works reliably where it is set — but it is set per project, so a project added later, or one that only ever held a different package, will silently drift on the next sweep. Audit hold coverage across the registry rather than assuming a package is held everywhere; a major that is locked out on most projects and missing on one will reach that one.

**TypeScript 7 breaks `next build` while `tsc --noEmit` still passes.**
Next.js 16 does not recognise TS 7 as a valid TypeScript install: it reports the package as missing, tries to auto-install one, and the build worker dies with `The "id" argument must be of type string. Received undefined`. It also violates `ts-jest`'s peer range (`>=4.3 <7`), silently reducing a suite to 0 tests. Because the type check itself passes, this is invisible outside a real build.

**Most managed pnpm projects use the *isolated* linker — HexOps does not.**
HexOps's `.npmrc` forces `node-linker=hoisted` for `node-pty`. Elsewhere in the fleet, transitive dependencies live at `node_modules/.pnpm/<pkg>@<version>/node_modules/<pkg>/`, and there is **no root `node_modules/<pkg>`**. Reading the root path to determine an installed version gives the wrong answer, or none. This blind spot has bitten both the tooling and manual checks.

**Stale copies survive in the `.pnpm` store and read as vulnerable.**
`pnpm install` does not prune the virtual store, so an old version can sit on disk with **zero lockfile references** while every symlink points at the new one. Filesystem scanners (cve-lite, grype) see it and report it. `rm -rf node_modules && pnpm install` clears it. Always check whether an "unfixed" finding is a live dependency or a fossil.

**Verify the resolved version on disk, never the manifest.**
Editing `package.json` proves nothing: a floor can fail to move the resolved version (#126), a fossil can linger, and a nested copy can survive a top-level fix (#80). Check `node_modules` — and under an isolated linker, the `.pnpm` store, every copy.

**`pnpm.overrides` entries are ignored by npm.**
Several managed projects are npm-based, so a `pnpm.overrides` block there is dead config that reads like protection. Use top-level `overrides`. HexOps's package-manager-aware patching handles this; hand-editing bypasses it. Tracked as #115.

**Override hygiene answers a different question from the CVE scanner.**
The OA rules ask "is this override coherent and effective?" — not "is what it pins safe?". An exact pin at a vulnerable version is a *perfectly hygienic* override, so no OA rule fires. That gap is why 8 projects sat vulnerable with a clean override audit. The CVE scan is what catches it.

**`cve-lite --json` writes a file to cwd, not stdout.**
True of both the main scan (`cve-lite-scan-*.json`) and the `overrides` subcommand (`cve-lite-overrides-*.json`), despite what `--help` implies. Both runners execute in a temp directory and read the file back. Non-zero exit means findings exist, so the **file's presence** — not the exit code — signals success. Do not refactor to capture stdout.

**HMR does NOT pick up API route changes.**
`server.js` is long-running. Changes under `src/app/api/` or `src/lib/` need a restart. The startup log prints `git: <SHA>`; a stale-server notice appears in the sidebar when it diverges from HEAD. **Also check this after a merge** — a detached server keeps serving old code while `node_modules` and `.next` change underneath it, which surfaces as Internal Server Error plus `EADDRINUSE` on the next start.

**After pulling a merge that adds a dependency, reinstall.**
`pnpm typecheck` will fail locally on a missing type package while CI passes, because CI installs fresh. Run `pnpm install` after any pull that touches `package.json`.

**`Hexaxia-Technologies/hexops` vs `Hexaxia-Labs/hexops`.**
The remote and some README badges use `Hexaxia-Technologies`; it 301-redirects to `Hexaxia-Labs`, the canonical org where issues file. Do not "fix" the remote unless asked.

**Squash-merge can drop late-pushed commits, and breaks stacked PRs.**
PR #104 demonstrated the first. The second matters when a PR is stacked on another branch: squashing the base rewrites its commits and strands the child, forcing a rebase. Merge the base with a merge/rebase-merge instead.

**Cache TTL has jitter.** Patch caches use a 1-hour base plus 0–15 minutes of random jitter to avoid a thundering herd. Do not expect simultaneous expiry.

**`docs/superpowers/` is gitignored.** Specs and plans live there on disk but are excluded from the public repo.

---

## 7. Related Projects

| Project | Relationship |
|---|---|
| [`OWASP/cve-lite-cli`](https://github.com/OWASP/cve-lite-cli) | Upstream of three HexOps surfaces: the CVE scan, the override-hygiene audit, and SBOM/SARIF artifacts. Pinned exactly, because its JSON is parsed as a structural contract. File tool bugs upstream there, separately from the HexOps-side fix |
| `override-audit-cli` | **Archived** — merged into `OWASP/cve-lite-cli` as the OA001–OA009 rule family that `OverrideHygieneSource` consumes |
| `supply-sentinel` | Standalone npm supply-chain scanner; #102 tracks replacing the inline supply-chain checks with it as a proper `ScanSource` once published |
| Grype | External binary at `~/.local/bin/grype`; `GrypeSource` shells out to it and marks the source unavailable if absent |

Managed projects are whatever is listed in the local, gitignored `hexops.config.json` — HexOps has no built-in project list, and none is assumed by the code. `hexops.config.example.json` documents the schema.

**Useful shapes to test against**, since they exercise the paths that break most often:

- A **pnpm workspace** (`packages:`/`apps/*`) — exercises monorepo dependency resolution, and is where cve-lite's PD001/PD002 phantom-dep rules false-positive while `DependencyHealthSource` handles it correctly.
- An **npm project carrying a `pnpm.overrides` block** — silently a no-op; see #115.
- A project with **two lockfiles** — the scanner can pick the stale one and mask a live CVE; see #113/#114.
- A project whose dev server **traps SIGTERM** — the residual case in #137.
