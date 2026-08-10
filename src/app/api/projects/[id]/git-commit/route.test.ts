import { describe, it, expect, vi, beforeEach } from 'vitest';

// `route.ts` does `promisify(execFile)` once at module load time. Node's
// `child_process.execFile` normally advertises a custom promisify
// implementation via the well-known `nodejs.util.promisify.custom` symbol;
// we replicate that hookup on our mock so `promisify(execFile)` resolves
// through `mockExecFileAsync` instead of trying to spawn a real process.
// This guarantees no real git commands ever run against a real project.
const mockExecFileAsync = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => {
  const execFile: unknown = vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === 'function') {
      (cb as (err: Error) => void)(
        new Error('execFile called directly in test — expected promisify(execFile) path')
      );
    }
  });
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), {
    value: (...args: unknown[]) => mockExecFileAsync(...args),
  });
  return { execFile };
});

vi.mock('@/lib/config', () => ({ getProject: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('fs', () => ({ existsSync: vi.fn() }));

import { getProject } from '@/lib/config';
import { existsSync } from 'fs';
import { POST } from './route';

const PROJECT = { id: 'proj-a', name: 'proj-a', path: '/repos/proj-a' };

function makeRequest(body: unknown) {
  return {
    json: async () => body,
  } as unknown as Parameters<typeof POST>[0];
}

function makeParams(id = 'proj-a') {
  return { params: Promise.resolve({ id }) };
}

/** Configure mockExecFileAsync to answer a scripted sequence of git calls. */
function scriptGit(
  handlers: Record<string, (args: string[]) => Promise<{ stdout: string; stderr: string }>>
) {
  mockExecFileAsync.mockImplementation(
    async (cmd: string, args: string[]) => {
      if (cmd !== 'git') throw new Error(`unexpected command: ${cmd}`);
      const [sub] = args;
      // The scoped-commit index-residue probe (`git diff --cached --name-only
      // -z --relative`). Answers "nothing else was already staged" unless a
      // test overrides it with an explicit `diffNameOnly` handler.
      if (sub === 'diff' && args.includes('--name-only')) {
        return (handlers.diffNameOnly ?? (async () => OK))(args);
      }
      const handler = handlers[sub];
      if (!handler) {
        throw new Error(`no handler configured for git ${sub} (${args.join(' ')})`);
      }
      return handler(args);
    }
  );
}

function gitError(code: number, message = 'git failed') {
  const err = new Error(message) as Error & { code: number };
  err.code = code;
  return err;
}

const OK = { stdout: '', stderr: '' };

/** Build `git status --porcelain -z` output: NUL-terminated records, no quoting.
 * Rename/copy records are `XY <new>\0<orig>\0`, so pass those as two entries. */
function porcelainZ(...records: string[]) {
  return { stdout: records.map((r) => `${r}\0`).join(''), stderr: '' };
}

/** Every git call the route makes, as `[cmd, args, options]` triples. */
function gitCalls(): Array<[string, string[], Record<string, unknown>]> {
  return mockExecFileAsync.mock.calls as Array<[string, string[], Record<string, unknown>]>;
}

/** The argv of the single `git <sub>` invocation matching `match`, or undefined. */
function gitArgs(sub: string, match?: (args: string[]) => boolean): string[] | undefined {
  return gitCalls()
    .filter(([, args]) => args[0] === sub && (!match || match(args)))
    .map(([, args]) => args)[0];
}

/**
 * Script the git calls a `scope: 'dependencies'` request makes.
 * `status` is the porcelain listing the resolver reads; `stagedIndex` is what
 * `git diff --cached --name-only -z --relative` reports (the pre-existing index).
 */
function scriptScopeGit(options: {
  status: string[];
  prefix?: string;
  stagedIndex?: string[];
  hasStagedInScope?: boolean;
  commitStdout?: string;
}) {
  const {
    status,
    prefix = '',
    stagedIndex = [],
    hasStagedInScope = true,
    commitStdout = '[main abc1234] scoped commit',
  } = options;

  mockExecFileAsync.mockImplementation(async (cmd: string, args: string[]) => {
    if (cmd !== 'git') throw new Error(`unexpected command: ${cmd}`);
    if (args[0] === 'rev-parse') return { stdout: prefix ? `${prefix}\n` : '\n', stderr: '' };
    if (args[0] === 'status') return porcelainZ(...status);
    if (args[0] === 'add') return OK;
    if (args[0] === 'diff') {
      if (args.includes('--name-only')) {
        return { stdout: stagedIndex.map((p) => `${p}\0`).join(''), stderr: '' };
      }
      if (hasStagedInScope) throw gitError(1);
      return OK;
    }
    if (args[0] === 'commit') return { stdout: commitStdout, stderr: '' };
    throw new Error(`no handler configured for git ${args.join(' ')}`);
  });
}

describe('POST /api/projects/[id]/git-commit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProject).mockReturnValue(PROJECT as ReturnType<typeof getProject>);
  });

  it('404s when the project does not exist', async () => {
    vi.mocked(getProject).mockReturnValue(undefined);
    const res = await POST(makeRequest({ message: 'x' }), makeParams());
    expect(res.status).toBe(404);
  });

  it('400s when message is missing', async () => {
    const res = await POST(makeRequest({}), makeParams());
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/message/i);
  });

  describe('fallback staging (no `files` in body)', () => {
    it('runs `git add -A` — preserving prior behavior for callers that do not send `files`', async () => {
      scriptGit({
        add: async () => OK,
        diff: async () => {
          throw gitError(1); // staged changes present
        },
        commit: async () => ({ stdout: 'commit ok', stderr: '' }),
      });

      const res = await POST(makeRequest({ message: 'chore: bump deps' }), makeParams());
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        'git',
        ['add', '-A'],
        expect.objectContaining({ cwd: PROJECT.path })
      );
    });

    it('leaves `git diff --cached` and `git commit` unscoped on the -A path (no pathspec)', async () => {
      scriptGit({
        add: async () => OK,
        diff: async () => {
          throw gitError(1);
        },
        commit: async () => ({ stdout: 'commit ok', stderr: '' }),
      });

      await POST(makeRequest({ message: 'chore: bump deps' }), makeParams());

      // The general-purpose callers (project-detail's git panel, the MCP
      // git_commit tool) must keep committing the whole index.
      expect(gitArgs('diff')).toEqual(['diff', '--cached', '--quiet']);
      expect(gitArgs('commit')).toEqual(['commit', '-m', 'chore: bump deps']);
      // ...and the index-residue probe is scoped-only, so it never runs here.
      expect(gitArgs('diff', (a) => a.includes('--name-only'))).toBeUndefined();
    });

    it('sets GIT_LITERAL_PATHSPECS=1 on every git invocation', async () => {
      scriptGit({
        add: async () => OK,
        diff: async () => {
          throw gitError(1);
        },
        commit: async () => ({ stdout: 'commit ok', stderr: '' }),
      });

      await POST(makeRequest({ message: 'x' }), makeParams());

      expect(gitCalls().length).toBeGreaterThan(0);
      for (const [, , opts] of gitCalls()) {
        expect((opts.env as Record<string, string>).GIT_LITERAL_PATHSPECS).toBe('1');
      }
    });
  });

  describe('explicit `files` list', () => {
    it('stages exactly the named files via `git add --`', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      scriptGit({
        add: async () => OK,
        diff: async () => {
          throw gitError(1);
        },
        commit: async () => ({ stdout: 'commit ok', stderr: '' }),
      });

      const res = await POST(
        makeRequest({ message: 'chore: bump lodash', files: ['package.json', 'pnpm-lock.yaml'] }),
        makeParams()
      );
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        'git',
        ['add', '--', 'package.json', 'pnpm-lock.yaml'],
        expect.objectContaining({ cwd: PROJECT.path })
      );
      // F1/F2: staging scope is worthless unless the empty-check and the
      // commit carry the same pathspec — a bare `git commit -m` commits the
      // whole index, including a developer's unrelated pre-staged work.
      expect(gitArgs('diff', (a) => a.includes('--quiet'))).toEqual([
        'diff', '--cached', '--quiet', '--', 'package.json', 'pnpm-lock.yaml',
      ]);
      expect(gitArgs('commit')).toEqual([
        'commit', '-m', 'chore: bump lodash', '--', 'package.json', 'pnpm-lock.yaml',
      ]);
    });

    it('stages a deleted lockfile that no longer exists on disk (deletion, not silently skipped)', async () => {
      // pnpm-lock.yaml was removed (e.g. switching package managers) so it
      // is absent from disk, but `git status --porcelain` still reports it.
      vi.mocked(existsSync).mockImplementation((p) => !String(p).endsWith('pnpm-lock.yaml'));
      scriptGit({
        status: async () => ({ stdout: ' D pnpm-lock.yaml\n', stderr: '' }),
        add: async () => OK,
        diff: async () => {
          throw gitError(1);
        },
        commit: async () => ({ stdout: 'commit ok', stderr: '' }),
      });

      const res = await POST(
        makeRequest({ message: 'chore: switch package manager', files: ['pnpm-lock.yaml'] }),
        makeParams()
      );
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        'git',
        ['add', '--', 'pnpm-lock.yaml'],
        expect.objectContaining({ cwd: PROJECT.path })
      );
    });

    it('400s naming a file that does not exist and is not a known deletion', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      scriptGit({
        status: async () => ({ stdout: '', stderr: '' }), // git knows nothing about it either
      });

      const res = await POST(
        makeRequest({ message: 'x', files: ['does-not-exist.json'] }),
        makeParams()
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('does-not-exist.json');
      expect(mockExecFileAsync).not.toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['add']),
        expect.anything()
      );
    });

    it('400s on an absolute path', async () => {
      const res = await POST(
        makeRequest({ message: 'x', files: ['/etc/passwd'] }),
        makeParams()
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/relative/i);
    });

    it('400s on a path containing ".."', async () => {
      const res = await POST(
        makeRequest({ message: 'x', files: ['../../etc/passwd'] }),
        makeParams()
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/relative/i);
    });

    it('400s on a path that traverses out of the project via a nested segment', async () => {
      const res = await POST(
        makeRequest({ message: 'x', files: ['sub/../../outside.txt'] }),
        makeParams()
      );
      expect(res.status).toBe(400);
      expect(res.status).toBe(400);
    });

    it('400s on a non-string entry (e.g. a nested array) instead of silently dropping it', async () => {
      const res = await POST(
        makeRequest({ message: 'x', files: ['package.json', ['../../etc/passwd']] }),
        makeParams()
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/string/i);
    });

    it('400s on a non-array `files` value', async () => {
      const res = await POST(
        makeRequest({ message: 'x', files: 'package.json' }),
        makeParams()
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/array/i);
    });

    it('400s on an empty `files` array rather than silently falling back', async () => {
      const res = await POST(makeRequest({ message: 'x', files: [] }), makeParams());
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/empty/i);
    });

    // F3: `--` terminates option parsing but does NOT disable pathspec magic.
    // Verified against real git from a subdirectory: `git add -- ':/root.txt'`
    // exits 0 and stages the repo-root file; `git add -- ':(top)apps/api/.env'`
    // likewise. Both pass isAbsolute/`..`/containment checks.
    it.each([
      [':/root.txt', 'repo-root magic'],
      [':(top)apps/api/.env', '(top) magic'],
      [':!package.json', 'exclude magic'],
      [':(exclude)package.json', '(exclude) magic'],
    ])('400s on git pathspec magic %s (%s) without running git', async (badPath) => {
      vi.mocked(existsSync).mockReturnValue(true);
      const res = await POST(
        makeRequest({ message: 'x', files: [badPath] }),
        makeParams()
      );
      expect(res.status).toBe(400);
      expect(mockExecFileAsync).not.toHaveBeenCalled();
    });

    // F8: `.git/config`, `.git/hooks/pre-commit` previously passed validation.
    it.each(['.git/config', '.git/hooks/pre-commit', 'sub/.git/config', '.GIT/config'])(
      '400s on a `.git` path segment (%s) without running git',
      async (badPath) => {
        vi.mocked(existsSync).mockReturnValue(true);
        const res = await POST(
          makeRequest({ message: 'x', files: [badPath] }),
          makeParams()
        );
        expect(res.status).toBe(400);
        expect(mockExecFileAsync).not.toHaveBeenCalled();
      }
    );

    it('400s on a path containing a NUL byte without running git', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const res = await POST(
        makeRequest({ message: 'x', files: ['package.json\u0000evil'] }),
        makeParams()
      );
      expect(res.status).toBe(400);
      expect(mockExecFileAsync).not.toHaveBeenCalled();
    });

    it('no git command runs at all when a traversal path is rejected', async () => {
      for (const badPath of ['/etc/passwd', '../../etc/passwd', 'sub/../../outside.txt']) {
        vi.clearAllMocks();
        vi.mocked(getProject).mockReturnValue(PROJECT as ReturnType<typeof getProject>);
        const res = await POST(makeRequest({ message: 'x', files: [badPath] }), makeParams());
        expect(res.status).toBe(400);
        expect(mockExecFileAsync).not.toHaveBeenCalled();
      }
    });

    // F9: a failing `git status --porcelain -- <path>` used to be swallowed
    // into `false`, so the route answered 400 "File(s) not found: x" for a file
    // that exists — the same collapse-every-error-into-one-meaning bug this
    // branch fixed at the empty-check.
    it('surfaces a `git status` failure as a 500, not a 400 "file not found"', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      scriptGit({
        status: async () => {
          throw gitError(128, 'fatal: not a git repository');
        },
      });

      const res = await POST(
        makeRequest({ message: 'x', files: ['package.json'] }),
        makeParams()
      );

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toMatch(/not a git repository/);
      expect(data.error).not.toMatch(/not found/i);
      expect(gitArgs('add')).toBeUndefined();
    });
  });

  describe('scope: "dependencies"', () => {
    beforeEach(() => {
      // The route's cheap pre-flight ("is this even a JS project?") is the only
      // remaining filesystem check; the file *set* comes from git.
      vi.mocked(existsSync).mockReturnValue(true);
    });

    it('stages package.json + the detected lockfile and nothing else', async () => {
      // git reports package.json and pnpm-lock.yaml as changed, plus unrelated
      // work that must not be swept in.
      scriptScopeGit({
        status: [' M package.json', ' M pnpm-lock.yaml', ' M src/feature.ts', '?? notes.md'],
      });

      const res = await POST(
        makeRequest({ message: 'chore: bump deps', scope: 'dependencies' }),
        makeParams()
      );
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        'git',
        ['add', '--', 'package.json', 'pnpm-lock.yaml'],
        expect.objectContaining({ cwd: PROJECT.path })
      );
    });

    it('carries the scoped pathspec into `git diff --cached` and `git commit`', async () => {
      // F1/F2. Without the pathspec on the commit, `git commit -m` commits the
      // whole index and the developer's own staged WIP rides along under a
      // `chore(deps)` message; without it on the empty-check, an unrelated
      // staged file makes a no-op dependency patch look committable.
      scriptScopeGit({ status: [' M package.json', ' M pnpm-lock.yaml'] });

      await POST(
        makeRequest({ message: 'chore(deps): bump', scope: 'dependencies' }),
        makeParams()
      );

      expect(gitArgs('diff', (a) => a.includes('--quiet'))).toEqual([
        'diff', '--cached', '--quiet', '--', 'package.json', 'pnpm-lock.yaml',
      ]);
      expect(gitArgs('commit')).toEqual([
        'commit', '-m', 'chore(deps): bump', '--', 'package.json', 'pnpm-lock.yaml',
      ]);
    });

    it('F4: never stages a gitignored lockfile, because git does not report one', async () => {
      // A stray `npm install` in a pnpm repo that gitignores package-lock.json.
      // The old existsSync-based resolver included it; `git add` then aborted
      // ("paths are ignored by one of your .gitignore files") *after* staging
      // package.json, leaving the index dirty and every retry failing.
      scriptScopeGit({ status: [' M package.json', ' M pnpm-lock.yaml'] });

      const res = await POST(
        makeRequest({ message: 'chore: bump', scope: 'dependencies' }),
        makeParams()
      );

      expect((await res.json()).success).toBe(true);
      expect(gitArgs('add')).toEqual(['add', '--', 'package.json', 'pnpm-lock.yaml']);
      expect(gitArgs('add')).not.toContain('package-lock.json');
    });

    it('F5: includes a deleted lockfile so the removal is committed', async () => {
      scriptScopeGit({ status: [' M package.json', ' D yarn.lock', '?? pnpm-lock.yaml'] });

      const res = await POST(
        makeRequest({ message: 'chore: switch package manager', scope: 'dependencies' }),
        makeParams()
      );

      expect((await res.json()).success).toBe(true);
      expect(gitArgs('add')).toEqual([
        'add', '--', 'package.json', 'yarn.lock', 'pnpm-lock.yaml',
      ]);
      expect(gitArgs('commit')).toEqual([
        'commit', '-m', 'chore: switch package manager', '--',
        'package.json', 'yarn.lock', 'pnpm-lock.yaml',
      ]);
    });

    it('F6: includes nested workspace manifests at any depth, excluding node_modules', async () => {
      scriptScopeGit({
        status: [
          ' M package.json',
          ' M packages/a/package.json',
          ' M apps/web/nested/deep/package.json',
          ' M pnpm-lock.yaml',
          ' M node_modules/left-pad/package.json',
          ' M packages/a/node_modules/dep/package.json',
          ' M packages/a/src/index.ts',
        ],
      });

      await POST(makeRequest({ message: 'chore: bump', scope: 'dependencies' }), makeParams());

      expect(gitArgs('add')).toEqual([
        'add', '--',
        'package.json',
        'packages/a/package.json',
        'apps/web/nested/deep/package.json',
        'pnpm-lock.yaml',
      ]);
    });

    it('skips collapsed untracked directory entries rather than staging a whole tree', async () => {
      scriptScopeGit({ status: [' M package.json', '?? vendor/', '?? node_modules/'] });

      await POST(makeRequest({ message: 'chore: bump', scope: 'dependencies' }), makeParams());

      expect(gitArgs('add')).toEqual(['add', '--', 'package.json']);
    });

    it('puts a staged rename source in the commit pathspec but not in `git add`', async () => {
      // `git add -- <old-path>` fails with "did not match any files" once the
      // rename is in the index, but the old path must still be in the commit
      // pathspec or the deletion half of the rename is never recorded.
      scriptScopeGit({ status: ['R  pnpm-lock.yaml', 'yarn.lock', ' M package.json'] });

      await POST(makeRequest({ message: 'chore: swap lockfile', scope: 'dependencies' }), makeParams());

      expect(gitArgs('add')).toEqual(['add', '--', 'pnpm-lock.yaml', 'package.json']);
      expect(gitArgs('commit')).toEqual([
        'commit', '-m', 'chore: swap lockfile', '--',
        'pnpm-lock.yaml', 'yarn.lock', 'package.json',
      ]);
    });

    it('translates repo-root-relative porcelain paths for a project nested in a larger repo', async () => {
      scriptScopeGit({
        prefix: 'apps/api/',
        status: [
          ' M apps/api/package.json',
          ' M apps/api/pnpm-lock.yaml',
          ' M apps/web/package.json',
        ],
      });

      await POST(makeRequest({ message: 'chore: bump', scope: 'dependencies' }), makeParams());

      // cwd-relative (git pathspecs resolve against cwd), and a sibling
      // project's manifest is not ours to commit.
      expect(gitArgs('add')).toEqual(['add', '--', 'package.json', 'pnpm-lock.yaml']);
    });

    it('reports "No changes to commit" — without staging or committing — when git shows no dependency changes', async () => {
      scriptScopeGit({ status: [' M src/feature.ts'] });

      const res = await POST(
        makeRequest({ message: 'chore: bump', scope: 'dependencies' }),
        makeParams()
      );

      expect(await res.json()).toEqual({ success: false, error: 'No changes to commit' });
      expect(gitArgs('add')).toBeUndefined();
      expect(gitArgs('commit')).toBeUndefined();
      // Crucially it must NOT fall through to an empty pathspec, which would
      // degrade back to whole-index behavior.
      expect(gitArgs('diff')).toBeUndefined();
    });

    it('surfaces a `git status` failure instead of resolving an empty set', async () => {
      mockExecFileAsync.mockImplementation(async (cmd: string, args: string[]) => {
        if (args[0] === 'rev-parse') return { stdout: '\n', stderr: '' };
        if (args[0] === 'status') throw gitError(128, 'fatal: not a git repository');
        throw new Error(`unexpected git ${args.join(' ')}`);
      });

      const res = await POST(
        makeRequest({ message: 'chore: bump', scope: 'dependencies' }),
        makeParams()
      );

      expect(res.status).toBe(500);
      expect(gitArgs('commit')).toBeUndefined();
    });

    it('409s on an unresolved merge conflict in a dependency file', async () => {
      scriptScopeGit({ status: ['UU package.json'] });

      const res = await POST(
        makeRequest({ message: 'chore: bump', scope: 'dependencies' }),
        makeParams()
      );

      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/merge conflict/i);
      expect(gitArgs('add')).toBeUndefined();
      expect(gitArgs('commit')).toBeUndefined();
    });

    it('reports pre-existing staged work it excluded, and neither commits nor resets it', async () => {
      scriptScopeGit({
        status: [' M package.json', 'M  src/feature.ts'],
        stagedIndex: ['package.json', 'src/feature.ts'],
      });

      const res = await POST(
        makeRequest({ message: 'chore(deps): bump', scope: 'dependencies' }),
        makeParams()
      );
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.warnings).toEqual([expect.stringContaining('src/feature.ts')]);
      expect(gitArgs('commit')).toEqual([
        'commit', '-m', 'chore(deps): bump', '--', 'package.json',
      ]);
      // No `git reset` / `git restore` — destroying staged work would be far
      // worse than the over-broad commit this route is fixing.
      expect(gitArgs('reset')).toBeUndefined();
      expect(gitArgs('restore')).toBeUndefined();
    });

    it('400s when both `files` and `scope` are sent', async () => {
      const res = await POST(
        makeRequest({ message: 'x', files: ['package.json'], scope: 'dependencies' }),
        makeParams()
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/mutually exclusive/i);
      expect(mockExecFileAsync).not.toHaveBeenCalled();
    });

    it('400s on an unknown scope value', async () => {
      const res = await POST(
        makeRequest({ message: 'x', scope: 'everything' }),
        makeParams()
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/scope/i);
      expect(mockExecFileAsync).not.toHaveBeenCalled();
    });

    it('400s naming the problem when there is no package.json to resolve `dependencies` scope from', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const res = await POST(
        makeRequest({ message: 'x', scope: 'dependencies' }),
        makeParams()
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/package\.json/i);
      expect(mockExecFileAsync).not.toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['add']),
        expect.anything()
      );
    });
  });

  describe('nothing to commit', () => {
    it('returns success:false without committing when nothing is staged', async () => {
      scriptGit({
        add: async () => OK,
        diff: async () => OK, // exit 0 = no staged differences
      });

      const res = await POST(makeRequest({ message: 'x' }), makeParams());
      const data = await res.json();

      expect(data).toEqual({ success: false, error: 'No changes to commit' });
      expect(mockExecFileAsync).not.toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['commit']),
        expect.anything()
      );
    });

    it('treats a `git diff --cached` failure (not exit 1) as a real error, not "changes present"', async () => {
      scriptGit({
        add: async () => OK,
        diff: async () => {
          throw gitError(128, 'fatal: not a git repository');
        },
      });

      const res = await POST(makeRequest({ message: 'x' }), makeParams());
      expect(res.status).toBe(500);
      expect(mockExecFileAsync).not.toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['commit']),
        expect.anything()
      );
    });
  });

  describe('successful commit', () => {
    it('commits and reports success, logging source/advisories metadata', async () => {
      scriptGit({
        add: async () => OK,
        diff: async () => {
          throw gitError(1);
        },
        commit: async () => ({ stdout: '[main abc1234] chore: fix', stderr: '' }),
      });

      const res = await POST(
        makeRequest({
          message: 'chore: fix cve',
          source: 'cve-lite',
          advisories: ['GHSA-1234'],
        }),
        makeParams()
      );
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data).toEqual({ success: true, output: '[main abc1234] chore: fix' });
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        'git',
        ['commit', '-m', 'chore: fix cve'],
        expect.objectContaining({ cwd: PROJECT.path })
      );
    });

    it('surfaces the commit failure as a 500', async () => {
      scriptGit({
        add: async () => OK,
        diff: async () => {
          throw gitError(1);
        },
        commit: async () => {
          throw new Error('commit hook rejected');
        },
      });

      const res = await POST(makeRequest({ message: 'x' }), makeParams());
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toMatch(/commit hook rejected/);
    });
  });
});
