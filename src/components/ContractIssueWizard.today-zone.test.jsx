// @vitest-environment jsdom
//
// TZ follow-up — the issue wizard's preview renders {{today}} in the zone of
// the studio POST /api/contracts will issue at (the recipient's default
// studio in the template's org), the zone the stored body already uses
// (TZ.8b). Before, the preview always showed Dublin's day. Only Date is
// faked, so RTL's own timers stay real. Fictional ids and names.
process.env.TZ = 'America/Los_Angeles' // host zone is neither zone under test

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import ContractIssueWizard from './ContractIssueWizard'

const DUB = 'Europe/Dublin'
const NY = 'America/New_York'
const loc = (id, tz) => ({ id, organization_id: 'org-a', timezone: tz })
const staff = [
  // The staff API's managed shape: links embed `locations` with the timezone.
  { id: 'p-dub', full_name: 'Dee Dublin', email: 'd@example.test', employment_type: 'fte',
    profile_locations: [{ location_id: 'loc-dub', is_default: true, locations: loc('loc-dub', DUB) }] },
  // Default studio in New York; a Dublin studio of the same org is not the default.
  { id: 'p-ny', full_name: 'Nia NewYork', email: 'n@example.test', employment_type: 'fte',
    profile_locations: [
      { location_id: 'loc-dub', is_default: false, locations: loc('loc-dub', DUB) },
      { location_id: 'loc-ny', is_default: true, locations: loc('loc-ny', NY) },
    ] },
  // No embed: the zone comes from the server-built locationZones prop.
  { id: 'p-bare', full_name: 'Bo Bare', email: 'b@example.test', employment_type: 'fte',
    profile_locations: [{ location_id: 'loc-ny', is_default: true }] },
]
const templates = [
  { id: 't-a', name: 'Org A contract', version: 1, organization_id: 'org-a', employment_type: 'both', active: true, body_markdown: 'Dated {{today}}.', variables_schema: [] },
]
const locationOrgs = { 'loc-dub': 'org-a', 'loc-ny': 'org-a' }
const locationZones = { 'loc-dub': DUB, 'loc-ny': NY }

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const body = String(url).startsWith('/api/staff') ? { success: true, data: staff } : { success: true, data: templates }
    return { ok: true, status: 200, json: async () => body }
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

const who = (name) => (_c, el) => el?.tagName === 'SPAN' && el.textContent.startsWith(name)

async function previewFor(name, props = {}) {
  render(<ContractIssueWizard issuerName="Issuer" locationOrgs={locationOrgs} locationZones={locationZones} {...props} />)
  fireEvent.click(await screen.findByText(who(name)))
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 't-a' } })
  fireEvent.click(screen.getByRole('button', { name: /Next/ }))
  fireEvent.click(screen.getByRole('button', { name: /Next/ }))
  return (await screen.findByText(/^Dated \d{4}-\d{2}-\d{2}\.$/)).textContent
}

describe('ContractIssueWizard previews {{today}} on the issuing studio\'s calendar', () => {
  it('Europe/Dublin just after local midnight in summer is unchanged (fixed value)', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-07-15T23:30:00Z') }) // 00:30 IST on 16 Jul
    expect(await previewFor('Dee Dublin')).toBe('Dated 2026-07-16.')
  })

  it('a recipient issued at a New York studio sees New York\'s day', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-07-15T23:30:00Z') }) // 19:30 EDT on 15 Jul
    expect(await previewFor('Nia NewYork')).toBe('Dated 2026-07-15.')
  })

  it('New York across the 2026 fall-back: 00:30 EDT on 1 Nov is already 1 Nov', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-11-01T04:30:00Z') })
    expect(await previewFor('Nia NewYork')).toBe('Dated 2026-11-01.')
  })

  it('with no embedded timezone, the server-built locationZones decides', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-03-09T03:30:00Z') }) // 23:30 EDT on 8 Mar; 03:30 GMT on 9 Mar
    expect(await previewFor('Bo Bare')).toBe('Dated 2026-03-08.')
  })
})
