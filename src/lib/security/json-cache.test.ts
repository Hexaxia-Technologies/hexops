import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	_namespacesCollide,
	_setJsonCacheDirForTest,
	readJsonCache,
	readJsonCacheEntry,
	writeJsonCache,
} from "./json-cache";
import { _setCveLiteCacheDirForTest, readCveLiteCache, writeCveLiteCache } from "./cve-lite-cache";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hexops-json-cache-"));
	_setJsonCacheDirForTest(dir);
	return () => rmSync(dir, { recursive: true, force: true });
});

describe("json-cache", () => {
	it("returns null when missing", () => {
		expect(readJsonCache("override-audit", "p1", "v1")).toBeNull();
	});

	it("round-trips a fresh write", () => {
		writeJsonCache("override-audit", "p1", "v1", { findings: [] });
		expect(readJsonCache("override-audit", "p1", "v1")).toEqual({ findings: [] });
	});

	it("writes the exact `<namespace>-<id>.json` filename", () => {
		writeJsonCache("override-audit", "proj-123", "v1", { ok: true });
		expect(readdirSync(dir)).toEqual(["override-audit-proj-123.json"]);
	});

	it("atomic write leaves no .tmp file", () => {
		writeJsonCache("override-audit", "p1", "v1", { ok: true });
		expect(readdirSync(dir).some((f) => f.endsWith(".tmp"))).toBe(false);
	});

	it("returns null on a toolVersion mismatch", () => {
		writeJsonCache("override-audit", "p1", "v1", { ok: true });
		expect(readJsonCache("override-audit", "p1", "v2")).toBeNull();
	});

	it("returns null past the TTL", () => {
		const staleAt = new Date(Date.now() - 3_600_001).toISOString();
		writeFileSync(
			join(dir, "override-audit-p1.json"),
			JSON.stringify({ cachedAt: staleAt, ttlMs: 3_600_000, toolVersion: "v1", payload: { ok: true } }),
		);
		expect(readJsonCache("override-audit", "p1", "v1")).toBeNull();
	});

	it("returns the entry within the TTL", () => {
		const recent = new Date(Date.now() - 60_000).toISOString();
		writeFileSync(
			join(dir, "override-audit-p1.json"),
			JSON.stringify({ cachedAt: recent, ttlMs: 3_600_000, toolVersion: "v1", payload: { ok: true } }),
		);
		expect(readJsonCache("override-audit", "p1", "v1")).toEqual({ ok: true });
	});

	it("treats malformed JSON as no cache", () => {
		writeFileSync(join(dir, "override-audit-p1.json"), "not json");
		expect(readJsonCache("override-audit", "p1", "v1")).toBeNull();
	});

	it("ignoreTtl returns an expired entry", () => {
		const staleAt = new Date(Date.now() - 7_200_000).toISOString();
		writeFileSync(
			join(dir, "override-audit-p1.json"),
			JSON.stringify({ cachedAt: staleAt, ttlMs: 3_600_000, toolVersion: "v1", payload: { ok: true } }),
		);
		expect(readJsonCacheEntry("override-audit", "p1", "v1", { ignoreTtl: true })?.payload).toEqual({ ok: true });
	});

	it("ignoreTtl does not resurrect a toolVersion mismatch", () => {
		const staleAt = new Date(Date.now() - 7_200_000).toISOString();
		writeFileSync(
			join(dir, "override-audit-p1.json"),
			JSON.stringify({ cachedAt: staleAt, ttlMs: 3_600_000, toolVersion: "v1", payload: { ok: true } }),
		);
		expect(readJsonCacheEntry("override-audit", "p1", "v2", { ignoreTtl: true })).toBeNull();
	});

	it("treats a non-finite cachedAt age as a cache miss, even with ignoreTtl", () => {
		writeFileSync(
			join(dir, "override-audit-p1.json"),
			JSON.stringify({ cachedAt: "not-a-date", ttlMs: 3_600_000, toolVersion: "v1", payload: { ok: true } }),
		);
		expect(readJsonCache("override-audit", "p1", "v1")).toBeNull();
		expect(readJsonCacheEntry("override-audit", "p1", "v1", { ignoreTtl: true })).toBeNull();
	});

	it("reads a legacy entry written under the field name `report` (pre-refactor cve-lite-cache format)", () => {
		const recent = new Date(Date.now() - 60_000).toISOString();
		writeFileSync(
			join(dir, "cve-lite-p1.json"),
			JSON.stringify({ cachedAt: recent, ttlMs: 3_600_000, toolVersion: "v1", report: { findingCount: 1 } }),
		);
		expect(readJsonCache("cve-lite", "p1", "v1")).toEqual({ findingCount: 1 });
	});

	it("rejects an unregistered namespace", () => {
		// @ts-expect-error -- exercising the runtime guard for a namespace TypeScript wouldn't allow
		expect(() => writeJsonCache("cve", "p1", "v1", {})).toThrow(/not registered/);
	});

	describe("_namespacesCollide", () => {
		it("flags a namespace that is another plus a trailing separator", () => {
			expect(_namespacesCollide("cve", "cve-lite")).toBe(true);
			expect(_namespacesCollide("cve-lite", "cve")).toBe(true);
		});

		it("does not flag the real registered namespaces", () => {
			expect(_namespacesCollide("cve-lite", "override-audit")).toBe(false);
		});

		it("does not flag a namespace against itself", () => {
			expect(_namespacesCollide("cve-lite", "cve-lite")).toBe(false);
		});

		it("does not flag unrelated namespaces that merely share a prefix character run", () => {
			// 'cve-liteX' is not 'cve-lite' + separator + anything, so no collision.
			expect(_namespacesCollide("cve-lite", "cve-liteX")).toBe(false);
		});
	});

	describe("test-dir setters share one underlying directory", () => {
		it("_setCveLiteCacheDirForTest also redirects json-cache's own dir", () => {
			const dirA = mkdtempSync(join(tmpdir(), "hexops-shared-dir-a-"));
			const dirB = mkdtempSync(join(tmpdir(), "hexops-shared-dir-b-"));
			try {
				_setCveLiteCacheDirForTest(dirA);
				writeCveLiteCache("p1", { findingCount: 1, findings: [] });
				expect(readdirSync(dirA)).toContain("cve-lite-p1.json");

				// Switching via the json-cache setter must move the *same*
				// underlying variable that cve-lite-cache reads from.
				_setJsonCacheDirForTest(dirB);
				expect(readCveLiteCache("p1")).toBeNull(); // dirA's entry is not visible from dirB
				writeCveLiteCache("p1", { findingCount: 2, findings: [] });
				expect(readdirSync(dirB)).toContain("cve-lite-p1.json");
				expect(readCveLiteCache("p1")?.report.findingCount).toBe(2);
			} finally {
				rmSync(dirA, { recursive: true, force: true });
				rmSync(dirB, { recursive: true, force: true });
			}
		});
	});
});
