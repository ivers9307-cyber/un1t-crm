// tests/contract-hours-readers.test.js
// CONTRACTVIS.1 (Richard, 27 Sep) — a colleague's contracted hours go to a
// master, or to an owner / manager at a studio that colleague works at, and
// nobody else; a person may always see their own. Every non-test file under
// src/, shared/ and mobile/ that NAMES the column (or the `contracted_hours`
// key derived from it) is listed below with the reason its audience is allowed.
// A new reader fails here until someone decides — the same shape as
// tests/staff-tombstone-readers.test.js.
//
// Two nets, one list:
//   1. NAMES — a file that spells `contracted_hours` or STAFF_CONTRACT_FIELD
//      (the constant src/lib/staff.js reads the column through).
//   2. IMPORTS — a file under src/ that imports a PRODUCER of contract-bearing
//      rows (PRODUCERS below). A consumer can hand the rows on without ever
//      naming the column, so importing one is itself a decision to review.
//
// A FLOOR, NOT A PROOF: a `select('*')` never names the column (that is why
// src/lib/staff.js projects every row it does not manage), a value that
// travels under another name is invisible, and net 2 is one hop deep (a
// consumer of a consumer is not followed).

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROOTS = ['src', 'shared', 'mobile']
const SKIP_DIRS = new Set(['node_modules', '.expo', 'ios', 'android', 'dist', 'build', 'coverage'])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(js|jsx|mjs|ts|tsx)$/.test(name) && !/\.test\.|test-helpers/.test(name)) out.push(p)
  }
  return out
}

const rel = (root, file) => relative(root, file).split(sep).join('/')

// Net 1. STAFF_CONTRACT_FIELD is how src/lib/staff.js names the column; a
// file importing the constant reads contracts without spelling them.
const NAMES_CONTRACT = /contracted_hours|STAFF_CONTRACT_FIELD/

export function contractHoursReaders(root) {
  const hits = []
  for (const top of ROOTS) {
    for (const file of walk(join(root, top))) {
      if (NAMES_CONTRACT.test(readFileSync(file, 'utf8'))) hits.push(rel(root, file))
    }
  }
  return hits.sort()
}

// Net 2. Modules whose exports hand back rows that carry a colleague's
// contract (or a figure measured against one). Each is itself in REVIEWED.
export const PRODUCERS = {
  'src/lib/roster-week-cost.js': 'computeWeeklyFteHours — per-coach contract, overtime and status',
  'src/lib/candidates-data.js': 'loadBlockCandidates({ withContract }) / readContractedHours',
  'src/lib/roster-grid-data.js': 'loadRosterGrid({ showContract })',
  'src/lib/report-generator.js': 'generateReport — staff_cost and utilisation rows carry contracts',
  'src/lib/staff.js': 'listStaffForUser / getStaffForUser — the full shape for managed rows',
  'src/lib/shift-holder-pay.js': 'loadHolderPay — per-holder rate, salary and contracted hours (CONTRACTORSPEND.1)',
  'src/lib/roster-summary-server.js': 'computeMonthlyContractorSpend — fteImplicitCostEur is rostered hours × salary / 52 / contracted hours (FTECOSTVIS.1)',
}

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g

// Resolve an import specifier to a repo-relative path without an extension,
// or null for a package import. Only the aliases the repo uses: '@/' (src/)
// and '@shared/' (shared/).
function resolveSpecifier(root, fromFile, spec) {
  let abs
  if (spec.startsWith('@/')) abs = join(root, 'src', spec.slice(2))
  else if (spec.startsWith('@shared/')) abs = join(root, 'shared', spec.slice(8))
  else if (spec.startsWith('.')) abs = join(dirname(fromFile), spec)
  else return null
  return rel(root, abs).replace(/\.(js|jsx|mjs)$/, '').replace(/\/index$/, '')
}

const PRODUCER_STEMS = new Map(Object.keys(PRODUCERS).map((f) => [f.replace(/\.(js|jsx|mjs)$/, ''), f]))

export function producerConsumers(root) {
  const hits = []
  for (const file of walk(join(root, 'src'))) {
    const self = rel(root, file)
    if (PRODUCERS[self]) continue
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(SPECIFIER)) {
      const target = resolveSpecifier(root, file, m[1])
      if (target && PRODUCER_STEMS.has(target)) { hits.push(self); break }
    }
  }
  return hits.sort()
}

