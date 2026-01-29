# API Reference

Complete reference for all HexOps API endpoints.

## Projects

### List Projects

```
GET /api/projects
```

Returns all projects with runtime status.

**Response:**
```json
{
  "projects": [
    {
      "id": "my-app",
      "name": "My App",
      "path": "/path/to/project",
      "port": 3001,
      "category": "Product",
      "status": "running",
      "pid": 12345
    }
  ]
}
```

### Get Project

```
GET /api/projects/[id]
```

Returns single project with extended status.

### Start Project

```
POST /api/projects/[id]/start
```

**Body:**
```json
{
  "mode": "dev" | "prod"
}
```

**Response:**
```json
{
  "success": true,
  "pid": 12345
}
```

### Stop Project

```
POST /api/projects/[id]/stop
```

**Response:**
```json
{
  "success": true
}
```

### Get Project Logs

```
GET /api/projects/[id]/logs?lines=100
```

**Query Parameters:**
- `lines` - Number of lines to return (default: 100)

### Get Project Info

```
GET /api/projects/[id]/info
```

Returns package.json information.

**Response:**
```json
{
  "name": "my-app",
  "version": "1.0.0",
  "description": "...",
  "nodeVersion": "20.10.0",
  "packageManager": "pnpm"
}
```

### Get Project Metrics

```
GET /api/projects/[id]/metrics
```

Returns process metrics when running.

**Response:**
```json
{
  "pid": 12345,
  "uptime": 3600,
  "memory": 150000000,
  "cpu": 2.5,
  "portListening": true
}
```

## Git Operations

### Get Git Status

```
GET /api/projects/[id]/git
```

**Response:**
```json
{
  "branch": "main",
  "isDirty": false,
  "aheadCount": 0,
  "behindCount": 0,
  "lastCommit": {
    "hash": "abc123",
    "message": "feat: add feature",
    "date": "2025-01-29T10:00:00Z"
  }
}
```

### Git Pull

```
POST /api/projects/[id]/git-pull
```

### Git Push

```
POST /api/projects/[id]/git-push
```

### Git Commit

```
POST /api/projects/[id]/git-commit
```

**Body:**
```json
{
  "message": "commit message"
}
```

## Patches

### Get All Patches

```
GET /api/patches
```

**Response:**
```json
{
  "patches": [...],
  "projectNames": { "id": "name" },
  "gitStatus": { "id": {...} }
}
```

### Scan Projects

```
POST /api/patches/scan
```

Forces a rescan of all projects.

### Get Patch History

```
GET /api/patches/history
```

### Update Packages

```
POST /api/projects/[id]/update
```

**Body:**
```json
{
  "packages": ["package1", "package2"]
}
```

### Get Holds

```
GET /api/projects/[id]/holds
```

### Add Hold

```
POST /api/projects/[id]/holds
```

**Body:**
```json
{
  "package": "package-name"
}
```

### Remove Hold

```
DELETE /api/projects/[id]/holds
```

**Body:**
```json
{
  "package": "package-name"
}
```

## System

### Get System Metrics

```
GET /api/system/metrics
```

**Response:**
```json
{
  "cpu": 25.5,
  "memory": {
    "used": 8000000000,
    "total": 16000000000,
    "percent": 50
  },
  "disk": {
    "used": 100000000000,
    "total": 500000000000,
    "percent": 20
  }
}
```

### Get Config

```
GET /api/config
```

Returns public configuration values.

## Logs

### Query Logs

```
GET /api/logs
```

**Query Parameters:**
- `level` - Filter by level (debug, info, warn, error)
- `category` - Filter by category
- `projectId` - Filter by project
- `search` - Search text
- `limit` - Max entries (default: 100)
- `offset` - Pagination offset

**Response:**
```json
{
  "entries": [
    {
      "timestamp": "2025-01-29T10:00:00Z",
      "level": "info",
      "category": "projects",
      "message": "Project started",
      "projectId": "my-app",
      "metadata": {}
    }
  ],
  "total": 1000,
  "hasMore": true
}
```

## Settings

### Get Global Settings

```
GET /api/settings
```

### Update Global Settings

```
PUT /api/settings
```

**Body:** Full settings object

### Get Project Settings

```
GET /api/projects/[id]/settings
```

### Update Project Settings

```
PUT /api/projects/[id]/settings
```

### Verify Vercel Token

```
POST /api/settings/verify-vercel
```

**Body:**
```json
{
  "token": "vercel-token",
  "teamId": "team_xxx"
}
```

## Vercel

### Get Vercel Status

```
GET /api/projects/[id]/vercel
```

### Deploy to Vercel

```
POST /api/projects/[id]/vercel
```

**Body:**
```json
{
  "production": false
}
```

## WebSocket

### Shell Terminal

```
ws://localhost:3000/api/shell/ws?cwd=/path/to/directory
```

**Query Parameters:**
- `cwd` - Working directory for shell

**Messages:** Binary data (terminal I/O)

## Sidebar

### Get Sidebar Data

```
GET /api/sidebar
```

Lightweight endpoint for sidebar rendering.

**Response:**
```json
{
  "projects": [
    {
      "id": "my-app",
      "name": "My App",
      "category": "Product",
      "status": "running"
    }
  ],
  "categories": ["Product", "Client"]
}
```

## Error Responses

All endpoints return errors in this format:

```json
{
  "success": false,
  "error": "Error message"
}
```

HTTP status codes:
- `400` - Bad request (invalid parameters)
- `404` - Not found (project doesn't exist)
- `500` - Server error
