# Architecture

Overview of HexOps system design and data flow.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Browser                             │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐    │
│  │Dashboard│  │ Patches │  │  Logs   │  │Settings │    │
│  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘    │
│       │            │            │            │          │
│       └────────────┴────────────┴────────────┘          │
│                         │                                │
│              ┌──────────┴──────────┐                    │
│              │    React + Next.js   │                    │
│              └──────────┬──────────┘                    │
└─────────────────────────┼───────────────────────────────┘
                          │ HTTP/WebSocket
┌─────────────────────────┼───────────────────────────────┐
│                   Next.js Server                         │
│  ┌─────────────────┐    │    ┌─────────────────┐        │
│  │   API Routes    │◄───┴───►│  WebSocket      │        │
│  │  /api/projects  │         │  /api/shell/ws  │        │
│  └────────┬────────┘         └────────┬────────┘        │
│           │                           │                  │
│  ┌────────┴────────┐         ┌────────┴────────┐        │
│  │ Process Manager │         │    node-pty     │        │
│  └────────┬────────┘         └────────┬────────┘        │
└───────────┼───────────────────────────┼─────────────────┘
            │                           │
    ┌───────┴───────┐           ┌───────┴───────┐
    │  Dev Servers  │           │   PTY Shell   │
    │  (children)   │           │               │
    └───────────────┘           └───────────────┘
```

## Data Flow

### Configuration

```
hexops.config.json
       │
       ▼
   loadConfig()     ◄── Cache in memory
       │
       ▼
   API Routes       ◄── Validate and transform
       │
       ▼
   React State      ◄── Component props
       │
       ▼
   UI Components
```

### Process Management

```
User clicks "Start"
       │
       ▼
POST /api/projects/[id]/start
       │
       ▼
ProcessManager.start()
       │
       ▼
child_process.spawn()
       │
       ├──► Log output to file
       │
       └──► Track PID in memory
```

### Logging

```
Operation occurs
       │
       ▼
logger.info/warn/error()
       │
       ▼
Format as JSON Lines
       │
       ▼
Append to .hexops/logs/system.log
       │
       ├──► Check rotation (50MB limit)
       │
       └──► Rotate if needed
```

## Component Hierarchy

```
RootLayout (app/layout.tsx)
├── Providers (theme, toast, sidebar)
│   └── AppShell
│       ├── Sidebar (left)
│       │   ├── Navigation links
│       │   ├── Category filters
│       │   └── Shell button
│       ├── Main content (page)
│       │   ├── Dashboard
│       │   ├── Patches
│       │   ├── Logs
│       │   ├── Settings
│       │   └── Project Detail
│       └── RightSidebar
│           ├── LogPanel
│           └── ShellPanel
```

## State Management

HexOps uses local React state (no external state library):

| State | Location | Purpose |
|-------|----------|---------|
| `projects` | Dashboard page | All project data |
| `selectedProjectId` | Dashboard page | Currently selected row |
| `rightPanel` | AppShell | Current sidebar panel |
| `sidebarData` | SidebarProvider | Shared sidebar state |
| `settings` | Settings page | Form state |

## API Design

### RESTful Endpoints

Most endpoints follow REST conventions:

```
GET    /api/projects          # List all
GET    /api/projects/[id]     # Get one
POST   /api/projects/[id]/start  # Action
POST   /api/projects/[id]/stop   # Action
PUT    /api/projects/[id]/settings  # Update
```

### WebSocket

Terminal uses WebSocket for real-time communication:

```
ws://localhost:3000/api/shell/ws?cwd=/path
```

Messages are binary (terminal I/O).

## Caching Strategy

### Patch Scanner Cache

- Location: `.hexops/patches/cache/`
- TTL: 1 hour + random jitter (prevents thundering herd)
- Content: `pnpm outdated` and `pnpm audit` results

### Extended Status Cache

- In-memory with 5-minute TTL
- Reads from patch scanner cache
- Provides quick status for dashboard

## Error Handling

### API Routes

```typescript
try {
  // Operation
  return Response.json({ success: true, data });
} catch (error) {
  logger.error('Operation failed', { error });
  return Response.json(
    { success: false, error: error.message },
    { status: 500 }
  );
}
```

### Client Side

```typescript
try {
  const res = await fetch('/api/...');
  if (!res.ok) throw new Error('Failed');
  // Handle success
} catch (error) {
  toast.error('Operation failed');
}
```

## Security Considerations

- No authentication (local-only tool)
- Config file contains sensitive paths
- API tokens stored in config (gitignored)
- Shell runs with user permissions
- No remote access by default
