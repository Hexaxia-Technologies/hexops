# Patches

The Patches page provides centralized management of package updates and security vulnerabilities across all projects.

## Overview

Access the Patches page from the sidebar or navigate to `/patches`.

The page scans all configured projects for:
- **Outdated Packages** - Using `pnpm outdated`
- **Security Vulnerabilities** - Using `pnpm audit`

## View Modes

### Flat View

Shows all patches in a single list, sorted by priority:

1. Critical security vulnerabilities
2. High security vulnerabilities
3. Moderate security issues
4. Major version updates
5. Minor version updates
6. Patch version updates

### Grouped View (Default)

Groups patches by project, showing:
- Project name and patch count
- Expandable sections per project
- Per-project git controls
- Batch actions per project

## Patch Information

Each patch row shows:

| Column | Description |
|--------|-------------|
| Checkbox | Select for batch update |
| Package Name | npm package name |
| Current | Currently installed version |
| Latest | Latest available version |
| Type | major/minor/patch/security |
| Severity | For vulnerabilities: critical/high/moderate/low |

### Details Panel

Click the info icon on any patch to see:

- Package type (dependency/devDependency)
- Full version information
- Vulnerability details (if applicable)
- CVE identifiers with links
- Advisory links

## Selecting Patches

### Individual Selection

Click the checkbox next to any patch to select it.

### Select All

In grouped view, each project has a "Select All" checkbox that:
- Selects all non-held packages in that project
- Excludes packages on hold

## Updating Packages

### Batch Update

1. Select patches to update
2. Click "Update Selected" in the right sidebar
3. Watch progress in real-time
4. Review results

### Update Progress

The right sidebar shows:
- Currently updating package
- Success/failure status
- Error messages if any

## Package Holds

Some packages may cause issues when updated. Use holds to skip them:

### Adding a Hold

1. Click the pause icon on any patch row
2. Package is added to project's hold list
3. Appears dimmed in the UI

### Removing a Hold

1. Click the play icon on a held package
2. Package is removed from hold list
3. Can be updated normally

### Hold Behavior

Held packages:
- Appear dimmed in the list
- Are excluded from "Select All"
- Cannot be selected for update
- Persist in config file

## Git Integration

After updating packages, the grouped view shows git controls:

### Commit

When uncommitted changes exist:
1. Click "Commit" on the project card
2. Auto-generated commit message appears
3. Edit message if needed
4. Confirm to commit

### Push

When local commits exist:
1. Shows count of commits ahead
2. Click "Push" to push to remote
3. Requires git credentials configured

## Filtering

### Category Filter

Filter by project category in the left sidebar.

### Type Filter

Show only certain patch types:
- Security Only
- Major Updates
- Minor/Patch

### Show Held

Toggle to show or hide held packages.

### Show Unfixable

Toggle to show vulnerabilities that cannot be directly fixed (transitive dependencies).

## Scanning

### Automatic Scan

Projects are scanned automatically with results cached for 1 hour (with random jitter to prevent thundering herd).

### Progressive Loading

When caches are cold, the patches page shows a real-time progress bar as each project is scanned via Server-Sent Events (SSE). Projects with warm caches load instantly.

### Manual Rescan

Click "Scan All" to force a fresh scan of all projects with live progress.

## Transitive Vulnerabilities

Vulnerabilities in transitive dependencies are handled automatically:

- **Fix via parent**: If the parent direct dependency has a non-breaking update that resolves the vulnerability, HexOps updates the parent
- **Fix via override**: If no parent update exists, HexOps applies a package manager override (`pnpm.overrides`, `npm.overrides`, or `yarn.resolutions`)
- Dependency chain shown in the details panel (via field)

## Pnpm Lockfile Handling

HexOps automatically detects and repairs broken pnpm lockfiles before patching:

- Cross-platform entries (e.g., `@next/swc-darwin-arm64` on Linux)
- Corrupted merge conflict artifacts
- Lockfile regenerated via `pnpm install --no-frozen-lockfile`

## Post-Patch Verification

After applying patches, HexOps verifies each package was actually installed:

- Checks installed version in `node_modules` matches the target
- Detects pnpm soft failures (exit 0 with `ERR_PNPM_*`)
- Retroactively corrects false-success history entries on rescan
