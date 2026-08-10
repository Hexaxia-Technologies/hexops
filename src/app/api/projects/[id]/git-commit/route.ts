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

/** Scope values `scope` may take. Resolution is server-side and git-aware —
 * see `resolveDependenciesScope` — specifically so callers never have to guess a
 * project's package manager / lockfile name from the browser. */
const KNOWN_SCOPES = ['dependencies'] as const;
type KnownScope = (typeof KNOWN_SCOPES)[number];

function isKnownScope(value: string): value is KnownScope {
  return (KNOWN_SCOPES as readonly string[]).includes(value);
}

/** Basenames that count as "a dependency file", at any depth. `package.json`
 * plus the lockfile list already used to fingerprint dependency state for
 * patch-cache invalidation — reused rather than duplicated so the two cannot
 * drift apart. */
const DEPENDENCY_FILENAMES: ReadonlySet<string> = new Set<string>([
  'package.json',
  ...LOCKFILES,
]);

/** Paths resolved for a scope, split by what each is safe to be used for. */
interface ScopedPaths {
  /** Paths to hand to `git add --`. */
  stage: string[];
  /** Pathspec for `git diff --cached` and `git commit` — a superset of `stage`,
   * additionally carrying the *source* path of a rename that git has already
   * staged. That source path must appear in the commit pathspec (otherwise the
   * deletion half of the rename is not recorded) but must NOT be passed to
   * `git add`, which fails with `fatal: pathspec '<old>' did not match any
   * files` once the rename is in the index. Verified against real git. */
  commit: string[];
  /** Dependency files with an unresolved merge conflict. Staging these would
   * commit conflict markers, and git refuses a partial commit during a merge
   * anyway, so the route rejects instead. */
  conflicted: string[];
}

/** True for any path with a `node_modules` segment. Installed packages ship
 * their own `package.json` and lockfiles; none of them belong in a commit. */
function isInsideNodeModules(repoPath: string): boolean {
  return repoPath.split('/').includes('node_modules');
}

/** `git status --porcelain` reports paths relative to the *repository root*,
 * not to the cwd, while every pathspec we later pass back to git (under
 * `GIT_LITERAL_PATHSPECS`) is interpreted relative to the cwd. Convert, and drop
 * anything that isn't under the project directory. `prefix` is
 * `git rev-parse --show-prefix`: empty at the repo root (the case for every
 * currently configured project), `sub/dir/` for a project nested inside a
 * larger repo. */
function toProjectRelative(repoPath: string, prefix: string): string | null {
  if (!prefix) return repoPath || null;
  if (!repoPath.startsWith(prefix)) return null;
  const rel = repoPath.slice(prefix.length);
  return rel.length > 0 ? rel : null;
}

/**
 * Resolve `scope: 'dependencies'` into the concrete file set to stage, from
 * **git's view of what changed** rather than from `existsSync` over a fixed
 * root-only list. That single change fixes three failures at once:
 *
 * - a lockfile that exists on disk but is gitignored (one stray `npm install`
 *   in a pnpm repo) is no longer included, so `git add` no longer aborts with
 *   "paths are ignored by one of your .gitignore files" *after* having already
 *   staged `package.json` — which left the index dirty and made every retry
 *   fail identically. git does not report ignored files, so they never enter
 *   the set;
 * - a *deleted* lockfile is included, because git reports deletions — an
 *   `existsSync` filter by definition cannot see them, so switching package
 *   managers produced a commit that omitted the removal and left the repo
 *   tracking a lockfile that no longer exists;
 * - nested workspace `package.json` files are included at any depth, because
 *   git reports them wherever they are. `npm install --workspaces` /
 *   `pnpm add -r` rewrite every workspace manifest; committing the lockfile
 *   without them yields a commit on which `install --frozen-lockfile` fails.
 *
 * Accepted porcelain entries (`XY <path>`, NUL-separated via `-z` so paths are
 * never quoted or escaped regardless of `core.quotePath`):
 * - any ordinary change — `M`, `A`, `D`, `T`, `R`, `C` in either column — whose
 *   basename is in `DEPENDENCY_FILENAMES`;
 * - untracked *files* (`??`) with a dependency basename, e.g. a brand-new
 *   lockfile. Untracked *directory* entries (git collapses them to a single
 *   `?? some/dir/` record) are skipped: staging a whole directory would sweep
 *   in everything inside it, which is precisely what this route exists to stop.
 *   The trade-off is that a dependency file inside a wholly-untracked new
 *   directory is not picked up; default (`-unormal`) untracked handling is kept
 *   rather than `-uall` so git never has to enumerate every untracked file in
 *   the tree.
 * Rejected: anything under `node_modules/` at any depth; anything outside the
 * project directory; ignored entries; and unmerged entries (`U` in either
 * column, plus `AA`/`DD`), which are reported back as `conflicted`.
 *
 * No depth bound is applied: the basename allowlist plus the `node_modules`
 * exclusion already bound the set to real manifests, and a depth cap would
 * silently drop legitimate deeply-nested workspace packages.
 *
 * Any failure of the git calls propagates — a resolver that cannot see the
 * repository must not answer "nothing changed".
 */
