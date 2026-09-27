// tests/contract-hours-readers.test.js
// CONTRACTVIS.1 (Richard, 27 Sep) — a colleague's contracted hours go to a
// master, or to an owner / manager at a studio that colleague works at, and
// nobody else; a person may always see their own. Every non-test file under
// src/, shared/ and mobile/ that NAMES the column (or the `contracted_hours`
// key derived from it) is listed below with the reason its audience is allowed.
// A new reader fails here until someone decides — the same shape as
// tests/staff-tombstone-readers.test.js.
//
// A FLOOR, NOT A PROOF: a `select('*')` never names the column (that is why
// src/lib/staff.js projects every row it does not manage), and a value that
// travels under another name is invisible.

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

export function contractHoursReaders(root) {
  const hits = []
  for (const top of ROOTS) {
    for (const file of walk(join(root, top))) {
      if (readFileSync(file, 'utf8').includes('contracted_hours')) hits.push(relative(root, file).split(sep).join('/'))
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
  'src/app/api/schedule/grid/route.js': 'ADMIN_ROLES at the studio only (showContract), stripped again otherwise',
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
  'src/lib/roster-summary-server.js': 'server-only contractor spend aggregates',
  'src/lib/roster-summary.js': 'pure; measures only rows the caller was sent',
  'src/lib/roster-week-cost.js': 'server arithmetic behind week-cost',
  'src/lib/schemas.js': 'a comment on the column\'s range',
  'src/lib/staff-write.js': 'owner/master writes',
  'src/lib/staff.js': 'adds the column only for rows the caller manages, and their own (CONTRACTVIS.1)',
}

describe('every reader of contracted hours has been reviewed (CONTRACTVIS.1)', () => {
  it('no unreviewed file names the column', () => {
    const unreviewed = contractHoursReaders(repo).filter((f) => !REVIEWED[f])
    expect(
      unreviewed,
      'A file names contracted hours and is not in REVIEWED. Colleagues\' contracted hours go to ' +
      'master, or owner/manager at their studio, only (CONTRACTVIS.1). Check who receives it, then add the ' +
      'file with that reason.',
    ).toEqual([])
  })

  it('REVIEWED has no stale entries', () => {
    const found = new Set(contractHoursReaders(repo))
    expect(Object.keys(REVIEWED).filter((f) => !found.has(f))).toEqual([])
  })
})
