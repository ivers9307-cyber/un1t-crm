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
const { loadRevolutSdk } = await import('@/lib/revolut-embed')

const BASE = { id: 'gp1', status: 'pending', amount_cents: 1000, booking_fee_cents: 0, currency: 'EUR', provider: 'revolut',
  checkout: { token: 'tok', url: null, connected_account_id: null },
  race: { id: 'e2', name: 'Hatch Oct 25', slug: 'hatch-oct25-1100' },
  registration: { id: 'r1', status: 'confirmed', team_name: 'The Crushers', team_size: 2 } }
const serve = (data) => vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ success: true, data }) })))

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })

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

describe('RaceCheckoutPage — a difference link that cannot be paid', () => {
  it('an expired link says so and mounts no payment widget', async () => {
    serve({ ...BASE, kind: 'move_gap', status: 'abandoned', expired: true, settled: false })
    render(<RaceCheckoutPage paymentId="gp1" />)
    await screen.findByText('This payment link has expired. Ask the event team for a new one.')
    expect(loadRevolutSdk).not.toHaveBeenCalled()
    expect(screen.queryByText(/Secure payment by/)).toBeNull()
  })
  it('a difference settled by hand says there is nothing to pay and mounts nothing, even while the row is pending', async () => {
    serve({ ...BASE, kind: 'move_gap', status: 'pending', expired: false, settled: true, settled_how: 'waived' })
    render(<RaceCheckoutPage paymentId="gp1" />)
    await screen.findByText('This difference is already settled, nothing to pay.')
    expect(loadRevolutSdk).not.toHaveBeenCalled()
  })
  it('a live difference link mounts the widget', async () => {
    serve({ ...BASE, kind: 'move_gap', status: 'pending', expired: false, settled: false })
    render(<RaceCheckoutPage paymentId="gp1" />)
    await screen.findByText('Price difference')
    await vi.waitFor(() => expect(loadRevolutSdk).toHaveBeenCalled())
  })
})

