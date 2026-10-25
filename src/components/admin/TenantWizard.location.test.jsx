// @vitest-environment jsdom
//
// TZ.2 (D8) — the wizard's location step chooses the studio's timezone: REQUIRED,
// pre-filled from the creating browser's zone, shown next to the country, with
// a non-blocking warning when the two look mismatched. Before TZ.2 it sent
// neither field ("Ireland-only v1"), so every tenant landed on Europe/Dublin.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

vi.mock('next/link', () => ({
  default: ({ href, children, className }) => <a href={typeof href === 'string' ? href : ''} className={className}>{children}</a>,
}))
const replace = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }))
const zone = vi.hoisted(() => ({ browser: null }))
vi.mock('@/lib/timezone-options', async (importOriginal) => {
  const actual = await importOriginal()
  // The creating browser's zone, faked without touching Intl (canonicalZone reads Intl too).
  return { ...actual, browserZone: () => actual.browserZone(zone.browser) }
})

import TenantWizard from './TenantWizard.jsx'

const ORG = 'org-9'

let fetchMock
beforeEach(() => {
  replace.mockReset()
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { id: 'loc-new' } }) }))
  globalThis.fetch = fetchMock
})
afterEach(() => { cleanup(); zone.browser = null })

const tzSelect = () => screen.getByLabelText(/^Timezone/)

describe('TenantWizard location step — timezone (TZ.2, D8)', () => {
  it('pre-fills the browser zone and posts it with the country', async () => {
    zone.browser = 'Australia/Sydney'
    render(<TenantWizard initialParams={{ org: ORG }} />)
    await waitFor(() => expect(tzSelect().value).toBe('Australia/Sydney'))
    fireEvent.change(screen.getByLabelText('Studio name'), { target: { value: 'FitCo Bondi' } })
    fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'AU' } })
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Create location' }))
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/locations')
    expect(JSON.parse(init.body)).toEqual({
      name: 'FitCo Bondi', organization_id: ORG, address: null, country: 'AU', timezone: 'Australia/Sydney',
    })
  })

  it('warns, without blocking, when the country and zone look mismatched (country AU, zone Europe/Dublin)', async () => {
    zone.browser = 'Europe/Dublin'
    render(<TenantWizard initialParams={{ org: ORG }} />)
    fireEvent.change(screen.getByLabelText('Studio name'), { target: { value: 'FitCo Perth' } })
    fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'AU' } })
    expect(screen.getByRole('status').textContent).toMatch(/Country is AU but the timezone is Europe\/Dublin\. Is that right\?/)
    fireEvent.click(screen.getByRole('button', { name: 'Create location' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ country: 'AU', timezone: 'Europe/Dublin' })
  })

  it('a zone picked by hand is what is sent', async () => {
    zone.browser = 'Europe/Dublin'
    render(<TenantWizard initialParams={{ org: ORG }} />)
    fireEvent.change(screen.getByLabelText('Studio name'), { target: { value: 'FitCo Perth' } })
    fireEvent.change(screen.getByLabelText('Search timezones'), { target: { value: 'perth' } })
    fireEvent.change(tzSelect(), { target: { value: 'Australia/Perth' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create location' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ country: 'IE', timezone: 'Australia/Perth' })
  })

  it('the timezone field is required', () => {
    render(<TenantWizard initialParams={{ org: ORG }} />)
    expect(tzSelect().required).toBe(true)
  })
})
