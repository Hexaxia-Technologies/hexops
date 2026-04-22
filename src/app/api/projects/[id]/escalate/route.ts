import { NextRequest, NextResponse } from 'next/server'
import { getProject } from '@/lib/config'
import { addEscalation, removeEscalation, getEscalationConfig } from '@/lib/escalation-store'
import { resolveLockfile } from '@/lib/lockfile-resolver'
import { detectPackageManager } from '@/lib/patch-scanner'
import type { EscalateAction, EscalateRecord, PackageManager } from '@/lib/types'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const LOCK_FILES: Record<PackageManager, string> = {
  pnpm: 'pnpm-lock.yaml',
  npm: 'package-lock.json',
  yarn: 'yarn.lock',
}

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

  try {
    const project = getProject(id)

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const body: EscalateRequestBody = await request.json()
    const { package: pkg, action, reason, overrideVersion, targetVersion, expiresAt, emergency } = body

    if (!pkg || !action || !reason) {
      return NextResponse.json(
        { error: 'package, action, and reason are required' },
        { status: 400 }
      )
    }

    // Validate action
    const validActions: EscalateAction[] = ['force_override', 'force_major', 'accepted_risk']
    if (!validActions.includes(action)) {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }

    // Validate package name
    if (!pkg || !/^[@a-z0-9][\w\-./@]*$/i.test(pkg)) {
      return NextResponse.json({ error: 'Invalid package name' }, { status: 400 })
    }
    // Validate version strings (when present)
    if (overrideVersion && !/^(latest|next|canary|[\w\-.^~<>=|@]+)$/i.test(overrideVersion)) {
      return NextResponse.json({ error: 'Invalid override version' }, { status: 400 })
    }
    if (targetVersion && !/^(latest|next|canary|[\w\-.^~<>=|@]+)$/i.test(targetVersion)) {
      return NextResponse.json({ error: 'Invalid target version' }, { status: 400 })
    }

    const escalationCfg = getEscalationConfig(project)

    const record: EscalateRecord = {
      id: crypto.randomUUID(),
      projectId: id,
      package: pkg,
      action,
      reason,
      createdAt: new Date().toISOString(),
    }

    if (action === 'force_override') {
      if (!overrideVersion) {
        return NextResponse.json(
          { error: 'overrideVersion is required for force_override' },
          { status: 400 }
        )
      }

      record.overrideVersion = overrideVersion

      const pkgJsonPath = join(project.path, 'package.json')
      const pkgJsonRaw = readFileSync(pkgJsonPath, 'utf-8')
      const pkgJson = JSON.parse(pkgJsonRaw)

      // Detect package manager before writing overrides so we use the correct key
      const detectedPm = detectPackageManager(project.path) as PackageManager
      const lockfileName = LOCK_FILES[detectedPm]

      if (!lockfileName) {
        return NextResponse.json({ error: `Unknown package manager: ${detectedPm}` }, { status: 500 })
      }

      // Inject overrides using PM-aware key
      if (detectedPm === 'pnpm') {
        if (!pkgJson.pnpm) pkgJson.pnpm = {}
        if (!pkgJson.pnpm.overrides) pkgJson.pnpm.overrides = {}
        pkgJson.pnpm.overrides[pkg] = overrideVersion
      } else if (detectedPm === 'npm') {
        if (!pkgJson.overrides) pkgJson.overrides = {}
        pkgJson.overrides[pkg] = overrideVersion
      } else {
        // yarn uses "resolutions"
        if (!pkgJson.resolutions) pkgJson.resolutions = {}
        pkgJson.resolutions[pkg] = overrideVersion
      }

      const indent = pkgJsonRaw.match(/^(\s+)/m)?.[1] || '  '
      writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, indent) + '\n')

      // Regenerate lockfile to pick up the new override
      const lockfileResult = await resolveLockfile(project.path, 'repair')

      if (!lockfileResult.success) {
        // Revert package.json on failure
        await execFileAsync('git', ['checkout', '--', 'package.json'], { cwd: project.path, timeout: 30000 })
        return NextResponse.json(
          { error: `Lockfile regeneration failed: ${lockfileResult.error}` },
          { status: 500 }
        )
      }

      // Commit + push based on escalation config or emergency flag
      const shouldCommit = escalationCfg.autoCommit || emergency
      const shouldPush = escalationCfg.autoPush || emergency

      try {
        if (shouldCommit) {
          await execFileAsync('git', ['add', 'package.json', lockfileName], { cwd: project.path, timeout: 30000 })
          await execFileAsync('git', ['commit', '-m', `fix(deps): force override ${pkg}@${overrideVersion} — ${reason}`], { cwd: project.path, timeout: 30000 })
        }
        if (shouldPush) {
          await execFileAsync('git', ['push'], { cwd: project.path, timeout: 60000 })
        }
      } catch (commitErr) {
        // Revert both package.json and lockfile on failure
        try {
          await execFileAsync('git', ['checkout', '--', 'package.json', lockfileName], { cwd: project.path, timeout: 30000 })
        } catch { /* ignore revert errors */ }
        return NextResponse.json({ error: `Commit/push failed: ${commitErr instanceof Error ? commitErr.message : String(commitErr)}` }, { status: 500 })
      }
    } else if (action === 'force_major') {
      if (!targetVersion) {
        return NextResponse.json(
          { error: 'targetVersion is required for force_major' },
          { status: 400 }
        )
      }

      record.targetVersion = targetVersion

      const pkgJsonPath = join(project.path, 'package.json')
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))

      for (const section of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
        if (pkgJson[section]?.[pkg]) {
          pkgJson[section][pkg] = `^${targetVersion}`
          break
        }
      }

      writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n')
      // Do NOT commit — leave dirty for human review
    } else if (action === 'accepted_risk') {
      let expiryWarning: string | undefined
      if (expiresAt) {
        const maxDate = new Date()
        maxDate.setDate(maxDate.getDate() + escalationCfg.acceptedRiskMaxDays)
        if (new Date(expiresAt) > maxDate) {
          record.expiresAt = maxDate.toISOString()
          expiryWarning = `expiresAt clamped to maximum allowed value (${escalationCfg.acceptedRiskMaxDays} days)`
        } else {
          record.expiresAt = expiresAt
        }
      }

      addEscalation(record)

      return NextResponse.json({ success: true, record, ...(expiryWarning && { warning: expiryWarning }) })
    }

    addEscalation(record)

    return NextResponse.json({ success: true, record })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Escalation failed'
    return NextResponse.json({ error: errorMessage }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  try {
    const project = getProject(id)

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const body = await request.json()
    const { escalationId } = body

    if (!escalationId) {
      return NextResponse.json({ error: 'escalationId is required' }, { status: 400 })
    }

    const removed = removeEscalation(escalationId)

    if (!removed) {
      return NextResponse.json({ error: 'Escalation not found' }, { status: 404 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Delete failed'
    return NextResponse.json({ error: errorMessage }, { status: 500 })
  }
}
