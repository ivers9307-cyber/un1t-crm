// @vitest-environment jsdom
//
// W1.S2 — useLocationBrand(): the brand for a staff client component.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { useLocationBrand, loadLocationBrand, resetLocationBrandCache, EMPTY_BRAND } from './use-location-brand'

function Probe({ locationId }) {
  const b = useLocationBrand(locationId)
  return <div data-testid="out">{JSON.stringify({ ...b })}</div>
}
const read = () => JSON.parse(screen.getByTestId('out').textContent)

beforeEach(() => {
  resetLocationBrandCache()
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (String(url).includes('location_id=loc-1')) {
      return { ok: true, json: async () => ({ success: true, data: {
        company_name: 'UN1T Stillorgan', short_name: 'UN1T', logo_url: null,
        product_names: { points: 'UN1T Points', hr: 'UN1T HR' }, points_unit: 'UN1T',
      } }) }
    }
    return { ok: false, json: async () => ({ success: false }) }
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('useLocationBrand', () => {
  it('answers the EMPTY brand (bare nouns, no gym name) until the load lands, then the resolved one', async () => {
    render(<Probe locationId="loc-1" />)
    expect(read()).toMatchObject({ companyName: '', productNames: { points: 'Points', hr: 'HR' }, loading: true })
    await waitFor(() => expect(read().loading).toBe(false))
    expect(read()).toMatchObject({ companyName: 'UN1T Stillorgan', shortName: 'UN1T', productNames: { points: 'UN1T Points' }, pointsUnit: 'UN1T' })
    expect(fetch).toHaveBeenCalledWith('/api/public/branding?location_id=loc-1')
  })

  it('a failed read and a missing location both answer EMPTY, never a literal', async () => {
    render(<Probe locationId="loc-x" />)
    await waitFor(() => expect(read().loading).toBe(false))
    expect(read()).toMatchObject({ companyName: '', shortName: '', productNames: { points: 'Points' } })
    cleanup()
    render(<Probe locationId={null} />)
    expect(read()).toMatchObject({ ...EMPTY_BRAND, loading: false })
  })

  it('fetches once per location: a second mount reads the memo', async () => {
    await loadLocationBrand('loc-1')
    render(<Probe locationId="loc-1" />)
    expect(read()).toMatchObject({ companyName: 'UN1T Stillorgan', loading: false })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
