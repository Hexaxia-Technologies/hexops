# Dashboard

The dashboard is your main view into HexOps, showing system health and all your projects at a glance.

## System Health

The top of the dashboard displays real-time system metrics:

### CPU Usage
- Current CPU utilization percentage
- 60-second history sparkline
- Color-coded: green (< 60%), yellow (60-80%), red (> 80%)

### Memory Usage
- Current memory utilization
- 60-second history sparkline
- Shows used/total in tooltip

### Disk Usage
- Primary disk utilization
- Static gauge (disk changes slowly)
- Warning at 80%, critical at 90%

### Patch Status
- Pie chart showing patched vs unpatched projects
- Quick view of overall update status

Metrics update every 5 seconds automatically.

## Project List

Below the health metrics, all configured projects are listed in rows.

### Row Information

Each project row shows:

- **Status Indicator** - Green (running), gray (stopped), red (error)
- **Project Name** - Click to open detail panel
- **Category** - Product, Client, Internal, Personal
- **Port** - Configured port number
- **Quick Actions** - Start/stop, logs, terminal

### Filtering

Use the left sidebar to filter projects:

- **All** - Show all projects
- **Running** - Only running projects
- **Stopped** - Only stopped projects
- **By Category** - Filter by project category

### Project Actions

Click the icons on each row:

| Icon | Action |
|------|--------|
| Play | Start dev server |
| Stop | Stop dev server |
| Terminal | Open shell in project directory |
| Folder | Open in file manager |

## Right Sidebar

Click on a project row to open the right sidebar with:

- **Log Panel** - Live log output from dev server
- **Shell Panel** - Integrated terminal (if opened via shell button)

The sidebar can be closed by clicking the X or clicking elsewhere.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `r` | Refresh project status |
| `Escape` | Close right sidebar |

## Navigation

From the dashboard, you can navigate to:

- **Patches** - `/patches` for package management
- **Logs** - `/logs` for system log viewer
- **Settings** - `/settings` for configuration
