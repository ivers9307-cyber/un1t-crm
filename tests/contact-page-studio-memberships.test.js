// CARDLENS.8 — the contact page builds one membership view per studio and
// hands it to the strip and the left rail. Source scan of the server page (a
// floor, not a proof); the shapes are pinned in
// src/lib/contact-studio-memberships.test.js and the components' own tests.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { stripComments } from './helpers/js-code.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const src = stripComments(readFileSync(path.join(ROOT, 'src/app/(sales)/contacts/[id]/page.js'), 'utf8')).replace(/\s+/g, ' ')

describe('CARDLENS.8 — per-studio memberships on the contact page', () => {
  it('reads the un1t.online counters only at studios where the viewer holds Contacts', () => {
    expect(src).toMatch(/from\('un1t_clients'\)\s?\.select\('location_id, last_attended_at, bookings_30d_attended, credit_balance, credit_unlimited, ltv_cents, synced_at'\)/)
    expect(src).toContain('const un1tVisible = new Set(contactStudioIds(user,')
    expect(src).toMatch(/un1tClients = \(clientRows \|\| \[\]\)\.filter\(\(r\) => un1tVisible\.has\(r\.location_id\)\)/)
  })

  it('builds the memberships from the studio rows, the un1t rows and the Glofox arrears', () => {
    expect(src).toContain('studioMemberships({ contact, studioRows: contactStudios.rows, un1tClients, un1tBilling, glofoxArrearsCents })')
  })

  it('All studios is ?studio=all, only for a person with two or more studios', () => {
    expect(src).toContain("const lensAll = memberships.length >= 2 && searchParams?.studio === 'all'")
  })

  it('the strip replaces the studio bar', () => {
    expect(src).toMatch(/<StudioStrip memberships=\{memberships\} options=\{actingOptions\} actingId=\{actingId\} lensAll=\{lensAll\} \/>/)
    expect(src).not.toContain('ActingStudioBar')
  })

  it('the left rail gets the memberships and the lens', () => {
    expect(src).toMatch(/<ContactWhoRail[^>]*memberships=\{memberships\}[^>]*actingId=\{actingId\}[^>]*lensAll=\{lensAll\}/)
  })
})

describe('CARDLENS.9 — the header follows the lens', () => {
  it('splits the Glofox chips and lets lensRisk pick', () => {
    expect(src).toContain('const glofoxOverdue = churnClass === \'overdue\'')
    expect(src).toContain('const risk = lensRisk({ lensId, memberships, glofoxOverdue, glofoxChurn, un1tBilling, names: studioNames })')
    expect(src).not.toMatch(/let risk = null/)
  })

  it('the stats come from lensMetrics over today\'s figures', () => {
    expect(src).toContain("const lensId = lensAll ? 'all' : actingId")
    expect(src).toMatch(/const headerMetrics = lensMetrics\(\{ memberships, lensId, base: \{/)
    expect(src).toMatch(/<ContactHeaderBand[^>]*metrics=\{\{ \.\.\.headerMetrics, currency: contact\.lifetime_currency \}\}/)
  })
})
