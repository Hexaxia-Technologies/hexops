# HexOps Escalate State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third patch state — Escalate — for `fixAvailable: false` vulnerabilities, with three resolution options: Force Override, Force Major Bump, and Accept Risk.

**Architecture:** New `escalations.json` store in `.hexops/patches/`, a new API route for escalation CRUD, scanner integration to suppress/annotate escalated vulns, and a modal component on the patches page. No test framework exists — TypeScript compilation + biome lint serve as type-level verification; UI steps include manual acceptance criteria.

**Tech Stack:** Next.js App Router, TypeScript, React, Biome (lint), existing `patch-scanner.ts` / `patch-storage.ts` patterns.

**Spec:** `docs/superpowers/specs/2026-04-21-hexops-escalate-state-design.md`
**Issue:** #70

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/lib/types.ts` | Modify | Add `EscalateRecord`, `EscalationConfig`, extend `ProjectConfig` and `PatchQueueItem` |
| `src/lib/escalation-store.ts` | Create | CRUD for `.hexops/patches/escalations.json` |
| `src/app/api/projects/[id]/escalate/route.ts` | Create | POST (create + execute) and DELETE (reverse) handlers |
| `src/lib/patch-scanner.ts` | Modify | Suppress/annotate queue items based on escalation records |
| `src/components/escalate-modal.tsx` | Create | Modal with 3 options + Oh Shit button |
| `src/components/accepted-risk-panel.tsx` | Create | Per-project collapsible panel for accepted-risk records |
| `src/app/patches/page.tsx` | Modify | Escalate button on rows, wire modal, accepted-risk panel, major-bump banner |

---

## Task 1: Add Types

**Files:**
- Modify: `src/lib/types.ts`

- [ ] **Step 1: Add `EscalationConfig` and `EscalateRecord` to types.ts**

Open `src/lib/types.ts` and add after the `DependabotConfig` block (after line 156):

```typescript
// Escalation Types

export type EscalateAction = 'force_override' | 'force_major' | 'accepted_risk'

export interface EscalationConfig {
  acceptedRiskMaxDays: number   // default 90
  autoCommit: boolean           // force_override: commit after patching
  autoPush: boolean             // force_override: push after committing
}

export interface EscalateRecord {
  id: string                    // uuid (crypto.randomUUID())
  projectId: string
  package: string
  action: EscalateAction
  reason: string
  createdAt: string             // ISO 8601
  expiresAt?: string            // accepted_risk only
  resolvedAt?: string           // set by scanner when upstream patch becomes available
  overrideVersion?: string      // force_override: version pinned to
  targetVersion?: string        // force_major: target version
}

export interface EscalationStore {
  records: EscalateRecord[]
}
```

- [ ] **Step 2: Add `escalation` to `ProjectConfig`**

In `src/lib/types.ts`, find the `ProjectConfig` interface (line 1) and add after `holds?: string[]`:

```typescript
  escalation?: Partial<EscalationConfig>
```

- [ ] **Step 3: Add escalation annotation fields to `PatchQueueItem`**

In `src/lib/types.ts`, find `PatchQueueItem` (line 164) and add after `advisoryId?: number`:

```typescript
  // Escalation state (set by scanner when an EscalateRecord exists for this package)
  escalationId?: string
  escalationStatus?: 'accepted_risk' | 'accepted_risk_expired' | 'force_override_pending' | 'force_major_pending'
  escalationReason?: string
  escalationExpiresAt?: string
```

- [ ] **Step 4: Verify types compile**

```bash
cd /home/aaron/Projects/hexops && npx tsc --noEmit 2>&1 | head -20
```

Expected: no output (no errors). If errors appear, fix before continuing.

- [ ] **Step 5: Commit**

```bash
cd /home/aaron/Projects/hexops && git add src/lib/types.ts && git commit -m "feat(escalate): add EscalateRecord, EscalationConfig types + PatchQueueItem annotations"
```

---

## Task 2: Escalation Store

**Files:**
- Create: `src/lib/escalation-store.ts`

- [ ] **Step 1: Create the store file**

Create `src/lib/escalation-store.ts`:

```typescript
import fs from 'fs'
import path from 'path'
import type { EscalateRecord, EscalationStore } from './types'

