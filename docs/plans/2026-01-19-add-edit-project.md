# Add/Edit Project Feature Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add ability to create new projects and edit existing ones from the UI

**Architecture:** Modal dialog for add (triggered from sidebar), edit button in project details. Path-first flow with auto-detection from package.json, manual override for all fields.

**Tech Stack:** Next.js API routes, React dialog components, filesystem operations

---

## Task 1: Create API endpoint for path scanning

**Files:**
- Create: `src/app/api/projects/scan-path/route.ts`

**Step 1: Create the scan-path API endpoint**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { getProjects } from '@/lib/config';

export async function POST(request: NextRequest) {
  try {
    const { path } = await request.json();

    if (!path || typeof path !== 'string') {
      return NextResponse.json({ error: 'Path is required' }, { status: 400 });
    }

    // Check if path exists
    if (!existsSync(path)) {
      return NextResponse.json({ error: 'Path does not exist' }, { status: 400 });
    }

    // Try to read package.json
    const pkgPath = join(path, 'package.json');
    let packageJson: Record<string, unknown> | null = null;

    if (existsSync(pkgPath)) {
      try {
        packageJson = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      } catch {
        // Invalid JSON, continue without it
      }
    }

    // Get existing projects to suggest next port
    const existingProjects = getProjects();
    const maxPort = Math.max(...existingProjects.map(p => p.port), 2990);
    const suggestedPort = Math.ceil((maxPort + 10) / 10) * 10; // Round up to next 10

    // Extract info from package.json
    const scripts = packageJson?.scripts as Record<string, string> | undefined;

    return NextResponse.json({
      exists: true,
      name: packageJson?.name || basename(path),
      description: packageJson?.description || '',
      suggestedPort,
      scripts: {
        dev: scripts?.dev || 'npm run dev',
        build: scripts?.build || 'npm run build',
      },
      availableScripts: scripts ? Object.keys(scripts) : [],
      hasPackageJson: !!packageJson,
    });
  } catch (error) {
    console.error('Error scanning path:', error);
    return NextResponse.json({ error: 'Failed to scan path' }, { status: 500 });
  }
}
```

**Step 2: Verify endpoint works**

Run: `curl -X POST http://localhost:3000/api/projects/scan-path -H "Content-Type: application/json" -d '{"path":"/home/aaron/Projects/hexops"}'`

Expected: JSON with name, description, suggestedPort, scripts

**Step 3: Commit**

```bash
git add src/app/api/projects/scan-path/route.ts
git commit -m "feat: add scan-path API for project auto-detection"
```

---

## Task 2: Create API endpoint for saving projects

**Files:**
- Create: `src/app/api/projects/save/route.ts`
- Modify: `src/lib/config.ts` (add saveConfig function)

**Step 1: Add saveConfig function to config.ts**

Find the config loading code and add a save function that writes back to hexops.config.json.

**Step 2: Create the save API endpoint**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getProjects, getCategories, saveConfig } from '@/lib/config';
import type { ProjectConfig } from '@/lib/types';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { project, isNew } = body as { project: ProjectConfig; isNew: boolean };

    // Validate required fields
    if (!project.id || !project.name || !project.path || !project.port || !project.category) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const existingProjects = getProjects();
    const categories = getCategories();

    if (isNew) {
      // Check for duplicate ID
      if (existingProjects.some(p => p.id === project.id)) {
        return NextResponse.json({ error: 'Project ID already exists' }, { status: 400 });
      }
      // Check for duplicate port
      if (existingProjects.some(p => p.port === project.port)) {
        return NextResponse.json({ error: 'Port already in use' }, { status: 400 });
      }
      existingProjects.push(project);
    } else {
      // Update existing
      const index = existingProjects.findIndex(p => p.id === project.id);
      if (index === -1) {
        return NextResponse.json({ error: 'Project not found' }, { status: 404 });
      }
      // Check port conflict (excluding self)
      if (existingProjects.some(p => p.port === project.port && p.id !== project.id)) {
        return NextResponse.json({ error: 'Port already in use' }, { status: 400 });
      }
      existingProjects[index] = project;
    }

    // Add new category if needed
    const updatedCategories = categories.includes(project.category)
      ? categories
      : [...categories, project.category];

    saveConfig({ projects: existingProjects, categories: updatedCategories });

    return NextResponse.json({ success: true, project });
  } catch (error) {
    console.error('Error saving project:', error);
    return NextResponse.json({ error: 'Failed to save project' }, { status: 500 });
  }
}
```

**Step 3: Commit**

```bash
git add src/app/api/projects/save/route.ts src/lib/config.ts
git commit -m "feat: add save project API endpoint"
```

---

## Task 3: Create AddProjectDialog component

**Files:**
- Create: `src/components/add-project-dialog.tsx`

**Step 1: Create the dialog component**

Component with:
- Path input (triggers scan on blur)
- Auto-filled fields: name, description, port, scripts
- Category dropdown with "Add new..." option
- ID field (auto-generated, editable)
- Save/Cancel buttons
- Loading and error states

**Step 2: Commit**

```bash
git add src/components/add-project-dialog.tsx
git commit -m "feat: add AddProjectDialog component"
```

---

## Task 4: Add "+" button to Sidebar

**Files:**
- Modify: `src/components/sidebar.tsx`

**Step 1: Add Plus icon import and onAddProject prop**

**Step 2: Add button below category list**

Small "+" button that triggers `onAddProject` callback.

**Step 3: Commit**

```bash
git add src/components/sidebar.tsx
git commit -m "feat: add project button in sidebar"
```

---

## Task 5: Integrate AddProjectDialog in main page

**Files:**
- Modify: `src/app/page.tsx`

**Step 1: Import AddProjectDialog**

**Step 2: Add state for dialog visibility**

**Step 3: Pass onAddProject to Sidebar, render dialog**

**Step 4: Refresh projects after successful add**

**Step 5: Commit**

```bash
git add src/app/page.tsx
git commit -m "feat: integrate add project dialog in dashboard"
```

---

## Task 6: Add Edit button to ProjectDetail

**Files:**
- Modify: `src/components/project-detail.tsx`

**Step 1: Add edit state and EditProjectDialog (reuse AddProjectDialog with mode prop)**

**Step 2: Add Edit button in header area**

**Step 3: Pre-fill dialog with existing project data**

**Step 4: Refresh after save**

**Step 5: Commit**

```bash
git add src/components/project-detail.tsx
git commit -m "feat: add edit project button in project details"
```

---

## Task 7: Add dialog to patches page sidebar

**Files:**
- Modify: `src/app/patches/page.tsx`

**Step 1: Import and integrate AddProjectDialog**

**Step 2: Pass onAddProject to Sidebar**

**Step 3: Commit**

```bash
git add src/app/patches/page.tsx
git commit -m "feat: add project button available on patches page"
```

---

## Verification

1. Click "+" in sidebar → dialog opens
2. Enter valid path → fields auto-populate
3. Modify any field → changes persist
4. Select existing category or add new one
5. Save → project appears in list
6. Go to project details → click Edit
7. Modify fields → Save → changes reflected
8. Try invalid path → error shown
9. Try duplicate port → error shown
