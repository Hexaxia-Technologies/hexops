# Development

Documentation for contributors and developers extending HexOps.

## Guides

- [Architecture](architecture.md) - System design and data flow
- [API Reference](api-reference.md) - All API endpoints
- [Extending](extending.md) - Adding new features

## Quick Links

- [Contributing Guide](../../CONTRIBUTING.md) - How to contribute
- [Changelog](../../CHANGELOG.md) - Version history

## Development Setup

```bash
# Clone and install
git clone https://github.com/yourusername/hexops.git
cd hexops
pnpm install

# Configure
cp hexops.config.example.json hexops.config.json
# Edit with your project paths

# Start dev server
pnpm dev
```

## Tech Stack

| Technology | Purpose |
|------------|---------|
| Next.js 16 | React framework with App Router |
| React 19 | UI library |
| TypeScript | Type safety |
| Tailwind CSS | Styling |
| shadcn/ui | Component library |
| Radix UI | Accessible primitives |
| xterm.js | Terminal emulator |
| node-pty | PTY shell spawning |
| Recharts | Charts and graphs |

## Project Structure

```
src/
├── app/                 # Next.js App Router
│   ├── api/            # API routes
│   ├── logs/           # Logs page
│   ├── patches/        # Patches page
│   ├── projects/       # Project detail pages
│   └── settings/       # Settings page
├── components/         # React components
│   ├── ui/            # Base UI components
│   └── detail-sections/ # Project detail sections
└── lib/               # Utilities and business logic
    ├── config.ts      # Configuration loading
    ├── logger.ts      # Logging system
    ├── process-manager.ts # Dev server management
    └── types.ts       # TypeScript types
```