const REVIEWED = {
  'shared/candidates.js': 'pure ranking and labels; the key exists only when the candidates route sent it (withContract: ADMIN_ROLES at the block\'s studio)',
  'shared/dashboard-data.js': 'server-only aggregates: a euro labour total and names of incomplete pay profiles; never returns the column',
  'src/app/api/assistant/chat/route.js': 'staff_cost tool, RATE_REPORT_VIEWER_ROLES at the active studio only (the assistant is off everywhere)',
  'src/app/api/contracts/[id]/route.js': 'the contract\'s recipient (own), master, or an owner of its organisation',
  'src/app/api/contracts/route.js': 'issuing a contract: master or owner only',
  'src/app/api/cron/run-scheduled-reports/route.js': 'emails staff_cost / utilisation only to recipients filterRateReportRecipients allows',
  'src/app/api/schedule/blocks/[id]/candidates/route.js': 'withContract only for the manager audience AND ADMIN_ROLES at the block\'s studio (CANDIDATES.1)',
  'src/app/api/schedule/contractor-spend/route.js': 'the FTE labour total only for ADMIN_ROLES at location_id; everyone else gets contractorSpendOnly, an allowlist of contractor figures (FTECOSTVIS.1)',
  'src/app/api/schedule/grid/route.js': 'ADMIN_ROLES at the studio only (showContract), stripped again otherwise',
  'src/app/api/schedule/offers/[id]/claim/route.js': 'loadBlockCandidates without withContract (defaults false): no contract read',
  'src/app/api/schedule/offers/route.js': 'loadBlockCandidates without withContract (defaults false): no contract read',
  'src/app/api/schedule/reports/route.js': 'generate and list refuse staff_cost / utilisation below RATE_REPORT_VIEWER_ROLES at the studio',
  'src/app/api/schedule/reports/scheduled/route.js': 'imports calculateNextRun only; scheduling a staff_cost / utilisation report is RATE_REPORT_VIEWER_ROLES',
  'src/app/api/schedule/week-cost/route.js': 'ADMIN_ROLES at the studio only; contract_visible false otherwise (CONTRACTVIS.1)',
  'src/app/api/staff/[id]/route.js': 'write schema (PUT is owner/master); reads go through src/lib/staff.js',
  'src/app/api/staff/route.js': 'write schema (POST is owner/master); reads go through src/lib/staff.js',
  'src/app/settings/staff/page.js': 'comment only; the page names its columns and reads no contract',
  'src/components/ContractTemplateForm.jsx': 'a template variable name and a sample value; no person\'s data',
  'src/components/RosterSummaryPanel.jsx': 'renders a contract only with contractVisible, from rows the server sent (include=contract, managed rows)',
  'src/components/ScheduleCalendar.jsx': 'renders week-cost rows, fetched only with canSeeContract (owner/manager/master at the studio)',
  'src/components/ScheduleReporting.jsx': 'renders the utilisation report, admin-only (RATE_REPORT_TYPES)',
  'src/components/StaffForm.jsx': 'the staff editor: owner at the person\'s studio, or master',
  'src/lib/assistant-prompt.js': 'prompt text only',
  'src/lib/candidates-data.js': 'reads contracts only when withContract (ADMIN_ROLES at the block\'s studio)',
  'src/lib/contracts.js': 'contract template variables, issued by owner/master',
  'src/lib/openapi.js': 'API documentation',
  'src/lib/payroll.js': 'server-side arithmetic',
  'src/lib/profile-compensation.js': 'server reader of the canonical pay table',
  'src/lib/report-generator.js': 'writes staff_cost and utilisation, both admin-only report types',
  'src/lib/roster-grid-data.js': 'reads the column only when showContract',
  'src/lib/roster-grid-model.js': 'pure; the key exists only when the grid route sent it',
  'src/lib/roster-publish.js': 'publish gate: loadHolderPay on the server for the budget check; returns euro totals and advisories, never a person\'s contract',
  'src/lib/roster-summary-server.js': 'server-only contractor spend aggregates via loadHolderPay; the response is pinned to an exact key list with no per-person pay, and its one salary-derived key (fteImplicitCostEur) is classified so the route withholds it below ADMIN_ROLES (FTECOSTVIS.1)',
  'src/lib/roster-summary.js': 'pure; measures only rows the caller was sent',
  'src/lib/roster-week-cost.js': 'server arithmetic behind week-cost',
  'src/lib/schemas.js': 'a comment on the column\'s range',
  'src/lib/shift-holder-pay.js': 'server-only pay loader for contractor spend and the publish gate; both callers return aggregates only',
  'src/lib/shift-offer-server.js': 'loadBlockCandidates without withContract (defaults false): no contract read',
  'src/lib/staff-write.js': 'owner/master writes',
  'src/lib/staff.js': 'adds the column only for rows the caller manages, and their own (CONTRACTVIS.1)',
}

describe('every reader of contracted hours has been reviewed (CONTRACTVIS.1)', () => {
  // One walk per net for the whole file; the tests below only compare.
  const namers = contractHoursReaders(repo)
  const consumers = producerConsumers(repo)

  it('no unreviewed file names the column (or STAFF_CONTRACT_FIELD)', () => {
    const unreviewed = namers.filter((f) => !REVIEWED[f])
    expect(
      unreviewed,
      'A file names contracted hours and is not in REVIEWED. Colleagues\' contracted hours go to ' +
      'master, or owner/manager at their studio, only (CONTRACTVIS.1). Check who receives it, then add the ' +
      'file with that reason.',
    ).toEqual([])
  })

  it('no unreviewed file imports a producer of contract-bearing rows', () => {
    const unreviewed = consumers.filter((f) => !REVIEWED[f])
    expect(
      unreviewed,
      'A file imports a module in PRODUCERS (it can hand on a colleague\'s contract without naming it) and ' +
      'is not in REVIEWED. Check who receives what it returns (CONTRACTVIS.1), then add the file with that reason.',
    ).toEqual([])
  })

  it('every producer is itself reviewed', () => {
    expect(Object.keys(PRODUCERS).filter((f) => !REVIEWED[f])).toEqual([])
  })

  it('REVIEWED has no stale entries', () => {
    const found = new Set([...namers, ...consumers])
    expect(Object.keys(REVIEWED).filter((f) => !found.has(f))).toEqual([])
  })
})
