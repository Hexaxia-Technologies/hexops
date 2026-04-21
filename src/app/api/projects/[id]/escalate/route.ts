import { NextRequest, NextResponse } from 'next/server'
import { getProject } from '@/lib/config'
import { addEscalation, removeEscalation, getEscalationConfig } from '@/lib/escalation-store'
import { resolveLockfile } from '@/lib/lockfile-resolver'
import type { EscalateAction, EscalateRecord } from '@/lib/types'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const LOCK_FILES: Record<string, string> = {
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
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))

      // Inject overrides
      pkgJson.overrides = { ...pkgJson.overrides, [pkg]: overrideVersion }
      if (pkgJson.pnpm) {
        pkgJson.pnpm.overrides = { ...pkgJson.pnpm.overrides, [pkg]: overrideVersion }
      }
      writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n')

      // Regenerate lockfile
      const lockfileResult = await resolveLockfile(project.path, 'repair')

      if (!lockfileResult.success) {
        // Revert package.json on failure
        await execFileAsync('git', ['checkout', '--', 'package.json'], { cwd: project.path })
        return NextResponse.json(
          { error: `Lockfile regeneration failed: ${lockfileResult.error}` },
          { status: 500 }
        )
      }

      const lockfileName = LOCK_FILES[lockfileResult.packageManager]

      // Commit + push based on escalation config or emergency flag
      const shouldCommit = escalationCfg.autoCommit || emergency
      if (shouldCommit) {
        await execFileAsync(
          'git',
          ['add', 'package.json', lockfileName],
          { cwd: project.path }
        )
        await execFileAsync(
          'git',
          ['commit', '-m', `fix(deps): force override ${pkg}@${overrideVersion} — ${reason}`],
          { cwd: project.path }
        )

        const shouldPush = escalationCfg.autoPush || emergency
        if (shouldPush) {
          await execFileAsync('git', ['push'], { cwd: project.path })
        }
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
      if (expiresAt) {
        record.expiresAt = expiresAt
        const maxDate = new Date()
        maxDate.setDate(maxDate.getDate() + escalationCfg.acceptedRiskMaxDays)
        if (new Date(expiresAt) > maxDate) {
          record.expiresAt = maxDate.toISOString()
        }
      }
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