async function resolveDependenciesScope(cwd: string): Promise<ScopedPaths> {
  const { stdout: prefixOut } = await execFileAsync(
    'git',
    ['rev-parse', '--show-prefix'],
    gitOptions(cwd)
  );
  const prefix = prefixOut.trim();

  // `-- .` limits the report to the project directory: without it, a project
  // nested inside a larger repository would pull in sibling projects' manifests.
  const { stdout } = await execFileAsync(
    'git',
    ['status', '--porcelain', '-z', '--', '.'],
    gitOptions(cwd, { maxBuffer: 32 * 1024 * 1024 })
  );

  const stage: string[] = [];
  const commit: string[] = [];
  const conflicted: string[] = [];
  const seenStage = new Set<string>();
  const seenCommit = new Set<string>();

  const record = (repoPath: string, alsoStage: boolean) => {
    if (isInsideNodeModules(repoPath)) return;
    const rel = toProjectRelative(repoPath, prefix);
    if (rel === null) return;
    if (!seenCommit.has(rel)) {
      seenCommit.add(rel);
      commit.push(rel);
    }
    if (alsoStage && !seenStage.has(rel)) {
      seenStage.add(rel);
      stage.push(rel);
    }
  };

  const fields = stdout.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    // `XY <path>` — shortest possible record is 4 chars. The split leaves a
    // trailing empty field after the final NUL.
    if (!entry || entry.length < 4) continue;

    const x = entry[0];
    const y = entry[1];
    const path = entry.slice(3);

    // Rename/copy records carry the source path in the *next* NUL-separated
    // field; consume it here so parsing stays in sync whether or not the entry
    // ends up being selected.
    const isRenameOrCopy = x === 'R' || x === 'C' || y === 'R' || y === 'C';
    const source = isRenameOrCopy ? fields[++i] : undefined;

    if (x === '!' && y === '!') continue; // ignored (only emitted with --ignored)
    if (path.endsWith('/')) continue; // collapsed untracked directory
    if (isInsideNodeModules(path)) continue;

    const basename = path.slice(path.lastIndexOf('/') + 1);
    if (!DEPENDENCY_FILENAMES.has(basename)) continue;

    const isUnmerged =
      x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
    if (isUnmerged) {
      const rel = toProjectRelative(path, prefix);
      if (rel !== null) conflicted.push(rel);
      continue;
    }

    record(path, true);
    // Rename source: commit pathspec only, never `git add`.
    if (source) record(source, false);
  }

  return { stage, commit, conflicted };
}

/**
 * Paths already in the index that this scoped commit is about to leave behind.
 *
 * Passing a pathspec to `git commit` correctly excludes a developer's
 * pre-staged unrelated work from *this* commit — but it stays staged, and their
 * next commit picks it up. Silently absorbing it is the bug this route exists to
 * fix; silently resetting it would destroy staged work, which is worse. So it is
 * neither committed nor touched — just reported.
 *
 * `--relative` makes the output cwd-relative so it compares directly against the
 * scoped pathspec (which is also cwd-relative). For a project nested inside a
 * larger repo that means staged files elsewhere in that repo are not reported;
 * they are also outside the project's purview.
 */
