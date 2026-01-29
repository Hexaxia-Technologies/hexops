# Extending HexOps

Guide for adding new features to HexOps.

## Adding a New Page

### 1. Create the Page Component

Create a new file in `src/app/[page-name]/page.tsx`:

```typescript
'use client';

import { useState, useEffect } from 'react';

export default function MyPage() {
  return (
    <main className="flex-1 flex flex-col overflow-hidden">
      <header className="border-b border-zinc-800 px-6 py-4">
        <h1 className="text-xl font-semibold text-zinc-100">Page Title</h1>
      </header>

      <div className="flex-1 overflow-auto p-6">
        {/* Page content */}
      </div>
    </main>
  );
}
```

### 2. Add Navigation

Add a link in `src/components/sidebar.tsx`:

```typescript
<NavItem href="/my-page" icon={<MyIcon />}>
  My Page
</NavItem>
```

## Adding an API Endpoint

### 1. Create Route Handler

Create `src/app/api/[endpoint]/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import { logger } from '@/lib/logger';

export async function GET(request: NextRequest) {
  try {
    // Your logic here
    const data = { /* ... */ };

    logger.info('Operation completed', { category: 'api' });

    return Response.json(data);
  } catch (error) {
    logger.error('Operation failed', {
      category: 'api',
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    return Response.json(
      { error: 'Operation failed' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  // Handle POST
}
```

### 2. Dynamic Routes

For routes with parameters, create `src/app/api/[param]/route.ts`:

```typescript
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // Use id
}
```

## Adding a UI Component

### 1. Create Component

Create in `src/components/my-component.tsx`:

```typescript
'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

interface MyComponentProps {
  title: string;
  onAction: () => void;
}

export function MyComponent({ title, onAction }: MyComponentProps) {
  const [loading, setLoading] = useState(false);

  return (
    <div className="border border-zinc-800 rounded-lg p-4">
      <h3 className="text-sm font-medium text-zinc-200">{title}</h3>
      <Button
        onClick={onAction}
        disabled={loading}
        className="mt-2"
      >
        Action
      </Button>
    </div>
  );
}
```

### 2. Use shadcn/ui Components

Available in `src/components/ui/`:
- `button.tsx`
- `badge.tsx`
- `card.tsx`
- `dialog.tsx`
- `select.tsx`
- `scroll-area.tsx`

## Adding a Detail Section

For project detail page sections:

### 1. Create Section Component

Create in `src/components/detail-sections/my-section.tsx`:

```typescript
'use client';

import { useState, useEffect } from 'react';

interface MySectionProps {
  projectId: string;
}

export function MySection({ projectId }: MySectionProps) {
  const [data, setData] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/projects/${projectId}/my-endpoint`)
      .then(res => res.json())
      .then(setData)
      .finally(() => setIsLoading(false));
  }, [projectId]);

  if (isLoading) {
    return <div>Loading...</div>;
  }

  return (
    <div className="space-y-3">
      {/* Section content */}
    </div>
  );
}
```

### 2. Add to Project Detail

In `src/components/project-detail.tsx`, add a collapsible section:

```typescript
<CollapsibleSection
  title="My Section"
  icon={<MyIcon className="h-4 w-4 text-zinc-500" />}
  defaultOpen={false}
>
  <MySection projectId={project.id} />
</CollapsibleSection>
```

## Adding Logging

Use the logger for all operations:

```typescript
import { logger } from '@/lib/logger';

// Info level for normal operations
logger.info('Operation completed', {
  category: 'projects',
  projectId: 'my-app',
  metadata: { key: 'value' }
});

// Warn for recoverable issues
logger.warn('Slow operation', {
  category: 'system',
  metadata: { duration: 5000 }
});

// Error for failures
logger.error('Operation failed', {
  category: 'api',
  error: error.message,
  projectId: 'my-app'
});
```

### Log Categories

- `projects` - Project operations
- `patches` - Package updates
- `git` - Git operations
- `api` - API requests
- `system` - System-level events

## Type Definitions

Add types in `src/lib/types.ts`:

```typescript
export interface MyType {
  id: string;
  name: string;
  // ...
}

// Extend existing types
export interface ProjectConfig {
  // existing fields...
  myNewField?: string;
}
```

## Configuration Changes

### Adding Config Options

1. Update types in `src/lib/types.ts`
2. Update defaults in `src/lib/config.ts`
3. Update example in `hexops.config.example.json`
4. Document in `docs/configuration.md`

### Reading Config

```typescript
import { loadConfig, getProject } from '@/lib/config';

const config = loadConfig();
const project = getProject('my-app');
```

### Saving Config

```typescript
import { saveConfig, loadConfig } from '@/lib/config';

const config = loadConfig();
config.projects[0].myField = 'value';
saveConfig(config);
```

## Testing Changes

### Manual Testing

1. Start dev server: `pnpm dev`
2. Test in browser at `http://localhost:3000`
3. Check console for errors
4. Verify API responses in Network tab

### Linting

```bash
pnpm lint
```

## Best Practices

1. **TypeScript** - Use strict types, no `any`
2. **Error Handling** - Always catch and log errors
3. **Loading States** - Show loading indicators
4. **Toast Notifications** - Feedback for actions
5. **Consistent Styling** - Use Tailwind classes
6. **Component Composition** - Small, focused components
