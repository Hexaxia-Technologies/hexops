# Projects

The project detail page provides a control panel for managing individual projects.

## Accessing Project Details

1. Click on any project row in the dashboard
2. Or navigate directly to `/projects/[project-id]`

## Control Panel

The project detail page has a cPanel-style layout with collapsible sections.

### Header

- **Project Name** - Display name from config
- **Status Badge** - Running/Stopped/Error
- **Start/Stop Button** - Toggle dev server
- **Mode Selector** - Development or Production mode

### Start Modes

**Development Mode**
- Runs the `dev` script from config
- Hot reload enabled
- Faster startup

**Production Mode**
- First runs the `build` script
- Then runs the `start` script
- Tests production build locally

## Sections

### Project Info

Displays metadata from package.json:

- Version
- Description
- Node.js version
- Package manager (npm/pnpm/yarn)
- Dependencies count

### Git

Git repository status and controls:

- **Branch** - Current branch name
- **Status** - Clean or dirty indicator
- **Ahead/Behind** - Commits ahead/behind remote
- **Pull** - Pull latest changes
- **Push** - Push local commits

### Logs

Live log output from the dev server:

- Auto-scrolls to latest
- Color-coded by log level
- Click to expand full log viewer

### Package Health

Package update status:

- **Outdated Count** - Packages with updates available
- **Security Issues** - Vulnerabilities from audit
- **Quick Update** - Update all safe packages

Shows badges:
- Green: All up to date
- Yellow: Updates available
- Red: Security vulnerabilities
- Gray: All outdated packages are held

### Activity Log

Recent operations for this project:

- Start/stop events
- Git operations
- Package updates
- Errors and warnings

Filtered from the system log by project ID.

### Settings

Project-specific configuration:

- Environment variables
- Node version override
- Shell preference
- Git behavior
- Deploy settings
- Monitoring options

See [Settings](settings.md) for details.

## Utility Actions

Quick actions at the bottom of the control panel:

| Action | Description |
|--------|-------------|
| Open IDE | Launch configured IDE in project directory |
| Terminal | Open shell in project directory |
| Files | Open file manager to project path |
| Browser | Open localhost:PORT in browser |
| Clear Cache | Delete .next directory |
| Delete Lock | Remove package lock files |

## Performance Metrics

When a project is running, shows:

- **Uptime** - How long the server has been running
- **Memory** - Current memory usage
- **CPU** - Process CPU utilization
- **PID** - Process ID
- **Port Status** - Whether port is listening
