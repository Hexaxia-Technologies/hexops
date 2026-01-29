# Settings Feature Design

**Date:** 2026-01-29
**Status:** Approved

## Overview

Add global settings page and per-project settings section for configuring system paths, integrations, and project-specific behaviors.

## Data Structure

### Global Settings

New `settings` key in `hexops.config.json`:

```json
{
  "settings": {
    "paths": {
      "projectsRoot": "/home/aaron/Projects",
      "logsDir": ".hexops/logs",
      "cacheDir": ".hexops/cache"
    },
    "integrations": {
      "vercel": {
        "token": null,
        "teamId": null
      },
      "git": {
        "defaultBranch": "main",
        "commitPrefix": "",
        "pushAfterCommit": false
      }
    }
  },
  "projects": [...],
  "categories": [...]
}
```

### Per-Project Settings

Extend project objects with `settings` key:

```json
{
  "id": "sailbot",
  "name": "SailBot",
  "path": "...",
  "port": 3010,
  "settings": {
    "env": { "NODE_ENV": "development" },
    "nodeVersion": null,
    "shell": null,
    "git": {
      "autoPull": false,
      "commitTemplate": null,
      "branch": null
    },
    "deploy": {
      "vercelProjectId": null,
      "autoDeployBranch": null,
      "environment": "preview"
    },
    "monitoring": {
      "healthCheckUrl": null,
      "restartOnCrash": false,
      "logRetentionDays": 7
    }
  }
}
```

## UI Design

### Global Settings Page (`/settings`)

Accessible from sidebar (gear icon, below Shell).

**Sections (collapsible):**

1. **System Paths**
   - Projects Root - text input with folder icon
   - Logs Directory - text input (relative path)
   - Cache Directory - text input (relative path)

2. **Git Defaults**
   - Default Branch - text input
   - Commit Prefix - text input
   - Auto-push after commit - toggle switch

3. **Vercel Integration**
   - API Token - password input with show/hide
   - Team ID - text input (optional)
   - Connection status indicator

**Behavior:** Save on blur, toast confirmation, validation for paths and tokens.

### Per-Project Settings Section

New collapsible section in project detail page, after Activity Log.

**Subsections:**

1. **Environment**
   - Custom env vars - key/value editor
   - Node version override - text input
   - Shell - dropdown (bash, zsh, system default)

2. **Git Behavior**
   - Auto-pull on start - toggle
   - Commit template - textarea
   - Preferred branch - text input

3. **Deploy**
   - Vercel Project ID - text input (auto-detect button)
   - Auto-deploy branch - text input
   - Default environment - dropdown

4. **Monitoring**
   - Health check URL - text input
   - Restart on crash - toggle
   - Log retention days - number input

## API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/settings` | GET | Get global settings |
| `/api/settings` | PUT | Update global settings |
| `/api/settings/verify-vercel` | POST | Test Vercel token |
| `/api/projects/[id]/settings` | GET | Get project settings |
| `/api/projects/[id]/settings` | PUT | Update project settings |

## Implementation Files

| File | Purpose |
|------|---------|
| `src/app/settings/page.tsx` | Global settings page |
| `src/components/detail-sections/settings-section.tsx` | Project settings section |
| `src/components/settings/path-settings.tsx` | System paths form |
| `src/components/settings/git-settings.tsx` | Git defaults form |
| `src/components/settings/vercel-settings.tsx` | Vercel integration form |
| `src/components/settings/env-editor.tsx` | Key/value env var editor |
| `src/lib/settings.ts` | Settings read/write utilities |

## Settings Utilities

```typescript
// src/lib/settings.ts
getGlobalSettings(): GlobalSettings      // Returns settings with defaults
updateGlobalSettings(partial): void      // Merges and saves
getProjectSettings(id): ProjectSettings  // Returns project settings with defaults
updateProjectSettings(id, partial): void // Merges and saves
```

## Storage

Single file: `hexops.config.json` - maintains single source of truth.

## Sidebar Navigation Order

Dashboard > Patches > Logs > Shell > Settings