const ESCALATIONS_PATH = path.join(process.cwd(), '.hexops', 'patches', 'escalations.json')

function readStore(): EscalationStore {
  if (!fs.existsSync(ESCALATIONS_PATH)) {
    return { records: [] }
  }
  try {
    return JSON.parse(fs.readFileSync(ESCALATIONS_PATH, 'utf-8')) as EscalationStore
  } catch {
    return { records: [] }
  }
}

function writeStore(store: EscalationStore): void {
  fs.mkdirSync(path.dirname(ESCALATIONS_PATH), { recursive: true })
  fs.writeFileSync(ESCALATIONS_PATH, JSON.stringify(store, null, 2))
}

export function getAllEscalations(): EscalateRecord[] {
  return readStore().records
}

export function getEscalationsForProject(projectId: string): EscalateRecord[] {
  return readStore().records.filter(r => r.projectId === projectId)
}

export function addEscalation(record: EscalateRecord): void {
  const store = readStore()
  // Remove any existing record for same project+package (one active record per package per project)
  store.records = store.records.filter(
    r => !(r.projectId === record.projectId && r.package === record.package && !r.resolvedAt)
  )
  store.records.push(record)
  writeStore(store)
}

export function removeEscalation(id: string): boolean {
  const store = readStore()
  const before = store.records.length
  store.records = store.records.filter(r => r.id !== id)
  if (store.records.length === before) return false
  writeStore(store)
  return true
}

export function resolveEscalation(id: string): void {
  const store = readStore()
  const record = store.records.find(r => r.id === id)
  if (record) {
    record.resolvedAt = new Date().toISOString()
    writeStore(store)
  }
}

export function getEscalationConfig(projectConfig: { escalation?: { acceptedRiskMaxDays?: number; autoCommit?: boolean; autoPush?: boolean } }): {
  acceptedRiskMaxDays: number
  autoCommit: boolean
  autoPush: boolean
} {
  return {
    acceptedRiskMaxDays: projectConfig.escalation?.acceptedRiskMaxDays ?? 90,
    autoCommit: projectConfig.escalation?.autoCommit ?? false,
    autoPush: projectConfig.escalation?.autoPush ?? false,
  }
}
```

- [ ] **Step 2: Verify compilation**

```bash
cd /home/aaron/Projects/hexops && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /home/aaron/Projects/hexops && git add src/lib/escalation-store.ts && git commit -m "feat(escalate): add escalation-store (CRUD for escalations.json)"
```

---

## Task 3: POST Escalation API Route

**Files:**
- Create: `src/app/api/projects/[id]/escalate/route.ts`

Look at `src/app/api/projects/[id]/update/route.ts` for the pattern used to load project config, run shell commands, commit, and push. Replicate those patterns here.

- [ ] **Step 1: Create the escalate route**

Create `src/app/api/projects/[id]/escalate/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { loadConfig } from '@/lib/config'
import { addEscalation, getEscalationConfig } from '@/lib/escalation-store'
import { resolveLockfile } from '@/lib/lockfile-resolver'
import type { EscalateAction, EscalateRecord } from '@/lib/types'
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'

interface EscalateRequestBody {
  package: string
  action: EscalateAction
  reason: string
  overrideVersion?: string
  targetVersion?: string
  expiresAt?: string
  emergency?: boolean
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = (await request.json()) as EscalateRequestBody

  const config = loadConfig()
  const project = config.projects.find(p => p.id === id)
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  const { package: pkg, action, reason, overrideVersion, targetVersion, expiresAt, emergency } = body

  if (!pkg || !action || !reason) {
    return NextResponse.json({ error: 'package, action, and reason are required' }, { status: 400 })
  }

  const escalationCfg = getEscalationConfig(project)

