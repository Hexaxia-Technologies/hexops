import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/lib/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '@/lib/logger';
import { existsSync } from 'fs';
import { isAbsolute, join, relative } from 'path';
import { LOCKFILES } from '@/lib/patch-storage';

const execFileAsync = promisify(execFile);

/**
 * Validate that a caller-supplied relative path is safe to hand to `git add`:
 * a non-empty string, not absolute, no `.`/`..` path segments, and (after
 * joining onto the project directory) still resolves inside it. This input
 * is untrusted — it comes straight from the request body and is passed to a
 * shell-adjacent git invocation, so reject anything suspicious outright
 * rather than trying to sanitize it.
 */
function isSafeProjectRelativePath(cwd: string, candidate: string): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  if (candidate.trim() !== candidate) return false;
  if (isAbsolute(candidate)) return false;

  const segments = candidate.split(/[\\/]+/);
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return false;
  }

  const resolvedRelative = relative(cwd, join(cwd, candidate));
  if (resolvedRelative.startsWith('..') || isAbsolute(resolvedRelative)) return false;

  return true;
}

/** True if `relPath` is something `git add -- relPath` can actually stage:
 * present on disk, or a deletion git already knows about (tracked file
 * removed from the working tree). Without this check, `git add` fails on a
 * caller-supplied path that doesn't exist, and — critically — a naive
 * `existsSync` check alone would also skip real deletions, since a deleted
 * file by definition doesn't exist on disk anymore. */
