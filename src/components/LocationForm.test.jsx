// @vitest-environment jsdom
// SECFIX.3b — the edit save names its returned column (mig 648 withholds the
// rest) and never sends organization_id (an owner could re-parent a studio).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }))
const calls = vi.hoisted(() => ({ update: null, select: null }))
vi.mock('@/lib/supabase', () => ({
  createBrowserClient: () => ({
    from: () => {
      const b = {
        update(p) { calls.update = p; return b },
        eq() { return b },
        select(cols) { calls.select = cols; return b },
        single: async () => ({ data: { id: 'loc-1' }, error: null }),
      }
      return b
    },
  }),
}))

const zone = vi.hoisted(() => ({ browser: null }))
vi.mock('@/lib/timezone-options', async (importOriginal) => {
  const actual = await importOriginal()
  // The creating browser's zone (D8), faked without touching Intl (canonicalZone reads Intl too).
  return { ...actual, browserZone: () => actual.browserZone(zone.browser) }
})

import LocationForm from './LocationForm.jsx'

afterEach(() => { cleanup(); calls.update = null; calls.select = null })

// SECFIX.3c (mig 648, plan D6) granted `authenticated` UPDATE on 15 locations
// columns; TZ.2 (mig 719) revoked `timezone`, leaving 14: the edit form's 10
// plus CarDepositSettings' 4. Any other key in the edit payload is refused
// (42501), and the 3c guard reads the same list from
// tests/helpers/credential-column-grants.js.
const LOCATIONS_CLIENT_UPDATE = ['name', 'slug', 'address', 'phone', 'email', 'country', 'active',
  'monthly_contractor_budget_eur', 'invoices_inbound_slug', 'updated_at', 'car_deposit_default_amount',
  'car_deposit_terms', 'car_deposit_terms_version', 'car_deposit_receipt_sms_enabled']
const CAR_DEPOSIT_COLUMNS = ['car_deposit_default_amount', 'car_deposit_terms', 'car_deposit_terms_version', 'car_deposit_receipt_sms_enabled']
const LOCATION_FORM_UPDATE = LOCATIONS_CLIENT_UPDATE.filter((c) => !CAR_DEPOSIT_COLUMNS.includes(c))

const LOCATION = { id: 'loc-1', name: 'Studio', slug: 'studio', timezone: 'Europe/Dublin', country: 'IE', active: true, organization_id: 'org-1' }

describe('LocationForm edit save (SECFIX.3b)', () => {
  it('returns only id and does not send organization_id', async () => {
    render(<LocationForm location={LOCATION} organizations={[{ id: 'org-1', name: 'Org' }]} />)
    fireEvent.submit(screen.getByRole('button', { name: /Update Location/ }).closest('form'))
    await waitFor(() => expect(calls.update).toBeTruthy())
    expect(calls.select).toBe('id')
    expect(calls.update).not.toHaveProperty('organization_id')
    expect(calls.update).toMatchObject({ name: 'Studio', slug: 'studio' })
  })

  it('sends exactly the edit form\'s share of the client UPDATE grant (648 minus 719), no more and no less', async () => {
    render(<LocationForm location={LOCATION} organizations={[{ id: 'org-1', name: 'Org' }]} />)
    fireEvent.submit(screen.getByRole('button', { name: /Update Location/ }).closest('form'))
    await waitFor(() => expect(calls.update).toBeTruthy())
    expect(Object.keys(calls.update).sort()).toEqual([...LOCATION_FORM_UPDATE].sort())
    expect(LOCATION_FORM_UPDATE).toHaveLength(10)
    expect(calls.update).not.toHaveProperty('timezone')
  })
})

