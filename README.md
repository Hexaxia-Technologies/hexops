# HexOps

Internal development operations dashboard for managing dev servers across multiple projects.

## Features

- **Dashboard** - View all projects, start/stop dev servers, monitor status
- **Project Detail** - cPanel-style control panel with git, metrics, Vercel deploy
- **Patches** - Scan for vulnerabilities and outdated packages, batch update
- **Package Holds** - Skip problematic packages during updates

## Getting Started

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000)

## Configuration

Projects are defined in `hexops.config.json`:

```json
{
  "projects": [
    {
      "id": "my-project",
      "name": "My Project",
      "path": "/path/to/project",
      "port": 3001,
      "category": "Product",
      "scripts": {
        "dev": "pnpm dev",
        "build": "pnpm build"
      }
    }
  ],
  "categories": ["Product", "Client", "Internal", "Personal"]
}
```

## Documentation

See [docs/dev-notes.md](docs/dev-notes.md) for detailed development notes and API documentation.
