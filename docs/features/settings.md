# Settings

HexOps provides both global settings and per-project settings for customization.

## Global Settings

Access global settings from the sidebar gear icon or navigate to `/settings`.

### System Paths

Configure where HexOps stores data:

| Setting | Description | Default |
|---------|-------------|---------|
| Projects Root | Default directory for terminal | HexOps directory |
| Logs Directory | Where system logs are stored | `.hexops/logs` |
| Cache Directory | Where cache files are stored | `.hexops/cache` |

### Git Defaults

Default git behavior for all projects:

| Setting | Description | Default |
|---------|-------------|---------|
| Default Branch | Branch name for new operations | `main` |
| Commit Prefix | Prefix added to commit messages | (none) |
| Auto-push | Push automatically after commit | Off |

### Vercel Integration

Connect your Vercel account for deployments:

| Setting | Description |
|---------|-------------|
| API Token | Your Vercel API token |
| Team ID | Team ID for team accounts (optional) |

**Getting your Vercel token:**
1. Go to [Vercel Settings](https://vercel.com/account/tokens)
2. Click "Create Token"
3. Name it (e.g., "HexOps")
4. Copy and paste into settings

**Verifying connection:**
1. Enter your token
2. Click "Verify Connection"
3. Shows connected user/team on success

## Project Settings

Each project can have its own settings that override global defaults.

Access project settings from the Settings section in the project detail page.

### Environment

| Setting | Description |
|---------|-------------|
| Environment Variables | Key-value pairs passed to dev server |
| Node Version | Override system Node.js version |
| Shell | Preferred shell (bash/zsh/system) |

**Adding environment variables:**
1. Click "Add Variable"
2. Enter key and value
3. Save settings

Variables are passed when starting the dev server.

### Git Behavior

Per-project git configuration:

| Setting | Description |
|---------|-------------|
| Auto-pull on start | Pull before starting dev server |
| Commit Template | Custom commit message format |
| Preferred Branch | Override default branch |

**Commit template variables:**
- `{project}` - Project name
- `{date}` - Current date

### Deploy

Vercel deployment settings:

| Setting | Description |
|---------|-------------|
| Vercel Project ID | Project ID from `.vercel/project.json` |
| Auto-deploy Branch | Branch to auto-deploy on push |
| Default Environment | preview or production |

**Finding your Vercel Project ID:**
1. Navigate to your project directory
2. Run `vercel link` if not linked
3. Check `.vercel/project.json`
4. Copy the `projectId` value

### Monitoring

Health and logging settings:

| Setting | Description | Default |
|---------|-------------|---------|
| Health Check URL | Path to check project health | (none) |
| Restart on Crash | Auto-restart if server crashes | Off |
| Log Retention | Days to keep project logs | 7 |

## Saving Settings

### Explicit Save

Settings use an explicit save model:
1. Make changes in the form
2. Changes are highlighted
3. Click "Save" to persist
4. Or "Discard" to revert

### Dirty Indicator

A yellow dot appears next to sections with unsaved changes.

### Save Config Button

An always-visible "Save Config" button allows saving at any time, even without changes, to ensure your config file is written.

## Settings Storage

- Global settings: `hexops.config.json` root `settings` key
- Project settings: `hexops.config.json` per-project `settings` key

Settings are merged with defaults, so you only need to specify overrides.