  const record: EscalateRecord = {
    id: crypto.randomUUID(),
    projectId: id,
    package: pkg,
    action,
    reason,
    createdAt: new Date().toISOString(),
    ...(overrideVersion && { overrideVersion }),
    ...(targetVersion && { targetVersion }),
    ...(expiresAt && { expiresAt }),
  }

  try {
    if (action === 'force_override') {
      if (!overrideVersion) {
        return NextResponse.json({ error: 'overrideVersion required for force_override' }, { status: 400 })
      }
      // Inject override into package.json
      const pkgJsonPath = path.join(project.path, 'package.json')
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'))
      pkgJson.overrides = { ...pkgJson.overrides, [pkg]: overrideVersion }
      if (pkgJson.pnpm) {
        pkgJson.pnpm.overrides = { ...pkgJson.pnpm?.overrides, [pkg]: overrideVersion }
      }
      fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n')

      // Regenerate lockfile
      const lockfileResult = await resolveLockfile(project.path, 'repair')
      if (!lockfileResult.success) {
        // Revert package.json change
        execSync('git checkout -- package.json', { cwd: project.path })
        return NextResponse.json({ error: `Lockfile regeneration failed: ${lockfileResult.error}` }, { status: 500 })
      }

      const shouldCommit = emergency || escalationCfg.autoCommit
      const shouldPush = emergency || (escalationCfg.autoCommit && escalationCfg.autoPush)

      if (shouldCommit) {
        execSync(`git add package.json ${lockfileResult.lockfileName ?? ''}`, { cwd: project.path })
        execSync(`git commit -m "fix(deps): force override ${pkg}@${overrideVersion} — ${reason}"`, { cwd: project.path })
      }
      if (shouldPush) {
        execSync('git push', { cwd: project.path })
      }

      record.overrideVersion = overrideVersion
    }

    if (action === 'force_major') {
      if (!targetVersion) {
        return NextResponse.json({ error: 'targetVersion required for force_major' }, { status: 400 })
      }
      // Update package.json dep version only — never auto-commit
      const pkgJsonPath = path.join(project.path, 'package.json')
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'))
      for (const depSection of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
        if (pkgJson[depSection]?.[pkg]) {
          pkgJson[depSection][pkg] = `^${targetVersion}`
          break
        }
      }
      fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n')
      // Do NOT commit — leave dirty for human review
    }

    if (action === 'accepted_risk') {
      // Validate expiry
      if (expiresAt) {
        const maxDate = new Date()
        maxDate.setDate(maxDate.getDate() + escalationCfg.acceptedRiskMaxDays)
        if (new Date(expiresAt) > maxDate) {
          record.expiresAt = maxDate.toISOString()
        }
      }
      // No file changes — just record
    }

    addEscalation(record)
    return NextResponse.json({ success: true, record })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const { escalationId } = await request.json() as { escalationId: string }

  if (!escalationId) {
    return NextResponse.json({ error: 'escalationId required' }, { status: 400 })
  }

  const removed = removeEscalation(escalationId)
  if (!removed) {
    return NextResponse.json({ error: 'Escalation not found' }, { status: 404 })
  }

  return NextResponse.json({ success: true })
}
```

- [ ] **Step 2: Fix the missing import**

The DELETE handler uses `removeEscalation` but it wasn't imported. Add it to the import line at the top:

```typescript
import { addEscalation, removeEscalation, getEscalationConfig } from '@/lib/escalation-store'
```

- [ ] **Step 3: Check what `resolveLockfile` actually exports**

```bash
grep -n "export" /home/aaron/Projects/hexops/src/lib/lockfile-resolver.ts | head -10
```

Adjust the import and call signature to match whatever `lockfile-resolver.ts` actually exports. The function name and return shape may differ — check before assuming.

- [ ] **Step 4: Verify compilation**

```bash
cd /home/aaron/Projects/hexops && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors. Fix any type mismatches before continuing.

- [ ] **Step 5: Commit**

```bash
cd /home/aaron/Projects/hexops && git add src/app/api/projects/[id]/escalate/route.ts && git commit -m "feat(escalate): add POST/DELETE escalate API route"
```

---

## Task 4: Scanner Integration

**Files:**
- Modify: `src/lib/patch-scanner.ts`

- [ ] **Step 1: Find where PatchQueueItems are finalized in patch-scanner.ts**

```bash
grep -n "PatchQueueItem\|fixAvailable\|priority" /home/aaron/Projects/hexops/src/lib/patch-scanner.ts | head -20
```

Identify the function that builds and returns the final `PatchQueueItem[]` array. This is where we'll inject escalation annotations.

- [ ] **Step 2: Add escalation annotation function**

In `src/lib/patch-scanner.ts`, add this import at the top:

```typescript
import { getAllEscalations } from './escalation-store'
import type { EscalateRecord } from './types'
```

Then add this helper function before the main scanner export:

```typescript
function annotateWithEscalations(items: PatchQueueItem[]): PatchQueueItem[] {
  const escalations = getAllEscalations()
  const now = new Date()

  return items.map(item => {
    const record = escalations.find(
      r => r.projectId === item.projectId && r.package === item.package && !r.resolvedAt
    )
    if (!record) return item

    // Check if upstream now provides a fix — auto-resolve
    if (item.fixAvailable && record.action !== 'accepted_risk') {
      // Scanner found a fix — mark resolved (fire-and-forget, don't block)
      import('./escalation-store').then(({ resolveEscalation }) => resolveEscalation(record.id))
      return item // re-surface as normal patchable
    }

    const base = {
      ...item,
      escalationId: record.id,
      escalationReason: record.reason,
    }

    if (record.action === 'accepted_risk') {
      const expired = record.expiresAt ? new Date(record.expiresAt) < now : false
      return {
        ...base,
        escalationStatus: expired ? 'accepted_risk_expired' as const : 'accepted_risk' as const,
        escalationExpiresAt: record.expiresAt,
      }
    }

    if (record.action === 'force_override') {
      return { ...base, escalationStatus: 'force_override_pending' as const }
    }

    if (record.action === 'force_major') {
      return { ...base, escalationStatus: 'force_major_pending' as const }
    }

    return item
  })
}
```

- [ ] **Step 3: Call annotateWithEscalations in the scanner**

Find the return statement of the function that builds `PatchQueueItem[]` (identified in Step 1). Wrap the returned array:

```typescript
// Before:
return items

// After:
return annotateWithEscalations(items)
```

- [ ] **Step 4: Filter out non-expired accepted_risk items from the active queue**

In the same function, after `annotateWithEscalations`, filter:

```typescript
return annotateWithEscalations(items).filter(
  item => item.escalationStatus !== 'accepted_risk'
)
```

Note: `accepted_risk_expired` items are NOT filtered — they re-surface with the expired badge.

- [ ] **Step 5: Verify compilation**

```bash
cd /home/aaron/Projects/hexops && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd /home/aaron/Projects/hexops && git add src/lib/patch-scanner.ts && git commit -m "feat(escalate): annotate patch queue items with escalation state"
```

---

## Task 5: EscalateModal Component

**Files:**
- Create: `src/components/escalate-modal.tsx`

- [ ] **Step 1: Check existing modal/dialog patterns in the codebase**

```bash
grep -rn "Dialog\|Modal" /home/aaron/Projects/hexops/src/components/ --include="*.tsx" -l | head -5
```

Open one of those files to understand which Dialog component is used (likely Radix UI `@radix-ui/react-dialog` via shadcn). Replicate the import pattern.

- [ ] **Step 2: Create EscalateModal**

Create `src/components/escalate-modal.tsx`:

```typescript
'use client'

import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Switch } from '@/components/ui/switch'
import { AlertTriangle, Zap } from 'lucide-react'
import type { PatchQueueItem, EscalateAction } from '@/lib/types'

interface EscalateModalProps {
  open: boolean
  item: PatchQueueItem | null
  projectEscalationConfig?: {
    acceptedRiskMaxDays?: number
    autoCommit?: boolean
    autoPush?: boolean
  }
  onClose: () => void
  onSuccess: (item: PatchQueueItem) => void
}

export function EscalateModal({ open, item, projectEscalationConfig, onClose, onSuccess }: EscalateModalProps) {
  const [action, setAction] = useState<EscalateAction>('force_override')
  const [reason, setReason] = useState('')
  const [overrideVersion, setOverrideVersion] = useState(item?.targetVersion ?? '')
  const [targetVersion, setTargetVersion] = useState(item?.targetVersion ?? '')
  const [expiresAt, setExpiresAt] = useState('')
  const [autoCommit, setAutoCommit] = useState(projectEscalationConfig?.autoCommit ?? false)
  const [autoPush, setAutoPush] = useState(projectEscalationConfig?.autoPush ?? false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const maxDays = projectEscalationConfig?.acceptedRiskMaxDays ?? 90
  const maxDate = new Date()
  maxDate.setDate(maxDate.getDate() + maxDays)

  async function submit(emergency = false) {
    if (!item || !reason.trim()) return
    setLoading(true)
    setError(null)

    try {
      const res = await fetch(`/api/projects/${item.projectId}/escalate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          package: item.package,
          action,
          reason: reason.trim(),
          ...(action === 'force_override' && { overrideVersion, autoCommit, autoPush }),
          ...(action === 'force_major' && { targetVersion }),
          ...(action === 'accepted_risk' && expiresAt && { expiresAt }),
          ...(emergency && { emergency: true }),
        }),
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Escalation failed')

      onSuccess(item)
      onClose()
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }

  if (!item) return null

  return (
    <Dialog open={open} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            Escalate: {item.package}
          </DialogTitle>
          {item.url && (
            <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-500 hover:underline">
              View advisory ↗
            </a>
          )}
        </DialogHeader>

        <div className="space-y-4 py-2">
          <RadioGroup value={action} onValueChange={v => setAction(v as EscalateAction)}>
            {/* Force Override */}
            <div className={`rounded-lg border p-3 cursor-pointer ${action === 'force_override' ? 'border-blue-500 bg-blue-50 dark:bg-blue-950' : ''}`}
              onClick={() => setAction('force_override')}>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="force_override" id="force_override" />
                <Label htmlFor="force_override" className="font-medium cursor-pointer">Force Override</Label>
              </div>
              <p className="text-xs text-muted-foreground mt-1 ml-6">
                Pin transitive dep via package.json overrides + regenerate lockfile
              </p>
              {action === 'force_override' && (
                <div className="mt-3 ml-6 space-y-3">
                  <div>
                    <Label className="text-xs">Pin to version</Label>
                    <Input
                      className="mt-1 h-8 text-sm"
                      value={overrideVersion}
                      onChange={e => setOverrideVersion(e.target.value)}
                      placeholder="e.g. 2.17.3"
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">Auto-commit</Label>
                    <Switch checked={autoCommit} onCheckedChange={setAutoCommit} />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground">Auto-push (requires auto-commit)</Label>
                    <Switch checked={autoPush} disabled={!autoCommit} onCheckedChange={setAutoPush} />
                  </div>
                </div>
              )}
            </div>

            {/* Force Major Bump */}
            <div className={`rounded-lg border p-3 cursor-pointer ${action === 'force_major' ? 'border-amber-500 bg-amber-50 dark:bg-amber-950' : ''}`}
              onClick={() => setAction('force_major')}>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="force_major" id="force_major" />
                <Label htmlFor="force_major" className="font-medium cursor-pointer">Force Major Bump</Label>
              </div>
              <p className="text-xs text-muted-foreground mt-1 ml-6">
                Updates package.json only. <strong>Never auto-commits.</strong> Review and commit manually.
              </p>
              {action === 'force_major' && (
                <div className="mt-3 ml-6">
                  <Label className="text-xs">Target version</Label>
                  <Input
                    className="mt-1 h-8 text-sm"
                    value={targetVersion}
                    onChange={e => setTargetVersion(e.target.value)}
                    placeholder="e.g. 4.0.0"
                  />
                  <p className="text-xs text-amber-600 mt-2">
                    ⚠ Breaking changes likely. Test thoroughly before merging.
                  </p>
                </div>
              )}
            </div>

            {/* Accept Risk */}
            <div className={`rounded-lg border p-3 cursor-pointer ${action === 'accepted_risk' ? 'border-orange-500 bg-orange-50 dark:bg-orange-950' : ''}`}
              onClick={() => setAction('accepted_risk')}>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="accepted_risk" id="accepted_risk" />
                <Label htmlFor="accepted_risk" className="font-medium cursor-pointer">Accept Risk</Label>
              </div>
              <p className="text-xs text-muted-foreground mt-1 ml-6">
                Suppress this vuln from the queue. Max {maxDays} days. Will re-surface on expiry.
              </p>
              {action === 'accepted_risk' && (
                <div className="mt-3 ml-6 space-y-2">
                  <Label className="text-xs">Expiry date (max {maxDate.toLocaleDateString()})</Label>
                  <Input
                    type="date"
                    className="h-8 text-sm"
                    max={maxDate.toISOString().split('T')[0]}
                    value={expiresAt ? expiresAt.split('T')[0] : ''}
                    onChange={e => setExpiresAt(e.target.value ? new Date(e.target.value).toISOString() : '')}
                  />
                </div>
              )}
            </div>
          </RadioGroup>

          {/* Reason — always required */}
          <div>
            <Label className="text-sm">Reason <span className="text-red-500">*</span></Label>
            <Textarea
              className="mt-1 text-sm"
              rows={2}
              placeholder="Why is this being escalated rather than patched normally?"
              value={reason}
              onChange={e => setReason(e.target.value)}
            />
          </div>

          {error && (
            <p className="text-xs text-red-500 bg-red-50 dark:bg-red-950 rounded p-2">{error}</p>
          )}
        </div>

        <DialogFooter className="flex items-center justify-between">
          <div>
            {action === 'force_override' && (
              <Button
                variant="destructive"
                size="sm"
                disabled={!reason.trim() || !overrideVersion || loading}
                onClick={() => submit(true)}
                className="gap-1"
              >
                <Zap className="h-3 w-3" />
                Patch Now
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose} disabled={loading}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!reason.trim() || loading}
              onClick={() => submit(false)}
            >
              {loading ? 'Working…' : 'Escalate'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 3: Verify imports exist**

```bash
grep -r "RadioGroup\|RadioGroupItem" /home/aaron/Projects/hexops/src/components/ui/ -l 2>/dev/null
```

If `radio-group` doesn't exist in `src/components/ui/`, install it:

```bash
cd /home/aaron/Projects/hexops && npx shadcn@latest add radio-group
```

- [ ] **Step 4: Verify compilation**

```bash
cd /home/aaron/Projects/hexops && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd /home/aaron/Projects/hexops && git add src/components/escalate-modal.tsx && git commit -m "feat(escalate): add EscalateModal component with 3 options + Patch Now button"
```

---

## Task 6: AcceptedRiskPanel Component

**Files:**
- Create: `src/components/accepted-risk-panel.tsx`

- [ ] **Step 1: Create the component**

Create `src/components/accepted-risk-panel.tsx`:

```typescript
'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, Clock, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { PatchQueueItem } from '@/lib/types'

interface AcceptedRiskPanelProps {
  projectId: string
  projectName: string
  items: PatchQueueItem[]   // items where escalationStatus === 'accepted_risk' or 'accepted_risk_expired'
  onReverse: (item: PatchQueueItem) => void
}

export function AcceptedRiskPanel({ projectId, projectName, items, onReverse }: AcceptedRiskPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const [reversing, setReversing] = useState<string | null>(null)

  if (items.length === 0) return null

  const expired = items.filter(i => i.escalationStatus === 'accepted_risk_expired')
  const active = items.filter(i => i.escalationStatus === 'accepted_risk')

  async function handleReverse(item: PatchQueueItem) {
    if (!item.escalationId) return
    setReversing(item.escalationId)
    try {
      await fetch(`/api/projects/${item.projectId}/escalate`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ escalationId: item.escalationId }),
      })
      onReverse(item)
    } finally {
      setReversing(null)
    }
  }

  function daysUntilExpiry(expiresAt: string) {
    const diff = new Date(expiresAt).getTime() - Date.now()
    return Math.ceil(diff / (1000 * 60 * 60 * 24))
  }

  return (
    <div className="mt-2 rounded-lg border border-orange-200 dark:border-orange-900 bg-orange-50/50 dark:bg-orange-950/20">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium text-orange-700 dark:text-orange-400"
        onClick={() => setExpanded(e => !e)}
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        Accepted Risk ({items.length})
        {expired.length > 0 && (
          <Badge variant="destructive" className="ml-1 text-xs h-4">
            {expired.length} expired
          </Badge>
        )}
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          {/* Expired items first */}
          {[...expired, ...active].map(item => {
            const isExpired = item.escalationStatus === 'accepted_risk_expired'
            const days = item.escalationExpiresAt ? daysUntilExpiry(item.escalationExpiresAt) : null

            return (
              <div
                key={item.escalationId}
                className={`flex items-start justify-between gap-3 rounded p-2 text-sm ${
                  isExpired ? 'bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800' : 'bg-white dark:bg-gray-900/50'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-xs font-medium">{item.package}</span>
                    {isExpired && (
                      <Badge variant="destructive" className="text-xs h-4">Expired</Badge>
                    )}
                    {!isExpired && days !== null && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        Expires in {days}d
                      </span>
                    )}
                  </div>
                  {item.escalationReason && (
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">{item.escalationReason}</p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs shrink-0"
                  disabled={reversing === item.escalationId}
                  onClick={() => handleReverse(item)}
                >
                  {reversing === item.escalationId ? '…' : 'Reverse'}
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify compilation**

```bash
cd /home/aaron/Projects/hexops && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /home/aaron/Projects/hexops && git add src/components/accepted-risk-panel.tsx && git commit -m "feat(escalate): add AcceptedRiskPanel component"
```

---

## Task 7: Wire Into Patches Page

**Files:**
- Modify: `src/app/patches/page.tsx`

- [ ] **Step 1: Add imports to patches/page.tsx**

At the top of `src/app/patches/page.tsx`, add:

```typescript
import { EscalateModal } from '@/components/escalate-modal'
import { AcceptedRiskPanel } from '@/components/accepted-risk-panel'
```

- [ ] **Step 2: Add escalate modal state**

Inside the `PatchesPage` component, add state variables alongside the existing state:

```typescript
const [escalateItem, setEscalateItem] = useState<PatchQueueItem | null>(null)
const [escalateModalOpen, setEscalateModalOpen] = useState(false)
```

- [ ] **Step 3: Add Escalate button to patch rows**

Find where individual patch rows are rendered (look for `PatchRow` or the row JSX rendering `item.package`). On rows where `item.fixAvailable === false` and no active non-expired escalation:

```typescript
{item.fixAvailable === false && !item.escalationId && (
  <Button
    variant="outline"
    size="sm"
    className="h-6 text-xs"
    onClick={() => {
      setEscalateItem(item)
      setEscalateModalOpen(true)
    }}
  >
    Escalate
  </Button>
)}
```

- [ ] **Step 4: Add Pending Major Bump banner**

In the grouped-by-project view, before or after the project's patch list, add:

```typescript
{/* Major bump pending banner */}
{projectItems.some(i => i.escalationStatus === 'force_major_pending') && (
  <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-sm text-amber-700 dark:text-amber-400 mb-2">
    <AlertTriangle className="h-4 w-4 shrink-0" />
    <span>
      Major bump pending for{' '}
      <strong>
        {projectItems.filter(i => i.escalationStatus === 'force_major_pending').map(i => i.package).join(', ')}
      </strong>
      . Review package.json and commit manually.
    </span>
  </div>
)}
```

- [ ] **Step 5: Add AcceptedRiskPanel below each project's patch list**

In the grouped-by-project view, after the patch list for each project:

```typescript
<AcceptedRiskPanel
  projectId={projectId}
  projectName={projectName}
  items={projectItems.filter(i =>
    i.escalationStatus === 'accepted_risk' || i.escalationStatus === 'accepted_risk_expired'
  )}
  onReverse={() => {
    // Trigger a re-scan to refresh the queue
    handleRefresh()
  }}
/>
```

Where `handleRefresh()` is whatever function the page uses to re-fetch patch data. Find the existing pattern and replicate it.

- [ ] **Step 6: Render EscalateModal**

Somewhere in the page JSX (near other modals/dialogs if any exist):

```typescript
<EscalateModal
  open={escalateModalOpen}
  item={escalateItem}
  projectEscalationConfig={
    escalateItem
      ? config.projects.find(p => p.id === escalateItem.projectId)?.escalation
      : undefined
  }
  onClose={() => {
    setEscalateModalOpen(false)
    setEscalateItem(null)
  }}
  onSuccess={() => {
    setEscalateModalOpen(false)
    setEscalateItem(null)
    handleRefresh()
  }}
/>
```

Note: `config` here refers to however the page accesses `hexops.config.json`. Check what the page currently does to load project config and replicate it. It may already be in a React context or fetched separately.

- [ ] **Step 7: Verify compilation and lint**

```bash
cd /home/aaron/Projects/hexops && npx tsc --noEmit 2>&1 | head -30
npm run lint 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 8: Manual UI verification**

Start the dev server:

```bash
cd /home/aaron/Projects/hexops && npm run dev
```

Open `http://localhost:3000/patches` and verify:

1. A `fixAvailable: false` row shows an "Escalate" button (may need to find a project with an unfixable vuln, or temporarily set `fixAvailable: false` on a test item)
2. Clicking Escalate opens the modal with 3 radio options
3. Force Override shows version input + auto-commit/push toggles + "Patch Now" button
4. Force Major Bump shows target version + breaking-changes warning, no auto-commit options
5. Accept Risk shows expiry date picker capped at project max
6. Reason field is required — submit is disabled when empty
7. After escalation, the row disappears from the queue (accepted_risk) or gets annotated (force_major_pending)
8. Accepted Risk panel appears below the project with the suppressed item
9. Reverse button removes the record and the item re-appears in the queue

- [ ] **Step 9: Commit**

```bash
cd /home/aaron/Projects/hexops && git add src/app/patches/page.tsx && git commit -m "feat(escalate): wire EscalateModal, AcceptedRiskPanel, and major-bump banner into patches page"
```

---

## Task 8: Push and Open PR

- [ ] **Step 1: Push the branch**

```bash
cd /home/aaron/Projects/hexops && git push -u origin feature/dependabot-integration
```

- [ ] **Step 2: Open PR**

```bash
gh pr create \
  --repo Hexaxia-Technologies/hexops \
  --title "feat: escalate state for unfixable vulnerabilities (#70)" \
  --body "$(cat <<'EOF'
## Summary
- Adds **Escalate** as a third patch state for `fixAvailable: false` vulnerabilities
- Three resolution options: Force Override (pin transitive dep via overrides), Force Major Bump (manual review required), Accept Risk (suppress with expiry)
- **"Patch Now"** emergency button on Force Override — commits and pushes immediately regardless of project config
- Per-project escalation config in `hexops.config.json` (max risk days, auto-commit, auto-push)
- Scanner suppresses accepted-risk items, re-surfaces on expiry or when upstream patch ships
- Accepted Risk panel per project shows active suppressions with countdown and Reverse button

## Test plan
- [ ] Escalate button appears on `fixAvailable: false` rows including Dependabot-managed projects
- [ ] All three modal options render and submit correctly
- [ ] Force Major Bump never auto-commits
- [ ] Patch Now (emergency) commits + pushes immediately
- [ ] Accepted-risk items disappear from queue, appear in panel
- [ ] Expired items re-surface with Expired badge
- [ ] Reverse removes record and re-surfaces vuln

Closes #70
EOF
)"
```
