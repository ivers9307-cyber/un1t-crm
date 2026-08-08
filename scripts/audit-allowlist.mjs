// Pure logic for the runtime dependency audit gate (see
// scripts/check-dependency-audit.mjs for the CLI wrapper and the war
// story). Kept separate and side-effect free so it can be unit-tested —
// tests/dependency-audit.test.js drives it with real `npm audit --json`
// payloads captured from the live ip-address advisory.

// npm's `--audit-level=high` gates on the PACKAGE-level severity, but a
// vulnerable package's `via` array mixes severities: the ip-address case
// that motivated this file is one `high` plus two `moderate` riding along
// on the same package. Only these two need an explicit accept decision.
export const GATED_SEVERITIES = new Set(['high', 'critical'])

const GHSA_RE = /(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})/i

// GHSA id is the stable, quotable identifier. npm's numeric `source` id
// is registry-local and means nothing in a PR review, so it is only a
// fallback for the rare advisory with no GHSA url.
export function advisoryId(via) {
  const fromUrl = String(via?.url || '').match(GHSA_RE)
  return fromUrl ? fromUrl[1] : `npm-${via?.source}`
}

// Flatten an `npm audit --json` report into a de-duplicated advisory
// list, split by whether the severity clears the gate. A single advisory
// can appear under several packages (once per affected dependent), hence
// the de-dupe by id.
export function collectAdvisories(report) {
  const gated = []
  const informational = []
  const seen = new Set()

  for (const vuln of Object.values(report?.vulnerabilities || {})) {
    for (const via of vuln.via || []) {
      // A string `via` is a transitive pointer to another vulnerable
      // package, not an advisory in its own right — the advisory is
      // enumerated on the package it originates from.
      if (typeof via !== 'object' || !via?.title) continue
      const id = advisoryId(via)
      if (seen.has(id)) continue
      seen.add(id)
      const record = {
        id,
        package: via.name || vuln.name,
        severity: via.severity,
        title: via.title,
        url: via.url,
        range: via.range,
      }
      if (GATED_SEVERITIES.has(via.severity)) gated.push(record)
      else informational.push(record)
    }
  }
  return { gated, informational }
}

const REQUIRED_FIELDS = ['id', 'package', 'reason', 'expires']

// An entry missing a field — especially `expires` — would silently
// become a permanent mute, which is the exact failure this gate exists
// to prevent. So a malformed allowlist is a hard error, not a skip.
export function validateAllowlist(entries) {
  const problems = []
  for (const entry of entries || []) {
    for (const field of REQUIRED_FIELDS) {
      if (!entry?.[field]) problems.push(`entry ${JSON.stringify(entry)} is missing "${field}"`)
    }
    if (entry?.expires && !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires)) {
      problems.push(`${entry.id} has expires="${entry.expires}" (want YYYY-MM-DD)`)
    }
  }
  return problems
}

// Split gated advisories three ways against the allowlist. `today` is
// passed in (never read from the clock here) so expiry behaviour is
// deterministic under test.
export function classifyAdvisories(gated, allowlist, today) {
  const byId = new Map((allowlist || []).map((e) => [String(e.id).toUpperCase(), e]))
  const accepted = []
  const expired = []
  const unlisted = []

  for (const adv of gated) {
    const entry = byId.get(adv.id.toUpperCase())
    if (!entry) unlisted.push(adv)
    // Lexicographic compare is correct and timezone-free for
    // zero-padded YYYY-MM-DD, which validateAllowlist has enforced.
    else if (entry.expires < today) expired.push({ ...adv, entry })
    else accepted.push({ ...adv, entry })
  }

  const gatedIds = new Set(gated.map((a) => a.id.toUpperCase()))
  // Stale entries are reported but never fail the build: unlike a stale
  // route-guard exemption, an entry for an advisory npm no longer
  // reports masks nothing today, and its expiry already bounds how long
  // it can linger.
  const stale = (allowlist || []).filter((e) => !gatedIds.has(String(e.id).toUpperCase()))

  return { accepted, expired, unlisted, stale }
}
