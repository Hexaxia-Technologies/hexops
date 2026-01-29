# Configuration

HexOps uses a JSON configuration file (`hexops.config.json`) to define projects and settings.

## File Location

The config file must be in the HexOps root directory:

```
hexops/
├── hexops.config.json      # Your configuration (gitignored)
├── hexops.config.example.json  # Example template
└── ...
```

## Full Schema

```json
{
  "projects": [
    {
      "id": "unique-id",
      "name": "Display Name",
      "description": "Optional description",
      "path": "/absolute/path/to/project",
      "port": 3001,
      "category": "Product",
      "scripts": {
        "dev": "pnpm dev",
        "build": "pnpm build"
      },
      "holds": ["package-name"],
      "settings": {
        "nodeVersion": "20.x",
        "shell": "bash",
        "env": {
          "NODE_ENV": "development"
        },
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
  ],
  "categories": ["Product", "Client", "Internal", "Personal"],
  "settings": {
    "paths": {
      "projectsRoot": "/home/user/projects",
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
  }
}
```

## Project Configuration

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier (used in URLs and API) |
| `name` | string | Display name shown in UI |
| `path` | string | Absolute path to project directory |
| `port` | number | Port number for dev server |
| `category` | string | Category for filtering (must match one in `categories`) |
| `scripts.dev` | string | Command to start dev server |

### Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `description` | string | null | Project description |
| `scripts.build` | string | null | Build command (enables production mode) |
| `holds` | string[] | [] | Packages to skip during updates |
| `settings` | object | {} | Project-specific settings (see below) |

### Project Settings

These override global settings for a specific project:

```json
{
  "settings": {
    "nodeVersion": "20.x",
    "shell": "bash",
    "env": {
      "MY_VAR": "value"
    },
    "git": {
      "autoPull": true,
      "commitTemplate": "feat({project}): {message}",
      "branch": "develop"
    },
    "deploy": {
      "vercelProjectId": "prj_xxx",
      "autoDeployBranch": "main",
      "environment": "production"
    },
    "monitoring": {
      "healthCheckUrl": "/api/health",
      "restartOnCrash": true,
      "logRetentionDays": 14
    }
  }
}
```

## Global Settings

### Paths

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `projectsRoot` | string | cwd | Default directory for terminal |
| `logsDir` | string | `.hexops/logs` | Log file directory |
| `cacheDir` | string | `.hexops/cache` | Cache file directory |

### Git Integration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `defaultBranch` | string | `main` | Default branch name |
| `commitPrefix` | string | `` | Prefix for commit messages |
| `pushAfterCommit` | boolean | false | Auto-push after committing |

### Vercel Integration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `token` | string | null | Vercel API token |
| `teamId` | string | null | Team ID (for team accounts) |

To get your Vercel token:
1. Go to [Vercel Settings](https://vercel.com/account/tokens)
2. Create a new token with appropriate scope
3. Add it to your config

## Categories

Categories are used for filtering projects in the sidebar:

```json
{
  "categories": ["Product", "Client", "Internal", "Personal"]
}
```

Projects must use one of the defined categories.

## Package Holds

To prevent specific packages from being updated:

```json
{
  "id": "my-project",
  "holds": ["tailwindcss", "typescript"]
}
```

Held packages:
- Appear dimmed in the patches view
- Are excluded from "Select All"
- Cannot be updated through the UI

## Environment Variables

Project-specific environment variables:

```json
{
  "settings": {
    "env": {
      "DATABASE_URL": "postgresql://...",
      "API_KEY": "xxx"
    }
  }
}
```

These are passed to the dev server when starting.

## Example Configurations

### Minimal Setup

```json
{
  "projects": [
    {
      "id": "app",
      "name": "My App",
      "path": "/home/user/app",
      "port": 3001,
      "category": "Personal",
      "scripts": { "dev": "npm run dev" }
    }
  ],
  "categories": ["Personal"]
}
```

### Full Setup with Vercel

```json
{
  "projects": [
    {
      "id": "web-app",
      "name": "Web Application",
      "description": "Main product website",
      "path": "/home/user/projects/web-app",
      "port": 3001,
      "category": "Product",
      "scripts": {
        "dev": "pnpm dev",
        "build": "pnpm build"
      },
      "holds": ["typescript"],
      "settings": {
        "deploy": {
          "vercelProjectId": "prj_xxxxxxxxxxxx"
        }
      }
    }
  ],
  "categories": ["Product", "Client", "Internal"],
  "settings": {
    "paths": {
      "projectsRoot": "/home/user/projects"
    },
    "integrations": {
      "vercel": {
        "token": "your-vercel-token",
        "teamId": "team_xxxxxxxxxxxx"
      },
      "git": {
        "defaultBranch": "main",
        "pushAfterCommit": true
      }
    }
  }
}
```
