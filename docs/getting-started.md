# Getting Started

This guide walks you through installing and running HexOps for the first time.

## Prerequisites

Before installing HexOps, ensure you have:

- **Node.js 20+** - [Download](https://nodejs.org/)
- **pnpm 9+** - Install with `npm install -g pnpm`
- **Git** - For version control features

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/yourusername/hexops.git
cd hexops
```

### 2. Install Dependencies

```bash
pnpm install
```

This installs all required packages including node-pty for the integrated terminal.

### 3. Create Configuration

Copy the example configuration file:

```bash
cp hexops.config.example.json hexops.config.json
```

### 4. Configure Your Projects

Edit `hexops.config.json` to add your projects:

```json
{
  "projects": [
    {
      "id": "my-app",
      "name": "My Application",
      "description": "Main web application",
      "path": "/home/user/projects/my-app",
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
      "projectsRoot": "/home/user/projects"
    }
  }
}
```

**Important:** Use absolute paths for the `path` field.

### 5. Start HexOps

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## First Run

When you first open HexOps, you will see:

1. **Sidebar** - Navigation and project filtering
2. **Dashboard** - System health metrics and project list
3. **Project List** - All configured projects with status

### Starting a Project

1. Find your project in the list
2. Click the play button to start the dev server
3. The status indicator turns green when running
4. Click the project row to open the detail panel

### Viewing Logs

1. Click on a running project
2. The right panel shows live logs
3. Use the Logs page for filtering and search

## Next Steps

- [Configuration](configuration.md) - Learn all configuration options
- [Features](features/) - Explore each feature in detail
- [Dashboard](features/dashboard.md) - Understand the main interface

## Troubleshooting

### Port Already in Use

If a project fails to start with a port conflict:

1. Check if another process is using the port: `lsof -i :PORT`
2. Stop the conflicting process or change the port in config

### node-pty Build Errors

If the terminal feature fails:

1. Ensure you have build tools installed
2. On Ubuntu/Debian: `sudo apt install build-essential`
3. Rebuild: `pnpm rebuild node-pty`

### Permission Errors

Ensure HexOps has read/write access to:

- Project directories (for running dev servers)
- `.hexops/` directory (for logs and cache)
