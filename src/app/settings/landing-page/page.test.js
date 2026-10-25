// C141 ORGROLE.2 — the front-page (chooser) editor is organisation-level:
// PUT /api/chooser-settings answers 403 to anyone but an organisation admin
// (assertChooserEdit), so the page offers the editor to the same people only.
// An owner at a studio keeps their studio's landing page.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => { throw new Error(`NEXT_REDIRECT:${url}`) }),
}))
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal()),
  getCurrentUser: vi.fn(),
}))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/components/LandingPageSettingsForm', () => ({ default: () => null }))
vi.mock('@/components/ChooserEditorForm', () => ({ default: () => null }))
vi.mock('@/components/landing-page/PageSwitcher', () => ({ default: () => null }))

import LandingPageSettingsPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const LOC = 'a1a1a1a1-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

function makeDb() {
  const tables = []
  const from = (table) => {
    tables.push(table)
    const chain = {
      select: () => chain, eq: () => chain, in: () => chain, not: () => chain, order: () => chain,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (res) => Promise.resolve({
        data: table === 'landing_page_settings' ? [{ location_id: LOC, public_path: 'x', locations: { name: 'X' } }] : [],
        error: null,
      }).then(res),
    }
    return chain
  }
  return { tables, from }
}

const owner = (orgAdminOrgIds) => ({
  id: 'u1', role: 'owner', isMaster: false,
  activeLocation: { id: LOC, organization_id: ORG }, activeOrganization: { id: ORG },
  locations: [{ id: LOC, organization_id: ORG }], rolesByLocation: { [LOC]: 'owner' },
  orgAdminOrgIds,
})

describe('/settings/landing-page — front-page editor is organisation-admin only (C141)', () => {
  let db
  beforeEach(() => {
    db = makeDb()
    createServerClient.mockReturnValue(db)
  })

  it('an owner without an org_admin grant gets the studio page, never the chooser', async () => {
    getCurrentUser.mockResolvedValue(owner([]))
    await LandingPageSettingsPage({ searchParams: Promise.resolve({ page: 'chooser' }) })
    expect(db.tables).not.toContain('chooser_settings')
  })

  it('an org admin of the active organisation gets the chooser editor', async () => {
    getCurrentUser.mockResolvedValue(owner([ORG]))
    await LandingPageSettingsPage({ searchParams: Promise.resolve({ page: 'chooser' }) })
    expect(db.tables).toContain('chooser_settings')
  })
})