describe('LocationForm timezone (TZ.2)', () => {
  const fakeBrowserZone = (tz) => { zone.browser = tz }
  afterEach(() => { zone.browser = null })

  it('edit: shows the zone read-only with its offset, and an enabled Change timezone button (TZ.3)', () => {
    render(<LocationForm location={{ ...LOCATION, timezone: 'America/New_York', country: 'IE' }} organizations={[{ id: 'org-1', name: 'Org' }]} />)
    expect(screen.queryByLabelText('Search timezones')).toBeNull()
    expect(screen.getByLabelText('Timezone').textContent).toMatch(/^America\/New York \(GMT-[45]\)$/)
    expect(screen.getByRole('button', { name: /^Change timezone$/ }).disabled).toBe(false)
    // IE on a New York zone: the D8 hint shows on the settings page too.
    expect(screen.getByRole('status').textContent).toMatch(/Country is IE but the timezone is America\/New_York/)
  })

  it('edit: Change timezone opens the dialog OUTSIDE the form; a change shows the new zone and a notice, never via the browser update', async () => {
    const fetchMock = vi.fn(async (url, init) => ({
      ok: true,
      json: async () => (init?.method === 'PUT'
        ? { success: true, data: { timezone: 'America/New_York', previous: 'Europe/Dublin', changed: true,
          broadcasts: { followed: 0, kept: [{ id: 'b1', name: 'London drip', send_window_tz: 'Europe/London' }] } } }
        : { success: true, data: { location: LOCATION, today: '2026-10-25', unknown: [], hasFutureData: false,
          future: { bookings: 0, shift_blocks: 0, race_events: 0, hyrox_blocks: 0, pending_enrolments: 0,
            sonos_schedules: 0, shelly_devices: 0, drip_broadcasts: 0 } } }),
    }))
    globalThis.fetch = fetchMock
    const { container } = render(<LocationForm location={LOCATION} organizations={[{ id: 'org-1', name: 'Org' }]} />)
    fireEvent.click(screen.getByRole('button', { name: /^Change timezone$/ }))
    const dialog = await screen.findByRole('dialog')
    expect(container.querySelector('form').contains(dialog)).toBe(false)
    await screen.findByText('Future bookings')
    fireEvent.change(screen.getByLabelText(/^New timezone/), { target: { value: 'America/New_York' } })
    fireEvent.change(screen.getByLabelText(/Type the location name/), { target: { value: 'Studio' } })
    fireEvent.click(screen.getAllByRole('button', { name: /^Change timezone$/ }).find((b) => dialog.contains(b)))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByLabelText('Timezone').textContent).toMatch(/^America\/New York/)
    expect(screen.getAllByRole('status').map((n) => n.textContent).join(' '))
      .toMatch(/Timezone changed to America\/New York\. One broadcast keeps its own timezone: London drip\./)
    expect(calls.update).toBeNull()
  })

  it('create: the zone is pre-filled from the browser (D8) and posted with the country', async () => {
    fakeBrowserZone('America/New_York')
    const fetchMock = vi.fn(async () => ({ json: async () => ({ success: true, data: { id: 'new' } }) }))
    globalThis.fetch = fetchMock
    render(<LocationForm organizations={[{ id: 'org-1', name: 'Org' }]} />)
    await waitFor(() => expect(screen.getByLabelText(/^Timezone/).value).toBe('America/New_York'))
    fireEvent.change(screen.getByPlaceholderText('e.g. Dublin City'), { target: { value: 'NY Studio' } })
    fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'IE' } })
    // IE + New York: a warning, never a block.
    expect(screen.getByRole('status').textContent).toMatch(/Country is IE but the timezone is America\/New_York/)
    fireEvent.submit(screen.getByRole('button', { name: /Create Location/ }).closest('form'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/locations')
    expect(JSON.parse(init.body)).toMatchObject({ name: 'NY Studio', timezone: 'America/New_York', country: 'IE' })
  })

  it('create: a browser on UTC gives no pre-fill; the field keeps the platform default and stays required', async () => {
    fakeBrowserZone('UTC')
    render(<LocationForm organizations={[{ id: 'org-1', name: 'Org' }]} />)
    expect(screen.getByLabelText(/^Timezone/).value).toBe('Europe/Dublin')
    expect(screen.getByLabelText(/^Timezone/).required).toBe(true)
  })

  it('create: a zone the creator picks is not overwritten by the pre-fill', async () => {
    fakeBrowserZone('Europe/London')
    render(<LocationForm organizations={[{ id: 'org-1', name: 'Org' }]} />)
    await waitFor(() => expect(screen.getByLabelText(/^Timezone/).value).toBe('Europe/London'))
    fireEvent.change(screen.getByLabelText(/^Timezone/), { target: { value: 'Australia/Perth' } })
    expect(screen.getByLabelText(/^Timezone/).value).toBe('Australia/Perth')
  })
})
