#!/usr/bin/env node
// Runtime dependency audit gate, with an explicit accepted-advisory
// allowlist. Reads an `npm audit --json` report on stdin:
//
//   npm audit --omit=dev --audit-level=high --json | node scripts/check-dependency-audit.mjs
//
// (that pipeline is `npm run check:dependency-audit`; a shell pipeline
// takes the exit status of the LAST command, so this script's exit code
// is the gate — npm audit's own non-zero exit is correctly ignored.)
//
// Replaces the bare `npm audit --omit=dev --audit-level=high` the
// Dependency audit workflow used to run. Same threshold, but a
// HIGH/CRITICAL advisory can be explicitly ACCEPTED in
// `.audit-allowlist.json` with a reason and an expiry date, so a
// genuinely NEW advisory still stands out instead of drowning in a job
// that has been red for days.
//
// The failure mode this exists to prevent (live, 2026-08-04 → 08-07):
// three HIGH advisories landed against `ip-address`, reached via
// imapflow → socks. The job went red on every dep-touching PR and on the
// Monday schedule. Because it is NOT a required check — `main` has no
// branch protection at all — PRs kept merging straight past it for three
// days. A permanently-red check is the worst of both worlds: all the
// noise of a failing gate, none of the protection. Nobody can tell "the
// known one is still open" from "something new just landed", because
// both render as the same red X.
//
// The allowlist makes that distinction machine-checkable:
//   - in the allowlist, not expired  → ACCEPTED, does not fail
//   - in the allowlist, past expiry  → FAILS (entries cannot rot)
//   - not in the allowlist           → FAILS (the new-advisory signal)
//
// Every entry carries an `expires` date, so accepting an advisory is
// always a dated decision to revisit, never a permanent mute. An
// allowlist without expiry is just a way to turn the check off slowly.
//
// Deliberately NOT handled here:
//   - devDependencies. `--omit=dev` is the existing posture: build-time
//     packages are not reachable by an attacker at runtime, and the
//     Next-via-postcss moderate would otherwise be permanent noise.
//   - `mobile/`. Its lockfile has no overlap with the web tree today
//     (verified 2026-08-07: no ip-address / socks / imapflow), and the
//     workflow has never audited it. Out of scope for this script.

import fs from 'node:fs'
import { collectAdvisories, validateAllowlist, classifyAdvisories } from './audit-allowlist.mjs'

const ALLOWLIST_PATH = '.audit-allowlist.json'

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

// A broken audit must fail LOUDLY. Silently passing when npm produced no
// report (registry unreachable, auth failure, wrong flags) would reopen
// the exact hole this job exists to close.
const raw = readStdin()
if (!raw.trim()) {
  console.error('✗ AUDIT DID NOT RUN — no report on stdin.')
  console.error('\n  Expected: npm audit --omit=dev --audit-level=high --json | node scripts/check-dependency-audit.mjs')
  console.error('  This is NOT a pass. Fix the audit invocation before merging.\n')
  process.exit(1)
}

let report
try {
  report = JSON.parse(raw)
} catch {
  console.error('✗ AUDIT OUTPUT WAS NOT JSON — cannot verify dependencies.')
  console.error(`\n  First 300 chars received:\n  ${raw.slice(0, 300)}\n`)
  process.exit(1)
}

// npm surfaces registry/network failures as an `error` object in an
// otherwise well-formed JSON document.
if (report.error) {
  console.error('✗ npm audit reported an error — dependencies were NOT verified.')
  console.error(`\n  ${report.error.summary || JSON.stringify(report.error)}\n`)
  process.exit(1)
}

let allowlist = []
if (fs.existsSync(ALLOWLIST_PATH)) {
  try {
    allowlist = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8')).accepted || []
  } catch (e) {
    console.error(`✗ ${ALLOWLIST_PATH} is not valid JSON: ${e.message}`)
    process.exit(1)
  }
}

const problems = validateAllowlist(allowlist)
if (problems.length) {
  for (const p of problems) console.error(`✗ ${ALLOWLIST_PATH}: ${p}`)
  console.error('\n  Every entry needs id, package, reason and expires (YYYY-MM-DD).\n')
  process.exit(1)
}

const { gated, informational } = collectAdvisories(report)
const today = new Date().toISOString().slice(0, 10) // CI runs UTC; expiry is a date, not an instant
const { accepted, expired, unlisted, stale } = classifyAdvisories(gated, allowlist, today)

for (const adv of accepted) {
  console.log(`✓ ACCEPTED  ${adv.id}  ${adv.package}  (expires ${adv.entry.expires})`)
  console.log(`            ${adv.entry.reason}`)
}
for (const entry of stale) {
  console.log(`· stale entry (${entry.id} — ${entry.package} is no longer reported at high/critical). Safe to delete.`)
}
if (informational.length) {
  console.log(`· ${informational.length} advisory(ies) below the high threshold, not gated.`)
}

if (!unlisted.length && !expired.length) {
  const meta = report.metadata?.vulnerabilities || {}
  console.log(
    `\nDependency audit clean: 0 unaccepted high/critical advisories in runtime deps ` +
      `(${accepted.length} accepted, ${meta.moderate || 0} moderate / ${meta.low || 0} low ignored).`
  )
  process.exit(0)
}

for (const adv of unlisted) {
  console.error(`\n✗ NEW HIGH/CRITICAL ADVISORY: ${adv.id}`)
  console.error(`  package : ${adv.package}  (vulnerable ${adv.range})`)
  console.error(`  ${adv.title}`)
  console.error(`  ${adv.url}`)
}
for (const adv of expired) {
  console.error(`\n✗ EXPIRED ALLOWLIST ENTRY: ${adv.id} (expired ${adv.entry.expires})`)
  console.error(`  package : ${adv.package}`)
  console.error(`  accepted because: ${adv.entry.reason}`)
  console.error('  Re-decide it: fix the advisory, or renew the entry with a fresh expiry and reason.')
}

console.error(`
${unlisted.length + expired.length} advisory(ies) need a decision. Fix by either:
  1. Upgrading — \`npm audit fix\`, or bump the transitive in the lockfile
     (\`npm update <pkg> --package-lock-only\`) when the parent's declared
     range already admits a patched version. Add an npm \`overrides\` entry
     only when the parent genuinely PINS a vulnerable version.
  2. Removing the dependency, if the feature that pulled it in is dead.
     Verify it IS dead first — crons in vercel.json, cron_heartbeats rows
     and recent commits are better evidence than a stale doc note.
  3. Accepting it — add an entry to ${ALLOWLIST_PATH}:
       { "id": "GHSA-…", "package": "…",
         "reason": "why this is not exploitable HERE — name the code
                    path, not a generic 'low risk'",
         "expires": "YYYY-MM-DD" }
     Accepting is a dated decision, not a mute. Keep expiries short (a
     quarter at most) so the call actually gets revisited.
`)
process.exit(1)
