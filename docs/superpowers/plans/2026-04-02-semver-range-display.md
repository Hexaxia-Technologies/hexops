# Semver Range Display in Package Health

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the `package.json` semver range (e.g. `^0.78.0`) alongside the lockfile-resolved version in the package health UI, so CVE range overlaps are visible even when the locked version is outside the affected range.

**Architecture:** Add a `specifier` field to the `Dependency` interface that preserves the raw `package.json` version string. Thread it through the API response and display it in the UI. No new APIs or scanning logic needed — the data is already available in `parseDeps()` but gets stripped.

**Tech Stack:** TypeScript, Next.js API routes, React components

---

### Task 1: Add `specifier` field to Dependency type and API response

**Files:**
- Modify: `src/app/api/projects/[id]/package-health/route.ts:12-18` (Dependency interface)
- Modify: `src/app/api/projects/[id]/package-health/route.ts:56-68` (parseDeps function)

- [ ] **Step 1: Add `specifier` to the Dependency interface**

In `src/app/api/projects/[id]/package-health/route.ts`, add the `specifier` field:

```typescript
interface Dependency {
  name: string;
  current: string;
  specifier: string;  // Raw version from package.json (e.g. "^0.78.0")
  wanted?: string;
  latest?: string;
  isOutdated: boolean;
}
```

- [ ] **Step 2: Preserve the raw specifier in parseDeps**

In the same file, update `parseDeps` to keep the original version string:

```typescript
const parseDeps = (deps: Record<string, string> | undefined): Dependency[] => {
  if (!deps) return [];
  return Object.entries(deps).map(([name, version]) => {
    const outdated = outdatedInfo[name];
    return {
      name,
      current: version.replace(/^[\^~]/, ''),
      specifier: version,  // Preserve raw specifier
      wanted: outdated?.wanted,
      latest: outdated?.latest,
      isOutdated: !!outdated,
    };
  });
};
```

- [ ] **Step 3: Verify the API response includes specifier**

Run: `curl -s http://localhost:3060/api/projects/<any-project-id>/package-health | jq '.dependencies[0]'`

Expected: Response includes `"specifier": "^x.y.z"` alongside `"current": "x.y.z"`.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/projects/\[id\]/package-health/route.ts
git commit -m "feat: preserve semver specifier in package-health API response"
```

---

### Task 2: Display specifier in the package health UI

**Files:**
- Modify: `src/components/detail-sections/package-health-section.tsx:24-30` (Dependency interface)
- Modify: `src/components/detail-sections/package-health-section.tsx:440-448` (version display in DependencyList)

- [ ] **Step 1: Add `specifier` to the client-side Dependency interface**

In `src/components/detail-sections/package-health-section.tsx`, update the interface:

```typescript
interface Dependency {
  name: string;
  current: string;
  specifier?: string;  // Raw version from package.json (e.g. "^0.78.0")
  wanted?: string;
  latest?: string;
  isOutdated: boolean;
}
```

- [ ] **Step 2: Show the specifier next to the current version**

In the `DependencyList` component, update the version display section (around line 440-448). Replace the current version span with a version that shows the specifier when it differs from current:

```tsx
<span className={cn(
  'font-mono',
  dep.isOutdated && !isHeld ? 'text-yellow-500/70' :
  dep.isOutdated && isHeld ? 'text-zinc-600' :
  'text-zinc-500'
)}>
  {dep.current}
  {dep.specifier && dep.specifier !== dep.current && (
    <span className="text-zinc-600 ml-1">({dep.specifier})</span>
  )}
</span>
```

This shows `0.78.0 (^0.78.0)` when a range prefix exists, and just `0.78.0` for exact pins.

- [ ] **Step 3: Verify the UI renders correctly**

Open the HexOps dashboard, navigate to any project's package health section. Confirm:
- Packages with `^` or `~` prefixes show the specifier in parentheses
- Exact-pinned packages show only the version number
- Layout doesn't break with the extra text

- [ ] **Step 4: Commit**

```bash
git add src/components/detail-sections/package-health-section.tsx
git commit -m "feat: display semver specifier alongside locked version in package health UI"
```

---

### Task 3: Show specifier in vulnerability list rows

**Files:**
- Modify: `src/components/detail-sections/package-health-section.tsx:261-284` (vulnerability list display)
- Modify: `src/components/detail-sections/package-health-section.tsx:40-45` (PackageHealth Vulnerability interface)

The vulnerability list currently shows package name + title but not the version or specifier. Add the specifier so you can see at a glance whether the range overlaps the CVE.

- [ ] **Step 1: Extend the Vulnerability interface to include version info**

In `package-health-section.tsx`, update the Vulnerability interface:

```typescript
interface Vulnerability {
  name: string;
  severity: 'info' | 'low' | 'moderate' | 'high' | 'critical';
  title: string;
  path: string;
  fixAvailable: boolean;
}
```

No change needed here — the vulnerability data comes from the audit route, not package-health. Instead, we'll cross-reference the dependency list.

- [ ] **Step 2: Cross-reference vulnerabilities with dependency specifiers**

In the vulnerability display section (around line 261-284), look up the specifier from the dependency list for each vulnerability:

```tsx
{health.vulnerabilities.map((vuln, i) => {
  const dep = [...health.dependencies, ...health.devDependencies].find(d => d.name === vuln.name);
  return (
    <div
      key={i}
      className="flex items-center justify-between py-2 px-3 bg-zinc-900 rounded text-sm"
    >
      <div className="flex items-center gap-2">
        <SeverityBadge severity={vuln.severity} />
        <span className="font-mono text-zinc-300">{vuln.name}</span>
        {dep?.specifier && (
          <span className="font-mono text-zinc-600 text-xs">{dep.specifier}</span>
        )}
        <span className="text-zinc-500 truncate max-w-[200px]">{vuln.title}</span>
      </div>
      {vuln.fixAvailable && (
        <Badge variant="outline" className="text-xs border-green-500/50 text-green-400">
          Fix available
        </Badge>
      )}
    </div>
  );
})}
```

- [ ] **Step 3: Verify vulnerability rows show the specifier**

Open a project with known vulnerabilities (e.g. Hextant Boardroom). Confirm:
- Each vulnerability row shows the semver specifier next to the package name
- The specifier is visually secondary (dimmer color, smaller text)

- [ ] **Step 4: Commit**

```bash
git add src/components/detail-sections/package-health-section.tsx
git commit -m "feat: show semver specifier in vulnerability list for CVE range context"
```