async function findStagedOutsideScope(cwd: string, scopePaths: string[]): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['diff', '--cached', '--name-only', '-z', '--relative'],
    gitOptions(cwd, { maxBuffer: 32 * 1024 * 1024 })
  );
  const inScope = new Set(scopePaths);
  return stdout
    .split('\0')
    .filter((p) => p.length > 0 && !inScope.has(p));
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
    // absolute paths, pathspec magic, `.git` segments, and anything that
    // escapes the project directory are all rejected with a 400 rather than
    // silently dropped or coerced.
    //
    // `scope` is the second, additive way to opt in: a caller that knows
    // *what kind* of change it made (e.g. a dependency patch) but not the
    // project's exact layout (which lockfile it uses, which workspaces it has)
    // sends `scope: 'dependencies'` and the server resolves it from git — see
    // `resolveDependenciesScope`. `files` and `scope` are mutually exclusive;
    // at most one of them ends up populating the two path lists below.
    //
    // Two lists, not one: `stagePaths` is what `git add` receives, `scopePaths`
    // is the pathspec for the empty-check and the commit. They differ only for
    // an already-staged rename (see `ScopedPaths.commit`). Both are null on the
    // unscoped fallback path, which keeps the bare `git add -A` /
    // `git diff --cached` / `git commit -m` forms.
    let stagePaths: string[] | null = null;
    let scopePaths: string[] | null = null;

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

      // Cheap pre-flight: `scope: 'dependencies'` against a project with no
      // package.json at all is a caller mistake, not "nothing to commit", and
      // is worth a distinct 400 before any git process is spawned.
      if (!existsSync(join(cwd, 'package.json'))) {
        return NextResponse.json(
          {
            error: `scope: 'dependencies' found nothing stageable — no package.json in this project`,
          },
          { status: 400 }
        );
      }

      // Only one scope exists today, but resolution is dispatched by value
      // (rather than assuming `dependencies`) so adding a second scope later
      // doesn't require touching this branch.
      const resolved =
        body.scope === 'dependencies' ? await resolveDependenciesScope(cwd) : null;

      if (!resolved) {
        return NextResponse.json(
          { error: `Unknown \`scope\`: ${JSON.stringify(body.scope)}` },
          { status: 400 }
        );
      }

      if (resolved.conflicted.length > 0) {
        return NextResponse.json(
          {
            error: `Unresolved merge conflict in: ${resolved.conflicted.join(', ')}. Resolve it before committing dependency changes.`,
          },
          { status: 409 }
        );
      }

      stagePaths = resolved.stage;
      scopePaths = resolved.commit;
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

      stagePaths = safe;
      scopePaths = safe;
    }

    // An empty scoped set must short-circuit here. Falling through would run
    // `git add --` and then `git diff --cached --quiet --` / `git commit -m … --`
    // with no pathspec at all, which is exactly the whole-index behavior this
    // route is scoping away from.
    if (scopePaths && scopePaths.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'No changes to commit',
      });
    }

    if (stagePaths) {
      await execFileAsync('git', ['add', '--', ...stagePaths], gitOptions(cwd));
    } else {
      // Neither `files` nor `scope` supplied — this is the same `git add -A`
      // the route has always run, kept as the default specifically so
      // callers that intentionally commit "whatever is dirty" (project
      // detail's general git panel, the MCP server's git_commit tool) keep
      // working exactly as before.
      await execFileAsync('git', ['add', '-A'], gitOptions(cwd));
    }

    // Report — never absorb, never reset — anything the developer had staged
    // that this commit's pathspec excludes. See `findStagedOutsideScope`.
    const stagedOutsideScope = scopePaths
      ? await findStagedOutsideScope(cwd, scopePaths)
      : [];
    const warnings =
      stagedOutsideScope.length > 0
        ? [
            `Left staged, not included in this commit: ${stagedOutsideScope.join(', ')}. These were already in the index; they remain staged and will be picked up by your next commit.`,
          ]
        : undefined;
    if (warnings) {
      logger.warn(
        'git',
        'commit_scope_index_residue',
        `Scoped commit excluded ${stagedOutsideScope.length} already-staged path(s)`,
        { projectId: id, meta: { paths: stagedOutsideScope, ...(source ? { source } : {}) } }
      );
    }

    // Check if the scoped stage actually produced staged changes — scoped to
    // the same pathspec the commit will use. Without the pathspec this reads
    // the whole index, so a no-op dependency patch plus unrelated staged work
    // reported "changes present" and produced a commit whose entire content
    // was that unrelated work, under a `chore(deps): …` message.
    //
    // This checks the index (`git diff --cached`), not the whole worktree
    // (`git status --porcelain` would also report unstaged/untracked files
    // outside what we just staged, which is the wrong signal here). A
    // non-zero exit from `git diff --cached --quiet` means there ARE staged
    // differences (exit 1) — but it can also mean the command itself failed
    // for an unrelated reason, so only exit code 1 is treated as "there are
    // changes"; anything else is a real failure and is surfaced, not
    // swallowed as if there were changes to commit.
    const diffArgs = scopePaths
      ? ['diff', '--cached', '--quiet', '--', ...scopePaths]
      : ['diff', '--cached', '--quiet'];

    let hasStaged: boolean;
    try {
      await execFileAsync('git', diffArgs, gitOptions(cwd));
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
        ...(warnings ? { warnings } : {}),
      });
    }

    // Execute git commit. When a scoped file set is in play the pathspec is
    // mandatory: `git commit -m <msg>` with no pathspec commits the ENTIRE
    // index, so scoping `git add` alone accomplished nothing except making the
    // resulting over-broad commit harder to spot, since the UI reported it as
    // scoped. The pathspec form commits worktree content for those paths, which
    // is what we want here, and it does record deletions and staged renames
    // (both verified against real git).
    const commitArgs = scopePaths
      ? ['commit', '-m', message, '--', ...scopePaths]
      : ['commit', '-m', message];

    const { stdout, stderr } = await execFileAsync(
      'git',
      commitArgs,
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
      ...(warnings ? { warnings } : {}),
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
