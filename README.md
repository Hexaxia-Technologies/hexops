# HexOps

A developer operations dashboard for managing multiple local development projects from a single interface. Start and stop dev servers, monitor system health, manage package updates, view logs, and deploy to Vercel.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Version](https://img.shields.io/badge/version-0.9.0-green.svg)

## Features

- **Project Management** - Start/stop dev servers, view logs, manage configurations
- **Patches Dashboard** - Scan all projects for outdated packages and vulnerabilities, batch update with one click
- **Package Holds** - Skip problematic packages during updates (per-project)
- **Integrated Terminal** - Full PTY shell in the browser via xterm.js
- **System Health** - Real-time CPU, memory, and disk monitoring
- **Git Integration** - View status, commit, push, pull from the UI
- **Vercel Deployments** - Deploy preview or production builds directly
- **Logging System** - Centralized logs with filtering, search, and live mode
- **Global & Project Settings** - Configure paths, git defaults, integrations

## Quick Start

```bash
# Clone the repository
git clone https://github.com/yourusername/hexops.git
cd hexops

# Install dependencies
pnpm install

# Copy and configure
cp hexops.config.example.json hexops.config.json
# Edit hexops.config.json with your project paths

# Start HexOps
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) to view the dashboard.

## Configuration

HexOps uses a JSON config file to define your projects:

```json
{
  "projects": [
    {
      "id": "my-app",
      "name": "My App",
      "path": "/path/to/project",
      "port": 3001,
      "category": "Product",
      "scripts": {
        "dev": "pnpm dev",
        "build": "pnpm build"
      }
    }
  ],
  "categories": ["Product", "Client", "Internal", "Personal"],
  "settings": {
    "paths": {
      "projectsRoot": "/path/to/projects"
    }
  }
}
```

See [Configuration Guide](docs/configuration.md) for all options.

## Documentation

- [Getting Started](docs/getting-started.md) - Installation and first run
- [Configuration](docs/configuration.md) - Full config reference
- [Features](docs/features/) - Detailed feature documentation
- [Development](docs/development/) - Contributing and architecture

## Tech Stack

- **Framework:** Next.js 16 with App Router
- **UI:** React 19, Tailwind CSS, shadcn/ui, Radix UI
- **Terminal:** xterm.js with node-pty
- **Charts:** Recharts, ApexCharts

## Requirements

- Node.js 20+
- pnpm 9+
- Git

## License

MIT License - see [LICENSE](LICENSE) for details.

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.
