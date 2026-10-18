// @vitest-environment jsdom
//
// HATCHINV.1 — the inbox command centre's Arrears tile must agree with its
// Churn chip. From the day un1t.online invoices go live a Hatch member can be
// "Payment overdue" (red chip) while the tile still read €0, because the tile
// only knew the Glofox figure. It now shows Glofox arrears plus the bundle's
// EUR-only `un1t_billing.arrears_cents`, and says "amount not reported" rather
// than €0 when un1t.online has flagged an overdue it gave no amount for.
//
// The Stillorgan case (no un1t_billing, or an empty one) must stay byte-for-byte
// what it was.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('next/link', () => ({ default: ({ children, ...p }) => <a {...p}>{children}</a> }))
vi.mock('@/components/ContactMarketingPreferencesCard', () => ({ default: () => null }))
vi.mock('@/components/SequencePicker', () => ({ default: () => null }))
vi.mock('@/components/BookPanel', () => ({ default: () => null }))

import CommandCentre from './CommandCentre'

const bundle = ({ signals = {}, un1t_billing } = {}) => ({
  success: true,
  contact: { id: 'c1', name: 'Emma Byrne', location_id: 'loc1', tags: [] },
  activities: [],
  event_types: [],
  latestNote: null,
  signals: {
    churnClass: 'active', churnLabel: null, churnTier: null,
    arrearsCents: 0, arrearsCount: 0, visits30: 0, lastAttendedAt: null,
    ...signals,
  },
  ...(un1t_billing === undefined ? {} : { un1t_billing }),
})

function mockFetch(b) {
  global.fetch = vi.fn(async (url) => {
    const u = String(url)
    if (u.endsWith('/command-centre')) return { ok: true, json: async () => b }
    return { ok: true, json: async () => ({ success: true, rows: [] }) }
  })
}

async function arrearsTile(b) {
  mockFetch(b)
  render(<CommandCentre contactId="c1" locationId="loc1" />)
  const label = await screen.findByText('Arrears')
  return label.nextElementSibling
}

beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)

describe('CommandCentre Arrears tile', () => {
  it('Stillorgan, no un1t_billing in the bundle: Glofox figure exactly as before', async () => {
    const tile = await arrearsTile(bundle({ signals: { arrearsCents: 5000, arrearsCount: 1 } }))
    expect(tile.textContent).toBe('€50')
    expect(tile.className).toContain('text-amber-700')
  })

  it('Stillorgan, no arrears and no un1t_billing: €0, not amber', async () => {
    const tile = await arrearsTile(bundle())
    expect(tile.textContent).toBe('€0')
    expect(tile.className).toContain('text-un1t-text')
    expect(tile.className).not.toContain('amber')
  })

  it('an empty un1t_billing changes nothing', async () => {
    const empty = { overdue: false, arrears_cents: 0, studios: [] }
    expect((await arrearsTile(bundle({ signals: { arrearsCents: 5000, arrearsCount: 1 }, un1t_billing: empty }))).textContent).toBe('€50')
    cleanup()
    expect((await arrearsTile(bundle({ un1t_billing: empty }))).textContent).toBe('€0')
  })

  it('un1t.online EUR arrears alone: shown, not €0', async () => {
    const tile = await arrearsTile(bundle({
      signals: { churnClass: 'overdue', churnLabel: 'Payment overdue' },
      un1t_billing: { overdue: true, arrears_cents: 8900, studios: [{ location_id: 'loc2', since: '2026-10-03' }] },
    }))
    expect(tile.textContent).toBe('€89')
    expect(tile.className).toContain('text-amber-700')
  })

  it('Glofox plus un1t.online arrears are added', async () => {
    const tile = await arrearsTile(bundle({
      signals: { arrearsCents: 5000, arrearsCount: 1 },
      un1t_billing: { overdue: true, arrears_cents: 8900, studios: [{ location_id: 'loc2', since: '2026-10-03' }] },
    }))
    expect(tile.textContent).toBe('€139')
  })

  it('overdue with no reported amount: "amount not reported", never €0', async () => {
    const tile = await arrearsTile(bundle({
      signals: { churnClass: 'overdue', churnLabel: 'Payment overdue' },
      un1t_billing: { overdue: true, arrears_cents: 0, amount_unreported: true, studios: [{ location_id: 'loc2', since: '2026-10-03' }] },
    }))
    expect(tile.textContent).toBe('amount not reported')
    expect(tile.textContent).not.toContain('€')
    expect(tile.className).toContain('text-amber-700')
  })

  it('not overdue with no arrears stays €0', async () => {
    const tile = await arrearsTile(bundle({ un1t_billing: { overdue: false, arrears_cents: 0, studios: [] } }))
    expect(tile.textContent).toBe('€0')
  })

  it('Glofox arrears plus an un1t overdue with no amount: "€50 + amount not reported"', async () => {
    const tile = await arrearsTile(bundle({
      signals: { arrearsCents: 5000, arrearsCount: 1 },
      un1t_billing: { overdue: true, arrears_cents: 0, amount_unreported: true, amount_not_eur: false, studios: [{ location_id: 'loc2', since: '2026-10-03' }] },
    }))
    expect(tile.textContent).toBe('€50 + amount not reported')
  })

  it('a partial un1t sum (one row has an amount, one does not): "€89 + amount not reported"', async () => {
    const tile = await arrearsTile(bundle({
      un1t_billing: { overdue: true, arrears_cents: 8900, amount_unreported: true, amount_not_eur: false, studios: [{ location_id: 'loc2', since: '2026-10-03' }] },
    }))
    expect(tile.textContent).toBe('€89 + amount not reported')
  })

  it('a known but non-EUR amount says "amount not in EUR", alone or beside a sum', async () => {
    const un1t = (cents) => ({ overdue: true, arrears_cents: cents, amount_unreported: true, amount_not_eur: true, studios: [{ location_id: 'loc2', since: '2026-10-03' }] })
    expect((await arrearsTile(bundle({ un1t_billing: un1t(0) }))).textContent).toBe('amount not in EUR')
    cleanup()
    expect((await arrearsTile(bundle({ un1t_billing: un1t(8900) }))).textContent).toBe('€89 + amount not in EUR')
  })

  it('a fully reported EUR overdue has no suffix', async () => {
    const tile = await arrearsTile(bundle({
      un1t_billing: { overdue: true, arrears_cents: 8900, amount_unreported: false, amount_not_eur: false, studios: [{ location_id: 'loc2', since: '2026-10-03' }] },
    }))
    expect(tile.textContent).toBe('€89')
  })
})
