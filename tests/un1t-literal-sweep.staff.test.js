// W1.S2 — the UN1T literal sweep guard for STAFF-facing web chrome and
// staff emails (SaaS Wave 1, Track S).
//
// Same shape and helper as the shared ledger tests/un1t-literal-sweep.test.js
// (created by W1.S4, PR #1999). It lives in its own file only so the two PRs
// do not conflict on one list; fold SWEPT/KEEP below into the shared ledger
// once S4 is on main.
//
// What counts: a `UN1T` outside comments. Rows the plan's appendix marks
// `keep` (UN1T-specific by design) are allow-listed per file in KEEP, as the
// exact literal, so a NEW literal in a kept file still fails.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from './helpers/js-code.js'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')

// Files swept by W1.S2 (staff chrome, staff settings copy, staff emails).
const SWEPT = [
  'src/app/account/contracts/page.js',
  'src/app/account/page.js',
  'src/app/api/account/pending-contracts/route.js',
  'src/app/api/email/conversations/_gone.js',
  'src/app/login/page.js',
  'src/app/reset-password/page.js',
  'src/app/settings/hosts/page.jsx',
  'src/app/settings/scoring/ScoringClient.jsx',
  'src/components/AchievementsAdminTable.jsx',
  'src/components/AddOrganizationButton.jsx',
  'src/components/AppShell.jsx',
  'src/components/BrandingSettings.jsx',
  'src/components/CampaignDetail.jsx',
  'src/components/CampaignEditor.jsx',
  'src/components/ChallengeForm.jsx',
  'src/components/ContractSignForm.jsx',
  'src/components/ContractTemplateForm.jsx',
  'src/components/LocationForm.jsx',
  'src/components/OrgBrandingSettings.jsx',
  'src/components/PendingContractsAlert.jsx',
  'src/components/RaceControlPanel.jsx',
  'src/components/RaceEventForm.jsx',
  'src/components/Sidebar.jsx',
  'src/components/WidgetTokensCard.jsx',
  'src/components/accounting/EventFeesCard.jsx',
  'src/components/settings/HostDetail.jsx',
  'src/components/settings/HostsManager.jsx',
  'src/components/settings/StatusPageSettingsForm.jsx',
  'src/components/settings/integrations/PaymentsIntegrationTab.jsx',
  'src/components/use-location-brand.js',
  'src/lib/contractor-invoice-email.js',
  'src/lib/glofox-notes.js',
  'src/lib/openapi.js',
  'src/lib/roster-email.js',
  'src/lib/settings-tree.js',
  'src/lib/wallet-topup.js',
  'src/lib/xero/bills-email.js',
  'src/lib/xero/contractor-bills.js',
  'src/lib/xero/fte-expense-claims.js',
  'src/lib/zoom/external-contacts.js',
]

// file → exact literals another OPEN sweep PR removes (tolerated here so the
// two PRs never touch the same hunk; unlike KEEP they are not required to
// still exist, so the entry goes dead, not red, when that PR merges). Delete
// the map once W1.E2 (#1998, `platformFromHeader`) is on main.
const PENDING = {
  'src/lib/contractor-invoice-email.js': ["'UN1T <hello@un1t.ie>'"],
  'src/lib/xero/bills-email.js': ["'UN1T <hello@un1t.ie>'"],
  'src/lib/xero/contractor-bills.js': ["'UN1T <hello@un1t.ie>'"],
  'src/lib/xero/fte-expense-claims.js': ["'UN1T <hello@un1t.ie>'"],
}

// file → exact literals the appendix marks `keep`.
const KEEP = {
  // wallet-topup.js:62 — the platform IS the seller of a wallet top-up, so
  // the VAT invoice names the platform's own trading entity (Wave 2 moves
  // money rails to the org).
  'src/lib/wallet-topup.js': ['(trading as UN1T Dublin)'],
}

describe('UN1T literal sweep (W1.S2 — staff chrome and staff emails)', () => {
  it.each(SWEPT)('%s carries no staff-visible UN1T literal', (file) => {
    const src = stripComments(readFileSync(join(repo, file), 'utf8'), file)
    const allowed = [...(KEEP[file] || []), ...(PENDING[file] || [])]
    const stripped = allowed.reduce((s, lit) => s.split(lit).join(''), src)
    const hits = stripped
      .split('\n')
      .map((line, i) => (/UN1T/.test(line) ? `${file}:${i + 1}: ${line.trim()}` : null))
      .filter(Boolean)
    expect(hits, `reintroduced UN1T literal(s):\n${hits.join('\n')}`).toEqual([])
  })

  it('every KEEP entry names a swept file and a literal that still exists', () => {
    for (const file of Object.keys(PENDING)) expect(SWEPT, `${file} is in PENDING but not SWEPT`).toContain(file)
    for (const [file, lits] of Object.entries(KEEP)) {
      expect(SWEPT, `${file} is in KEEP but not SWEPT`).toContain(file)
      const src = readFileSync(join(repo, file), 'utf8')
      for (const lit of lits) expect(src, `${file} no longer contains kept literal ${lit}`).toContain(lit)
    }
  })
})
