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
  });

  describe('scope: "dependencies"', () => {
    it('stages package.json + the detected lockfile and nothing else', async () => {
      // Only package.json and pnpm-lock.yaml exist on disk; the other known
      // lockfiles (package-lock.json, yarn.lock, bun.lockb) do not.
      vi.mocked(existsSync).mockImplementation(
        (p) =>
          String(p).endsWith('package.json') || String(p).endsWith('pnpm-lock.yaml')
      );
      scriptGit({
        add: async () => OK,
        diff: async () => {
          throw gitError(1);
        },
        commit: async () => ({ stdout: 'commit ok', stderr: '' }),
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
