import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface JsonCacheEntry<T> {
	cachedAt: string;
	ttlMs: number;
	toolVersion: string;
	payload: T;
}

const DEFAULT_TTL_MS = 3_600_000; // 1 hour
const SEPARATOR = '-';

/**
 * Namespaces sharing this cache. Closed on purpose: `cachePath` joins
 * `namespace` and `id` with a bare SEPARATOR, so a namespace that is another
 * namespace plus a trailing separator (e.g. 'cve' vs 'cve-lite') could
 * produce the same on-disk filename for two different logical entries —
 * `cve` + '-' + 'lite-p1'  ===  'cve-lite' + '-' + 'p1'. Requiring every
 * namespace to be registered here, and self-checking the registry below,
 * makes that collision structurally impossible rather than merely unlikely.
 */
const REGISTERED_NAMESPACES = ['cve-lite', 'override-audit'] as const;
export type JsonCacheNamespace = (typeof REGISTERED_NAMESPACES)[number];

/**
 * True when `a` and `b` could produce the same `<namespace>-<id>.json`
 * filename for some choice of id, because one is the other plus a trailing
 * separator. Exported only for tests.
 */
export function _namespacesCollide(a: string, b: string): boolean {
	if (a === b) return false;
	const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
	return longer.startsWith(shorter + SEPARATOR);
}

// Fail fast (at import time) if the registry itself is unsafe.
for (let i = 0; i < REGISTERED_NAMESPACES.length; i++) {
	for (let j = i + 1; j < REGISTERED_NAMESPACES.length; j++) {
		if (_namespacesCollide(REGISTERED_NAMESPACES[i], REGISTERED_NAMESPACES[j])) {
			throw new Error(
				`json-cache: registered namespaces "${REGISTERED_NAMESPACES[i]}" and "${REGISTERED_NAMESPACES[j]}" can collide via the separator`,
			);
		}
	}
}

function assertRegisteredNamespace(namespace: string): void {
	if (!(REGISTERED_NAMESPACES as readonly string[]).includes(namespace)) {
		throw new Error(
			`json-cache: namespace "${namespace}" is not registered in REGISTERED_NAMESPACES (json-cache.ts). ` +
				'Add it there only after confirming — via _namespacesCollide — that it cannot collide with an existing namespace.',
		);
	}
}

let cacheDir = join(process.cwd(), '.hexops', 'cache');

export function _setJsonCacheDirForTest(dir: string) {
	cacheDir = dir;
}

function cachePath(namespace: JsonCacheNamespace, id: string) {
	assertRegisteredNamespace(namespace);
	return join(cacheDir, `${namespace}${SEPARATOR}${id}.json`);
}

/**
 * Reads a cache entry with its metadata intact (cachedAt/ttlMs/toolVersion).
 * `readJsonCache` below is a convenience wrapper for callers that only want
 * the payload; typed wrappers such as cve-lite-cache.ts use this directly so
 * they can re-expose the metadata under their own field names.
 */
export function readJsonCacheEntry<T>(
	namespace: JsonCacheNamespace,
	id: string,
	toolVersion: string,
	opts: { ignoreTtl?: boolean } = {},
): JsonCacheEntry<T> | null {
	const path = cachePath(namespace, id);
	if (!existsSync(path)) return null;
	try {
		// `report` is accepted as a synonym for `payload`: cve-lite-cache.ts
		// wrote entries under that field name before this cache module was
		// extracted and shared, so real on-disk caches from before this
		// refactor still use it. Without this fallback they'd parse with
		// `payload: undefined` instead of cleanly missing.
		const raw = JSON.parse(readFileSync(path, 'utf-8')) as JsonCacheEntry<T> & { report?: T };
		if (!raw || typeof raw.cachedAt !== 'string') return null;
		// Version gate first: a stale entry from a different tool version must
		// never be resurrected, even via ignoreTtl.
		if (raw.toolVersion !== toolVersion) return null;
		const age = Date.now() - new Date(raw.cachedAt).getTime();
		// A corrupt cachedAt yields NaN, and `NaN > ttlMs` is false — without
		// this check a corrupt entry would be served as if it were fresh.
		if (!Number.isFinite(age)) return null;
		if (!opts.ignoreTtl && age > (raw.ttlMs ?? DEFAULT_TTL_MS)) return null;
		const payload = raw.payload !== undefined ? raw.payload : raw.report;
		if (payload === undefined) return null;
		return { cachedAt: raw.cachedAt, ttlMs: raw.ttlMs ?? DEFAULT_TTL_MS, toolVersion: raw.toolVersion, payload };
	} catch {
		return null;
	}
}

export function readJsonCache<T>(namespace: JsonCacheNamespace, id: string, toolVersion: string): T | null {
	return readJsonCacheEntry<T>(namespace, id, toolVersion)?.payload ?? null;
}

export function writeJsonCache<T>(
	namespace: JsonCacheNamespace,
	id: string,
	toolVersion: string,
	payload: T,
): void {
	if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
	const finalPath = cachePath(namespace, id);
	const tmp = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
	const entry: JsonCacheEntry<T> = { cachedAt: new Date().toISOString(), ttlMs: DEFAULT_TTL_MS, toolVersion, payload };
	writeFileSync(tmp, JSON.stringify(entry, null, 2));
	try {
		renameSync(tmp, finalPath);
	} catch (err) {
		try { unlinkSync(tmp); } catch { /* ignore */ }
		throw err;
	}
}
