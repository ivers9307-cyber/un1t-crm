// CARDLENS.8 — one membership card per studio, by platform: the Glofox studio
// gets the full Glofox card, a un1t.online studio its own facts plus what
// un1t.online says is owed and paid, a CRM-only studio a short line.
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('./GlofoxProfileCard', () => ({ default: ({ mode }) => <i data-card="glofox" data-mode={mode ?? ''} /> }))
const { default: StudioMembershipCard } = await import('./StudioMembershipCard.jsx')

const H = 'b0000000-0000-4000-8000-00000000000b'
const base = { locationId: H, name: 'UN1T Hatch Street', primary: false, kind: 'client', status: 'active', plan: '10-class pack', creditsLine: '4 credits', attended30d: 3, lastAttendedAt: null, ltvCents: 15000, owedCents: 4500, overdue: true, amountUnreported: false, syncedAt: null }

describe('StudioMembershipCard', () => {
  it('a Glofox studio renders the Glofox card in its mode', () => {
    const html = renderToStaticMarkup(<StudioMembershipCard membership={{ ...base, platform: 'glofox' }} contact={{ id: 'c' }} glofoxMode="linked" />)
    expect(html).toContain('data-card="glofox"')
    expect(html).toContain('data-mode="linked"')
  })

  it('a un1t.online studio shows its own facts and its payments block', () => {
    const billing = { locationId: H, locationName: 'UN1T Hatch Street', subscriptions: [], transactions: [{ productTitle: '10-class pack', at: '2026-10-01T10:00:00Z', amountCents: 9000, currency: 'EUR' }], invoices: [], pastDues: [] }
    const html = renderToStaticMarkup(<StudioMembershipCard membership={{ ...base, platform: 'un1t_online' }} un1tStudio={billing} />)
    expect(html).toContain('Membership · UN1T Hatch Street')
    expect(html).toContain('un1t.online')
    expect(html).toContain('10-class pack')
    expect(html).toContain('4 credits')
    expect(html).toContain('€150')
    expect(html).toContain('€90')
    expect(html).not.toContain('data-card="glofox"')
  })

  it('a CRM-only studio says so in one line', () => {
    const html = renderToStaticMarkup(<StudioMembershipCard membership={{ ...base, platform: 'none', kind: 'lead', plan: null }} />)
    expect(html).toContain('UN1T Hatch Street')
    expect(html).toContain('Lead')
    expect(html).toContain('No membership system at this studio')
  })
})