async function isStageable(cwd: string, relPath: string): Promise<boolean> {
  if (existsSync(join(cwd, relPath))) return true;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain', '--', relPath],
      { cwd }
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** Scope values `scope` may take. Resolution is server-side and filesystem-aware —
 * see `resolveDependenciesScope` — specifically so callers never have to guess a
 * project's package manager / lockfile name from the browser. */
const KNOWN_SCOPES = ['dependencies'] as const;
type KnownScope = (typeof KNOWN_SCOPES)[number];

function isKnownScope(value: string): value is KnownScope {
  return (KNOWN_SCOPES as readonly string[]).includes(value);
}

/**
 * Resolve `scope: 'dependencies'` into the concrete file set to stage:
 * `package.json` plus whichever lockfile(s) actually exist in the project.
 * This is deliberately done server-side (not left to the caller to guess) —
 * the browser doesn't know the project's filesystem, and the route's `files`
 * validation 400s on any path that doesn't exist, so a caller sending a
 * speculative `pnpm-lock.yaml` would break every npm/yarn project.
 *
 * Returns `null` (not an empty array) when there's nothing stageable at all —
 * no `package.json` — so the caller can 400 instead of silently no-op'ing.
 */
function resolveDependenciesScope(cwd: string): string[] | null {
  if (!existsSync(join(cwd, 'package.json'))) return null;

  const files = ['package.json'];
  for (const lockfile of LOCKFILES) {
    if (existsSync(join(cwd, lockfile))) files.push(lockfile);
  }
  return files;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let source: string | undefined;
  let advisories: string[] | undefined;

  try {
    const project = getProject(id);

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

    const body = await request.json();
    const message = body.message?.trim();
    source = typeof body.source === 'string' ? body.source : undefined;
    advisories = Array.isArray(body.advisories)
      ? body.advisories.filter((a: unknown): a is string => typeof a === 'string')
      : undefined;

    if (!message) {
      return NextResponse.json(
        { error: 'Commit message is required' },
        { status: 400 }
      );
    }

    const cwd = project.path;

    // Stage ONLY the files the caller names, never the whole working tree —
    // unless the caller doesn't opt in, in which case we preserve the
    // route's original `git add -A` behavior exactly (see below). A bare
    // `git add -A` here previously swept unrelated uncommitted work into
    // dependency-patch commits (which then auto-deployed for some managed
    // projects). `files` is untrusted request input and is passed to `git
    // add`, so it is validated strictly: non-array/non-string entries,
    // absolute paths, and anything that escapes the project directory are
    // all rejected with a 400 rather than silently dropped or coerced.
    //
    // `scope` is the second, additive way to opt in: a caller that knows
    // *what kind* of change it made (e.g. a dependency patch) but not the
    // project's exact filesystem layout (which lockfile it uses, if any)
    // sends `scope: 'dependencies'` and the server resolves it into concrete
    // paths — see `resolveDependenciesScope`. `files` and `scope` are
    // mutually exclusive; at most one of them ends up populating
    // `filesToStage` below.
    let filesToStage: string[] | null = null;

    if (body.files !== undefined && body.scope !== undefined) {
      return NextResponse.json(
        { error: '`files` and `scope` are mutually exclusive; send only one' },
        { status: 400 }
      );
    }

    if (body.scope !== undefined) {
      if (typeof body.scope !== 'string' || !isKnownScope(body.scope)) {
        return NextResponse.json(
          {
            error: `Unknown \`scope\`: ${JSON.stringify(body.scope)}. Known scopes: ${KNOWN_SCOPES.join(', ')}`,
          },
          { status: 400 }
        );
      }

      // Only one scope exists today, but resolution is dispatched by value
      // (rather than assuming `dependencies`) so adding a second scope later
      // doesn't require touching this branch.
      const resolved =
        body.scope === 'dependencies' ? resolveDependenciesScope(cwd) : null;

      if (!resolved) {
        return NextResponse.json(
          {
            error: `scope: 'dependencies' found nothing stageable — no package.json in this project`,
          },
          { status: 400 }
        );
      }

      filesToStage = resolved;
    }

    if (body.files !== undefined) {
      if (!Array.isArray(body.files)) {
        return NextResponse.json(
          { error: '`files` must be an array of relative path strings' },
          { status: 400 }
        );
      }

      if (body.files.length === 0) {
        return NextResponse.json(
          {
            error:
              '`files` must not be empty; omit the field entirely to stage the default set',
          },
          { status: 400 }
        );
      }

      const invalid: string[] = [];
      const unsafe: string[] = [];
      const safe: string[] = [];

      for (const entry of body.files as unknown[]) {
        if (typeof entry !== 'string' || entry.length === 0) {
          invalid.push(JSON.stringify(entry));
          continue;
        }
        if (!isSafeProjectRelativePath(cwd, entry)) {
          unsafe.push(entry);
          continue;
        }
        safe.push(entry);
      }

      if (invalid.length > 0) {
        return NextResponse.json(
          {
            error: `\`files\` entries must be non-empty strings; got: ${invalid.join(', ')}`,
          },
          { status: 400 }
        );
      }

      if (unsafe.length > 0) {
        return NextResponse.json(
          {
            error: `\`files\` entries must be relative paths inside the project (no absolute paths or ".."): ${unsafe.join(', ')}`,
          },
          { status: 400 }
        );
      }

      const missing: string[] = [];
      for (const relPath of safe) {
        if (!(await isStageable(cwd, relPath))) {
          missing.push(relPath);
        }
      }

      if (missing.length > 0) {
        return NextResponse.json(
          { error: `File(s) not found: ${missing.join(', ')}` },
          { status: 400 }
        );
      }

      filesToStage = safe;
    }

    if (filesToStage) {
      await execFileAsync('git', ['add', '--', ...filesToStage], { cwd });
    } else {
      // Neither `files` nor `scope` supplied — this is the same `git add -A`
      // the route has always run, kept as the default specifically so
      // callers that intentionally commit "whatever is dirty" (project
      // detail's general git panel, the MCP server's git_commit tool) keep
      // working exactly as before.
      await execFileAsync('git', ['add', '-A'], { cwd });
    }

    // Check if the scoped stage actually produced staged changes. This
    // checks the index (`git diff --cached`), not the whole worktree
    // (`git status --porcelain` would also report unstaged/untracked files
    // outside what we just staged, which is the wrong signal here). A
    // non-zero exit from `git diff --cached --quiet` means there ARE staged
    // differences (exit 1) — but it can also mean the command itself failed
    // for an unrelated reason, so only exit code 1 is treated as "there are
    // changes"; anything else is a real failure and is surfaced, not
    // swallowed as if there were changes to commit.
    let hasStaged: boolean;
    try {
      await execFileAsync('git', ['diff', '--cached', '--quiet'], { cwd });
      hasStaged = false; // exit 0 = no staged differences
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === 1) {
        hasStaged = true; // exit 1 = staged differences present
      } else {
        throw err; // genuine failure (bad repo, git missing, etc.)
      }
    }

    if (!hasStaged) {
      return NextResponse.json({
        success: false,
        error: 'No changes to commit',
      });
    }

    // Execute git commit
    const { stdout, stderr } = await execFileAsync(
      'git',
      ['commit', '-m', message],
      { cwd, timeout: 30000 }
    );

    // Log success
    logger.info('git', 'commit_created', `Committed changes: ${message.split('\n')[0]}`, {
      projectId: id,
      meta: {
        message: message.split('\n')[0],
        ...(source ? { source } : {}),
        ...(advisories ? { advisories } : {}),
      },
    });

    return NextResponse.json({
      success: true,
      output: stdout || stderr || 'Commit successful',
    });
  } catch (error) {
    console.error('Git commit failed:', error);
    const errorMessage = error instanceof Error ? error.message : 'Git commit failed';

    // Log failure
    logger.error('git', 'commit_failed', `Commit failed: ${errorMessage}`, {
      projectId: id,
      meta: {
        error: errorMessage,
        ...(source ? { source } : {}),
        ...(advisories ? { advisories } : {}),
      },
    });

    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}
