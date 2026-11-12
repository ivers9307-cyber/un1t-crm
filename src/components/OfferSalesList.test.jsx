// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/lib/use-viewer-zone', () => ({ useViewerZone: () => null }))

import OfferSalesList from './OfferSalesList'

const base = {
  id: 'p1', buyer_name: 'Jane Doe', buyer_email: 'j@x.com', amount_cents: 49700,
  paid_at: '2026-11-27T10:00:00Z', fulfilled_at: null,
  offer: { name: '3 Month Membership', bonus_headline: '+2 WEEKS FREE' },
}

describe('OfferSalesList', () => {
  afterEach(cleanup)
  it('un1t_online off-page row shows both chips and the un1t line', () => {
    render(<OfferSalesList pending={[{ ...base, payment_provider: 'un1t_online', origin: 'off_page' }]} fulfilled={[]} timezone="Europe/Dublin" />)
    expect(screen.getByText('un1t.online')).toBeTruthy()
    expect(screen.getByText('Bought in app/desk')).toBeTruthy()
    expect(screen.getByText('Paid in un1t.online. Add the bonus there.')).toBeTruthy()
  })
  it('revolut page row shows no un1t chips', () => {
    render(<OfferSalesList pending={[{ ...base, payment_provider: 'revolut', origin: 'page' }]} fulfilled={[]} timezone="Europe/Dublin" />)
    expect(screen.queryByText('un1t.online')).toBeNull()
    expect(screen.queryByText('Bought in app/desk')).toBeNull()
  })
})
