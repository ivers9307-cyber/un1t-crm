// @vitest-environment jsdom
// HATCHPIPE.2 (Task 12) — the un1t.online payments card on the contact page.
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import Un1tPaymentsCard from './Un1tPaymentsCard.jsx'

afterEach(cleanup)

const studio = (over = {}) => ({
  locationId: 'a0000000-0000-4000-8000-000000000002',
  locationName: 'UN1T Hatch Street',
  subscriptions: [],
  transactions: [],
  invoices: [],
  pastDue: null,
  ...over,
})
const tx = (n, over = {}) => ({ at: `2026-10-${String(n).padStart(2, '0')}T10:00:00Z`, productTitle: `Plan ${String.fromCharCode(64 + n)}`, type: 'sub_renewal', amountCents: 8900, currency: 'EUR', refunded: false, ...over })
const text = (studios) => render(<Un1tPaymentsCard studios={studios} />).container.textContent

describe('Un1tPaymentsCard', () => {
  it('renders nothing without studios', () => {
    expect(render(<Un1tPaymentsCard studios={[]} />).container.textContent).toBe('')
    cleanup()
    expect(render(<Un1tPaymentsCard />).container.textContent).toBe('')
  })

  it('shows amount and since in the overdue band', () => {
    const t = text([studio({ pastDue: { since: '2026-10-03T09:00:00Z', amountCents: 8900, currency: 'EUR' }, transactions: [tx(1)] })])
    expect(t).toContain('UN1T Hatch Street')
    expect(t).toContain('Payment overdue since 3 Oct 2026')
    expect(t).toContain('€89')
    expect(t).not.toContain('amount not reported')
  })

  it('shows "amount not reported by un1t.online" when amountCents is null', () => {
    const t = text([studio({ pastDue: { since: '2026-10-03T09:00:00Z', amountCents: null, currency: null }, transactions: [tx(1)] })])
    expect(t).toContain('Payment overdue since 3 Oct 2026')
    expect(t).toContain('amount not reported by un1t.online')
  })

  it('a past-due amount with no currency is not shown as euros', () => {
    const t = text([studio({ pastDue: { since: '2026-10-03T09:00:00Z', amountCents: 8900, currency: null } })])
    expect(t).toContain('amount not reported by un1t.online')
    expect(t).not.toContain('€')
  })

  it('no overdue band when nothing is overdue', () => {
    expect(text([studio({ transactions: [tx(1)] })])).not.toContain('Payment overdue')
  })

  it('Refunded chip on a refunded payment', () => {
    const { container } = render(<Un1tPaymentsCard studios={[studio({ transactions: [tx(1, { refunded: true }), tx(2)] })]} />)
    const chips = [...container.querySelectorAll('span')].filter((s) => s.textContent === 'Refunded')
    expect(chips).toHaveLength(1)
    expect(chips[0].className).toContain('bg-amber-500/10')
    expect(chips[0].className).toContain('text-amber-700')
  })

  it('invoice statuses: paid green, open red, void zinc, unknown zinc with the raw status', () => {
    const { container } = render(<Un1tPaymentsCard studios={[studio({
      transactions: [tx(1)],
      invoices: [
        { at: '2026-10-01T00:00:00Z', status: 'paid', rawStatus: 'paid', amountCents: 8900, currency: 'EUR' },
        { at: '2026-10-02T00:00:00Z', status: 'open', rawStatus: 'open', amountCents: 8900, currency: 'EUR' },
        { at: '2026-10-03T00:00:00Z', status: 'void', rawStatus: 'void', amountCents: 8900, currency: 'EUR' },
        { at: '2026-10-04T00:00:00Z', status: 'unknown', rawStatus: 'uncollectible', amountCents: 8900, currency: 'EUR' },
      ],
    })]} />)
    const chip = (label) => [...container.querySelectorAll('span')].find((s) => s.textContent === label)
    expect(chip('Paid').className).toContain('text-emerald-700')
    expect(chip('Open').className).toContain('text-red-700')
    expect(chip('Void').className).toContain('text-zinc-700')
    expect(chip('uncollectible').className).toContain('text-zinc-700')
  })

  it('lists at most 10 payments', () => {
    const many = Array.from({ length: 14 }, (_, i) => tx(i + 1))
    const { container } = render(<Un1tPaymentsCard studios={[studio({ transactions: many })]} />)
    expect(container.querySelectorAll('li')).toHaveLength(10)
    expect(container.textContent).toContain('Plan J')
    expect(container.textContent).not.toContain('Plan K')
  })

  it('"No payments recorded" for a paid member with no transactions', () => {
    expect(text([studio({ subscriptions: [{ productTitle: 'Monthly', status: 'active', priceCents: 8900, currency: 'EUR', interval: 'monthly' }] })])).toContain('No payments recorded')
  })

  it('lists current subscriptions', () => {
    const t = text([studio({ subscriptions: [{ productTitle: 'Founding Unlimited', status: 'active', priceCents: 8900, currency: 'EUR', interval: 'monthly' }], transactions: [tx(1)] })])
    expect(t).toContain('Founding Unlimited')
    expect(t).toContain('active')
  })

  it('one block per studio', () => {
    const t = text([studio({ transactions: [tx(1)] }), studio({ locationId: 'a0000000-0000-4000-8000-000000000003', locationName: 'Second Studio', transactions: [tx(2)] })])
    expect(t).toContain('UN1T Hatch Street')
    expect(t).toContain('Second Studio')
  })
})
