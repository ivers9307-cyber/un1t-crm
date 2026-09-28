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
})
