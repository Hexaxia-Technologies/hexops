import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ScanSource, Finding, ScanSourceResult } from '../types';
import type { ProjectConfig } from '../../types';
import { logger } from '../../logger';

// Node builtins (roots only; subpaths reduce to root via rootPkg, node: handled by isBare)
const BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2',
  'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode',
  'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls',
  'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib', 'test',
]);

// NOTE: requires whitespace before the binding; minified `import{x}from'p'` is not matched — acceptable, minified code lives in dist/node_modules (both in SKIP_DIRS).
const RE_FROM = /(?:import|export)\s+(?:type\s+)?([^'";]*?)\s+from\s*['"]([^'"]+)['"]/g;
const RE_SIDE = /(?:^|[;{}])\s*import\s*['"]([^'"]+)['"]/g;
const RE_REQUIRE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

export function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlock.replace(/(^|[^:])\/\/.*$/gm, '$1');
}

export function rootPkg(spec: string): string {
  if (spec.startsWith('@')) {
    const parts = spec.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : spec;
  }
  return spec.split('/')[0];
}

function isBare(spec: string): boolean {
  return !(
    spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:') ||
    spec.startsWith('@/') || spec.startsWith('~') || spec.startsWith('#')
  );
}

function isTypeOnlyImport(matchText: string, body: string): boolean {
  if (/^\s*(?:import|export)\s+type\b/.test(matchText)) return true;
  const b = body.trim();
  if (b.startsWith('{') && b.endsWith('}')) {
    const parts = b.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0 && parts.every((p) => /^type\s/.test(p))) return true;
  }
  return false;
}

export function collectValueImports(content: string): Set<string> {
  const src = stripComments(content);
  const found = new Set<string>();
  const consider = (spec: string) => {
    if (!isBare(spec)) return;
    const root = rootPkg(spec);
    if (BUILTINS.has(root)) return;
    found.add(root);
  };
  RE_FROM.lastIndex = 0;
  for (let m = RE_FROM.exec(src); m !== null; m = RE_FROM.exec(src)) {
    if (isTypeOnlyImport(m[0], m[1] ?? '')) continue;
    consider(m[2]);
  }
  RE_SIDE.lastIndex = 0;
  for (let m = RE_SIDE.exec(src); m !== null; m = RE_SIDE.exec(src)) consider(m[1]);
  RE_REQUIRE.lastIndex = 0;
  for (let m = RE_REQUIRE.exec(src); m !== null; m = RE_REQUIRE.exec(src)) consider(m[1]);
  return found;
}

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'unknown';

export interface PhantomScanInput {
  declared: Set<string>;
  overrides: Set<string>;
  packageManager: PackageManager;
  workspaceNames: Set<string>;
  files: Array<{ path: string; content: string }>;
}

export interface PhantomFinding {
  pkg: string;
  importSites: string[];
  inOverrides: boolean;
  buildPath: boolean;
  severity: 'high' | 'low';
}

function isScriptPath(p: string): boolean {
  const norm = p.replace(/\\/g, '/');
  return /(^|\/)(scripts|test|tests|__tests__|__mocks__)\//.test(norm)
    || /\.(test|spec)\.[cm]?[jt]sx?$/.test(norm);
}

export function detectPhantomDeps(input: PhantomScanInput): PhantomFinding[] {
  const { declared, overrides, packageManager, workspaceNames, files } = input;
  const sites = new Map<string, Set<string>>();
  for (const file of files) {
    for (const root of collectValueImports(file.content)) {
      if (declared.has(root) || workspaceNames.has(root)) continue;
      if (!sites.has(root)) sites.set(root, new Set());
      sites.get(root)?.add(file.path);
    }
  }
  const findings: PhantomFinding[] = [];
  for (const [pkg, siteSet] of sites) {
    const importSites = Array.from(siteSet).sort();
    const buildPath = importSites.some((p) => !isScriptPath(p));
    const severity: 'high' | 'low' = packageManager === 'pnpm' && buildPath ? 'high' : 'low';
    findings.push({ pkg, importSites, inOverrides: overrides.has(pkg), buildPath, severity });
  }
  return findings.sort((a, b) => a.pkg.localeCompare(b.pkg));
}

const SRC_DIRS = ['src', 'app', 'pages', 'lib', 'components', 'server', 'config', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'out', 'coverage', '.turbo', '.vercel', '.pnpm', '__tests__', '__mocks__']);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const SRC_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 5000;

