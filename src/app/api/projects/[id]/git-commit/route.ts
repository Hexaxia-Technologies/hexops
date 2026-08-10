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
 * Options for every git invocation this route makes.
 *
 * `GIT_LITERAL_PATHSPECS=1` is the belt to the validator's braces: `--`
 * terminates *option* parsing but does NOT disable git's pathspec magic, so a
 * pathspec like `:/root.txt` or `:(top)apps/api/.env` is still reinterpreted as
 * repo-root-relative and escapes the project directory (verified against real
 * git). With this env var set, git treats every pathspec as a literal path
 * relative to the cwd, so the magic prefixes cannot fire at all. Consequence:
 * this route must never rely on pathspec magic itself — it doesn't.
 */
function gitOptions(cwd: string, extra: Record<string, unknown> = {}) {
  return {
    cwd,
    env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' },
    ...extra,
  };
}

/**
 * Validate that a caller-supplied relative path is safe to hand to `git add`:
 * a non-empty string, not absolute, no pathspec-magic prefix, no `.`/`..` or
 * `.git` path segments, no control characters, and (after joining onto the
 * project directory) still resolves inside it. This input is untrusted — it
 * comes straight from the request body and is passed to a shell-adjacent git
 * invocation, so reject anything suspicious outright rather than trying to
 * sanitize it.
 */
function isSafeProjectRelativePath(cwd: string, candidate: string): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  if (candidate.trim() !== candidate) return false;
  if (isAbsolute(candidate)) return false;

  // A leading `:` makes git reinterpret the whole argument as pathspec magic
  // (`:/x` = repo root, `:(top)x`, `:(exclude)x`, `:!x`, ...). None of those are
  // legitimate file paths, and every one of them escapes `cwd`.
  if (candidate.startsWith(':')) return false;

  // NULs and other control bytes cannot appear in an execFile argument (Node
  // throws ERR_INVALID_ARG_VALUE); reject them here so the caller gets a clear
  // 400 rather than an opaque 500 from deep inside the git call.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return false;

  const segments = candidate.split(/[\\/]+/);
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return false;
  }
  // Nothing under `.git` is ever a legitimate commit target. Git already
  // neutralizes `git add -- .git/config` (exit 0, stages nothing), but that
  // produces a confusing "No changes to commit" instead of a clear rejection,
  // and leaving the hole open weakens a defense-in-depth check. Case-insensitive
  // because `.GIT` resolves to the same directory on case-insensitive volumes.
  if (segments.some((segment) => segment.toLowerCase() === '.git')) return false;

  const resolvedRelative = relative(cwd, join(cwd, candidate));
  if (resolvedRelative.startsWith('..') || isAbsolute(resolvedRelative)) return false;

  return true;
}

/** True if `relPath` is something `git add -- relPath` can actually stage:
 * present on disk, or a deletion git already knows about (tracked file
 * removed from the working tree). Without this check, `git add` fails on a
 * caller-supplied path that doesn't exist, and — critically — a naive
 * `existsSync` check alone would also skip real deletions, since a deleted
 * file by definition doesn't exist on disk anymore.
 *
 * Deliberately does NOT catch: a clean non-match is `git status` exiting 0 with
 * empty output, and that is the only thing that may be reported as "not
 * stageable". Any *failure* of the status call (git missing, not a repository,
 * unreadable index, an invalid argument) is a different fact entirely and is
 * rethrown so it surfaces as a 500 — swallowing it would answer 400 "File(s)
 * not found: x" for a file that plainly does exist, which is the same
 * collapse-every-error-into-one-meaning bug this route fixed at the
 * empty-check. */
async function isStageable(cwd: string, relPath: string): Promise<boolean> {
  if (existsSync(join(cwd, relPath))) return true;
  const { stdout } = await execFileAsync(
    'git',
    ['status', '--porcelain', '--', relPath],
    gitOptions(cwd)
  );
  return stdout.trim().length > 0;
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
    // absolute paths, pathspec magic, .git segments, and anything that
    // escapes the project directory are all rejected with a 400 rather than silently dropped or coerced.
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
            error: `\`files\` entries must be plain relative paths inside the project (no absolute paths, "..", ".git", or ":" pathspec magic): ${unsafe.join(', ')}`,
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
      await execFileAsync('git', ['add', '--', ...filesToStage], gitOptions(cwd));
    } else {
      // Neither `files` nor `scope` supplied — this is the same `git add -A`
      // the route has always run, kept as the default specifically so
      // callers that intentionally commit "whatever is dirty" (project
      // detail's general git panel, the MCP server's git_commit tool) keep
      // working exactly as before.
      await execFileAsync('git', ['add', '-A'], gitOptions(cwd));
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
      await execFileAsync('git', ['diff', '--cached', '--quiet'], gitOptions(cwd));
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
      gitOptions(cwd, { timeout: 30000 })
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
