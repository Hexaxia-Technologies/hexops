# Patches Dashboard Enhancements

**Date**: 2026-01-28
**Status**: Approved

## Overview

Enhance the HexOps patches dashboard with improved UX defaults, state persistence, and integrated git controls for committing patch updates.

## Features

### 1. Default to Grouped View
Change the default view mode from "flat" to "grouped by project" for better organization.

### 2. State Persistence
Save user preferences to localStorage so layout persists between sessions.

**localStorage key**: `hexops-patches-preferences`

```typescript
{
  viewMode: 'grouped' | 'flat',  // default: 'grouped'
  showUnfixable: boolean,        // default: true
  showHeld: boolean              // default: true
}
```

Filters (category, type) reset each session so users see the full picture.

### 3. Rearranged Project Card Header

**Current layout**:
```
[▸] lyfe-uncharted (8 patches)                           [Select All]
```

**New layout**:
```
[▸] lyfe-uncharted (8 patches) [Select All]      [Commit] [Push]
```

- Select All moves to left (after patch count)
- Git controls (Commit / Push) on far right

### 4. Git Controls with Auto-Generated Commit Messages

After patches are applied to a project, an inline commit UI appears:

```
[▸] lyfe-uncharted (5 remaining) [Select All]    [Commit] [Push]
├──────────────────────────────────────────────────────────────┤
│ ✓ Updated 3 packages                                         │
│ ┌──────────────────────────────────────────────────────┐     │
│ │ chore(deps): update 3 packages (1 security fix)  [✎] │     │
│ └──────────────────────────────────────────────────────┘     │
│                                              [Dismiss]       │
```

**Commit message format**:
```
chore(deps): update N packages (X security fixes)

Security:
- next 16.1.4 → 16.1.6 (fixes 2 vulnerabilities)

Dependencies:
- react 19.2.3 → 19.2.4
- react-dom 19.2.3 → 19.2.4
```

**Logic**:
- Security fixes listed first with vulnerability count
- Regular dependencies listed below
- Title includes security fix count only if > 0
- Click [✎] to edit message in textarea
- [Dismiss] clears pending commit without committing

**Button states**:
- [Commit] - enabled when uncommitted patch changes exist
- [Push] - enabled after commit, shows ahead count: "Push (1↑)"

## Data Flow

### New State Per Project Group

```typescript
interface ProjectPatchState {
  pendingCommit: {
    packages: UpdatedPackage[];  // what was just updated
    message: string;             // auto-generated, editable
    isEditing: boolean;
  } | null;
  gitStatus: {
    dirty: boolean;
    ahead: number;
    behind: number;
  } | null;
}
```

### Flow

1. User selects packages → clicks "Update Selected"
2. Patches applied → `pendingCommit` populated with updated packages + generated message
3. Git status fetched for that project
4. User clicks [Commit] → calls `/api/projects/[id]/git-commit` with message
5. `pendingCommit` cleared, git status refreshed (now shows ahead count)
6. User clicks [Push] → calls `/api/projects/[id]/git-push`
7. Git status refreshed (ahead = 0)

## Files to Modify

| File | Change |
|------|--------|
| `src/app/patches/page.tsx` | Add localStorage persistence, default to grouped view |
| `src/app/patches/page.tsx` | Update project card header layout |
| `src/app/patches/page.tsx` | Add per-project git state and commit UI |
| `src/lib/patch-commit-message.ts` | New - generate commit message from updated packages |

## Existing APIs Used (No Changes)

- `POST /api/projects/[id]/git-commit` - accepts `{ message: string }`
- `POST /api/projects/[id]/git-push` - pushes to remote
- `GET /api/projects/[id]/git` - returns branch, dirty, ahead/behind

## Estimated Scope

~200-300 lines of changes, primarily in patches page.
