# Contributing to HexOps

Thank you for your interest in contributing to HexOps! This guide will help you get started.

## Quick Start

1. Fork the repository
2. Clone your fork: `git clone https://github.com/yourusername/hexops.git`
3. Install dependencies: `pnpm install`
4. Copy config: `cp hexops.config.example.json hexops.config.json`
5. Start development: `pnpm dev`

## Development Setup

### Prerequisites

- Node.js 20 or higher
- pnpm 9 or higher
- Git

### Configuration

Edit `hexops.config.json` with paths to your local projects. At minimum, you need one project to test with:

```json
{
  "projects": [
    {
      "id": "test-project",
      "name": "Test Project",
      "path": "/path/to/any/node/project",
      "port": 3001,
      "category": "Personal",
      "scripts": {
        "dev": "pnpm dev"
      }
    }
  ],
  "categories": ["Personal"]
}
```

### Running Locally

```bash
# Development mode with hot reload
pnpm dev

# Build for production
pnpm build

# Start production server
pnpm start

# Run linting
pnpm lint
```

## Code Style

### General Guidelines

- TypeScript strict mode is enabled
- Use Tailwind CSS for styling (no inline styles)
- Use shadcn/ui components from `@/components/ui`
- Follow existing patterns in the codebase

### File Organization

```
src/
├── app/                 # Next.js App Router pages and API routes
│   ├── api/            # API endpoints
│   └── [page]/         # Page components
├── components/         # React components
│   ├── ui/            # shadcn/ui base components
│   └── detail-sections/ # Project detail page sections
└── lib/               # Utilities, types, and business logic
```

### Component Conventions

- Use functional components with TypeScript
- Props interfaces should be named `ComponentNameProps`
- Keep components focused and single-purpose
- Extract reusable logic into custom hooks

### API Route Conventions

- Use Next.js App Router route handlers
- Return JSON responses with appropriate status codes
- Handle errors gracefully with meaningful messages
- Log operations using the logger utility

## Pull Request Process

1. Create a feature branch from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes with clear, focused commits

3. Test your changes locally:
   - Verify the feature works as expected
   - Check for console errors
   - Test on different screen sizes if UI changes

4. Push your branch and create a pull request

5. In your PR description:
   - Describe what the PR does
   - Note any breaking changes
   - Include screenshots for UI changes

## Project Structure

### Key Directories

| Directory | Purpose |
|-----------|---------|
| `src/app/` | Pages and API routes |
| `src/components/` | React components |
| `src/lib/` | Shared utilities and types |
| `docs/` | Documentation |
| `.hexops/` | Runtime data (logs, cache) |

### Key Files

| File | Purpose |
|------|---------|
| `hexops.config.json` | User configuration (gitignored) |
| `hexops.config.example.json` | Example configuration |
| `server.js` | Custom Next.js server (WebSocket support) |
| `src/lib/types.ts` | TypeScript type definitions |
| `src/lib/config.ts` | Configuration loading |
| `src/lib/process-manager.ts` | Dev server process management |

## Getting Help

- Check existing issues for similar problems
- Open a new issue with a clear description
- Include steps to reproduce for bugs

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
