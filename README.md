# HexOps

A developer operations dashboard for managing multiple local development projects from a single interface. Start and stop dev servers, monitor system health, manage package updates, view logs, and deploy to Vercel.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Version](https://img.shields.io/badge/version-0.9.0-green.svg)

## Why HexOps?

If you're managing more than a handful of local projects, you know the chaos:

**The daily grind without HexOps:**
- Open a terminal. `cd` to project A. `pnpm dev`. Open another terminal. `cd` to project B. `pnpm dev`. Repeat.
- "Which terminal was that running in again?"
- "Is port 3001 taken? Let me check... `lsof -i :3001`..."
- "When did I last update dependencies on this project?" (You didn't.)
- Context-switch between 6 terminal windows to find the one with the error
- Forget which projects have uncommitted changes

**The security scramble:**

When a critical CVE drops, the clock starts ticking. Remember the Next.js middleware bypass (CVE-2025-29927)? Or the React vulnerabilities that required immediate patches across the ecosystem?

Without a central view, patching looks like this:
1. Check project A. `pnpm outdated`. Update. Test. Commit.
2. Repeat for projects B through P.
3. Miss one. Find out the hard way.

With HexOps, you scan every project, whether you have 5 or 50, quickly, see exactly which ones are affected, and batch update with one click. What used to be an afternoon of `cd` and `pnpm update` becomes a 5-minute operation.

**With HexOps:**
- One dashboard. All your projects. Start, stop, monitor.
- See system health, git status, and outdated packages at a glance
- Scan every project for vulnerabilities, update in one click
- Hold specific packages that break things (looking at you, ESLint 9)
- Open a terminal in any project directory without leaving the browser
- Deploy to Vercel without touching the CLI

HexOps exists because I got tired of the terminal juggling act. It's the tool I wished existed, so I built it.

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
git clone https://github.com/Hexaxia-Technologies/hexops.git
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

## About

HexOps is built and maintained by [Hexaxia Technologies](https://hexaxia.tech), a bespoke IT consultancy specializing in infrastructure, security, and custom tooling for growing companies.
