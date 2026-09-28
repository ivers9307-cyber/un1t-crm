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

import LocationForm from './LocationForm.jsx'

afterEach(() => { cleanup(); calls.update = null; calls.select = null })

// SECFIX.3c (mig 648, plan D6) grants `authenticated` UPDATE on exactly these
// 15 locations columns: the edit form's 11 plus CarDepositSettings' 4. Any other
// key in the edit payload would be refused (42501) once 648 applies, and the
// 3c guard reads the same list from tests/helpers/credential-column-grants.js.
const MIG_648_LOCATIONS_UPDATE = ['name', 'slug', 'address', 'phone', 'email', 'timezone', 'country', 'active',
  'monthly_contractor_budget_eur', 'invoices_inbound_slug', 'updated_at', 'car_deposit_default_amount',
  'car_deposit_terms', 'car_deposit_terms_version', 'car_deposit_receipt_sms_enabled']
const CAR_DEPOSIT_COLUMNS = ['car_deposit_default_amount', 'car_deposit_terms', 'car_deposit_terms_version', 'car_deposit_receipt_sms_enabled']
const LOCATION_FORM_UPDATE = MIG_648_LOCATIONS_UPDATE.filter((c) => !CAR_DEPOSIT_COLUMNS.includes(c))

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

  it('sends exactly the edit form\'s share of mig 648\'s UPDATE grant, no more and no less', async () => {
    render(<LocationForm location={LOCATION} organizations={[{ id: 'org-1', name: 'Org' }]} />)
    fireEvent.submit(screen.getByRole('button', { name: /Update Location/ }).closest('form'))
    await waitFor(() => expect(calls.update).toBeTruthy())
    expect(Object.keys(calls.update).sort()).toEqual([...LOCATION_FORM_UPDATE].sort())
    expect(LOCATION_FORM_UPDATE).toHaveLength(11)
  })
})