interface PkgJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  overrides?: Record<string, unknown>;
  resolutions?: Record<string, unknown>;
  pnpm?: { overrides?: Record<string, unknown> };
  packageManager?: string;
  workspaces?: string[] | { packages?: string[] };
  name?: string;
  version?: string;
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function resolvePM(pkg: PkgJson, root: string): Promise<PackageManager> {
  const field = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : '';
  if (field === 'pnpm' || field === 'npm' || field === 'yarn') return field;
  if (await exists(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await exists(path.join(root, 'package-lock.json'))) return 'npm';
  if (await exists(path.join(root, 'yarn.lock'))) return 'yarn';
  return 'unknown';
}

async function resolveWorkspaceNames(pkg: PkgJson, root: string): Promise<Set<string>> {
  const names = new Set<string>();
  const ws = pkg.workspaces;
  const patterns: string[] = Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : [];
  for (const pat of patterns) {
    if (!pat.endsWith('/*')) continue;
    const base = path.join(root, pat.slice(0, -2));
    let entries: string[] = [];
    try { entries = await fs.readdir(base); } catch { continue; }
    for (const e of entries) {
      try {
        const pj = JSON.parse(await fs.readFile(path.join(base, e, 'package.json'), 'utf8')) as PkgJson;
        if (typeof pj.name === 'string') names.add(pj.name);
      } catch { /* skip */ }
    }
  }
  return names;
}

async function gatherFiles(root: string): Promise<Array<{ path: string; content: string }>> {
  const out: Array<{ path: string; content: string }> = [];
  let truncated = false;

  const readCapped = async (abs: string) => {
    if (out.length >= MAX_FILES) { truncated = true; return; }
    if (TEST_FILE.test(abs)) return;
    try {
      const st = await fs.stat(abs);
      if (st.size > MAX_FILE_BYTES) return;
      out.push({ path: path.relative(root, abs), content: await fs.readFile(abs, 'utf8') });
    } catch { /* unreadable */ }
  };

  const walk = async (dir: string) => {
    let entries: import('fs').Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_FILES) { truncated = true; return; }
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(abs);
      } else if (e.isFile() && SRC_EXTS.has(path.extname(e.name))) {
        await readCapped(abs);
      }
    }
  };

  try {
    for (const e of await fs.readdir(root, { withFileTypes: true })) {
      if (e.isFile() && SRC_EXTS.has(path.extname(e.name))) await readCapped(path.join(root, e.name));
    }
  } catch { /* unreadable root */ }
  for (const d of SRC_DIRS) {
    const abs = path.join(root, d);
    if (await exists(abs)) await walk(abs);
  }
  if (truncated) logger.warn('security', 'dependency_health_truncated', `File cap hit scanning ${root}`);
  return out;
}

async function readInstalledVersion(root: string, pkg: string): Promise<string | undefined> {
  try {
    const pj = JSON.parse(await fs.readFile(path.join(root, 'node_modules', pkg, 'package.json'), 'utf8')) as PkgJson;
    return typeof pj.version === 'string' ? pj.version : undefined;
  } catch { return undefined; }
}

function toFinding(pf: PhantomFinding, version: string | undefined, pm: PackageManager): Finding {
  const target = pf.buildPath ? 'dependencies' : 'devDependencies';
  const verSuffix = version ? `@${version}` : '';
  const devFlag = pf.buildPath ? '' : pm === 'yarn' ? ' --dev' : ' -D';
  const verb = pm === 'pnpm' ? 'pnpm add' : pm === 'yarn' ? 'yarn add' : 'npm install';
  const why = pf.inOverrides ? 'present only as an overrides/resolutions version pin' : 'resolved only transitively';
  const risk = pm === 'pnpm'
    ? "pnpm's strict layout makes it unreachable from source — clean installs (e.g. Vercel) fail with \"module not found\""
    : 'npm flat-hoisting resolves it today, but it breaks on a pnpm migration or any transitive change';
  return {
    type: 'config',
    dedupKey: '',
    sources: ['dependency-health'],
    title: `Undeclared dependency: ${pf.pkg}`,
    detail: `${pf.pkg} is imported in source (${pf.importSites.join(', ')}) but not declared in package.json — ${why}. ${risk}.`,
    package: pf.pkg,
    version,
    path: 'package.json',
    severity: pf.severity,
    advisoryIds: [],
    rawBySource: {
      'dependency-health': {
        pkg: pf.pkg,
        importSites: pf.importSites,
        inOverrides: pf.inOverrides,
        buildPath: pf.buildPath,
        packageManager: pm,
      },
    },
    references: [],
    remediation: {
      source: 'dependency-health',
      relationship: 'direct',
      recommendedAction: `Declare ${pf.pkg} in ${target}${version ? ` (e.g. ^${version})` : ''}`,
      runnableFixCommand: `${verb}${devFlag} ${pf.pkg}${verSuffix}`,
    },
    reachable: null,
  };
}

async function scan(project: ProjectConfig): Promise<ScanSourceResult> {
  const root = project.path;
  let pkg: PkgJson;
  try {
    pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as PkgJson;
  } catch {
    return { findings: [] };
  }
  const declared = new Set<string>([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]);
  const overrides = new Set<string>([
    ...Object.keys(pkg.overrides ?? {}),
    ...Object.keys(pkg.pnpm?.overrides ?? {}),
    ...Object.keys(pkg.resolutions ?? {}),
  ]);
  const packageManager = await resolvePM(pkg, root);
  const workspaceNames = await resolveWorkspaceNames(pkg, root);
  const files = await gatherFiles(root);
  const phantoms = detectPhantomDeps({ declared, overrides, packageManager, workspaceNames, files });

  const findings: Finding[] = [];
  for (const pf of phantoms) {
    const version = await readInstalledVersion(root, pf.pkg);
    findings.push(toFinding(pf, version, packageManager));
  }
  return { findings };
}

export const DependencyHealthSource: ScanSource = {
  id: 'dependency-health',
  displayName: 'Dependency Health',
  findingTypes: ['config'],
  timeoutMs: 30_000,
  isAvailable: async () => true,
  scan,
};
