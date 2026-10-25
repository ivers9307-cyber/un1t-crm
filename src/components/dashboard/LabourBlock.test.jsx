// LABOUR.1 — the async server block: a failed load is the standard error
// cell, never a panel of zeros.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }) => <a href={typeof href === 'string' ? href : '#'} {...rest}>{children}</a>,
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'service-role' })) }))
vi.mock('@/lib/labour-month-data', () => ({ loadLabourMonth: vi.fn() }))

import { loadLabourMonth } from '@/lib/labour-month-data'
import { LabourBlock } from './LabourBlock'

const STUDIOS = [{ id: 'loc-still', name: 'UN1T Stillorgan' }]
const VM = {
  month: '2026-09', month_label: 'September 2026', day_of_month: 16, days_in_month: 30,
  studios: [], total: null, uncosted: [], untimed_shifts: 0,
}

beforeEach(() => { vi.mocked(loadLabourMonth).mockReset() })

describe('LabourBlock', () => {
  it('passes the service-role client, the active studio and the studios to the loader', async () => {
    vi.mocked(loadLabourMonth).mockResolvedValue({ data: VM })
    await LabourBlock({ activeLocationId: 'loc-still', studios: STUDIOS, nowMs: 123 })
    expect(loadLabourMonth).toHaveBeenCalledWith({ tag: 'service-role' }, { activeLocationId: 'loc-still', studios: STUDIOS, nowMs: 123 })
  })

  it('renders the panel on success', async () => {
    vi.mocked(loadLabourMonth).mockResolvedValue({ data: VM })
    const out = renderToStaticMarkup(await LabourBlock({ activeLocationId: 'loc-still', studios: STUDIOS }))
    expect(out).toContain('Labour against revenue · September 2026')
  })

  it('an error result is the error cell, with no figures', async () => {
    vi.mocked(loadLabourMonth).mockResolvedValue({ error: 'Could not read pay' })
    const out = renderToStaticMarkup(await LabourBlock({ activeLocationId: 'loc-still', studios: STUDIOS }))
    expect(out).toContain('Labour against revenue couldn')
    expect(out).not.toContain('€')
  })

  it('a thrown loader is the error cell too', async () => {
    vi.mocked(loadLabourMonth).mockRejectedValue(new Error('boom'))
    const out = renderToStaticMarkup(await LabourBlock({ activeLocationId: 'loc-still', studios: STUDIOS }))
    expect(out).toContain('Labour against revenue couldn')
  })
})
