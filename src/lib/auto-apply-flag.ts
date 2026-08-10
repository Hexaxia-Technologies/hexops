/**
 * Master kill-switch for applying dependency fixes from the dashboards.
 * Gates: Patches "Update Selected", CVE Lite "Fix all direct" + per-finding "Apply".
 * Endpoints /update, /cve-lite/fix, /override-remove return 409 when false.
 */
export const AUTO_APPLY_ENABLED: boolean = true;

/**
 * Gates the Patches "fix now" button specifically (fixViaOverride path).
 * Kept disabled: applying a transitive fix via package-manager override + reinstall
 * cascaded a single postcss bump into ~88 changed packages on hexaxia-media (2026-05-21).
 * Needs a safer workflow (preview resolved-tree delta, bounded scope) before re-enabling.
 */
export const FIX_VIA_OVERRIDE_ENABLED: boolean = false;

/**
 * Gates `cve-lite overrides --fix`, which rewrites override entries in
 * package.json. Deliberately independent of AUTO_APPLY_ENABLED and
 * FIX_VIA_OVERRIDE_ENABLED so CVE fixes can stay enabled while override
 * rewriting stays off. Default off until the behavior is trusted on the fleet.
 *
 * cve-lite's chokepoint guard means --fix can only remove, repin, move, or
 * relocate an EXISTING override key — it can never introduce a new one.
 */
export const OVERRIDE_HYGIENE_FIX_ENABLED: boolean = false;
