// @vitest-environment jsdom
// EVENT-MOVE.5 — the checkout labels a move_gap payment "Price difference"
// and shows no roster; an entry payment keeps its team lines.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))
vi.mock('@stripe/stripe-js', () => ({ loadStripe: vi.fn(() => new Promise(() => {})) }))
vi.mock('@/lib/revolut-embed', () => ({
  loadRevolutSdk: vi.fn(() => new Promise(() => {})),
  revolutMode: () => 'sandbox',
  revolutPublicKey: () => 'pk_test',
}))

const { default: RaceCheckoutPage } = await import('./RaceCheckoutPage.jsx')

const BASE = { id: 'gp1', status: 'pending', amount_cents: 1000, booking_fee_cents: 0, currency: 'EUR', provider: 'revolut',
  checkout: { token: 'tok', url: null, connected_account_id: null },
  race: { id: 'e2', name: 'Hatch Oct 25', slug: 'hatch-oct25-1100' },
  registration: { id: 'r1', status: 'confirmed', team_name: 'The Crushers', team_size: 2 } }
const serve = (data) => vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ success: true, data }) })))

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('RaceCheckoutPage — price difference', () => {
  it('a move_gap payment says "Price difference" and lists no team or headcount', async () => {
    serve({ ...BASE, kind: 'move_gap' })
    render(<RaceCheckoutPage paymentId="gp1" />)
    await screen.findByText('Hatch Oct 25')
    expect(screen.getByText('Price difference')).toBeTruthy()
    expect(screen.queryByText(/The Crushers/)).toBeNull()
    expect(screen.queryByText(/2 people/)).toBeNull()
    expect(screen.getByText('€10.00')).toBeTruthy()
  })
  it('an entry payment keeps its team and headcount, and no "Price difference"', async () => {
    serve({ ...BASE, kind: 'entry', amount_cents: 6400 })
    render(<RaceCheckoutPage paymentId="p1" />)
    await screen.findByText('Hatch Oct 25')
    expect(screen.getByText('The Crushers')).toBeTruthy()
    expect(screen.getByText('2 people')).toBeTruthy()
    expect(screen.queryByText('Price difference')).toBeNull()
  })
})
