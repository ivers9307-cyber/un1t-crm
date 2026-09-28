// @vitest-environment jsdom
//
// CHANNELREAD.1 — the tab strip's amber "could not load" dot. An aria-label
// on a bare <span> (no role) is ignored by most screen readers, so the state
// was visible only as a colour. It is now role="img" with that label, which
// also puts it in the tab button's accessible name.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams('tab=xero'),
  usePathname: () => '/settings/locations/loc-1',
}))

import LocationIntegrations from './LocationIntegrations.jsx'

const LOC = { id: 'a0000000-0000-4000-8000-000000000001', name: 'Synthetic Studio', features: {}, settings: {} }
const MASTER = { role: 'master' }

afterEach(() => cleanup())

describe('LocationIntegrations — tab status dot', () => {
  it('a failed Xero read shows an announced "Could not load" image in the Xero tab', () => {
    render(<LocationIntegrations location={LOC} xeroConnection={null} xeroReadFailed user={MASTER} />)
    const dot = screen.getByRole('img', { name: 'Could not load' })
    expect(dot.className).toContain('bg-amber-500')
    expect(screen.getByRole('button', { name: /Xero.*Could not load/ })).toBeTruthy()
  })

  it('a good read shows no such dot', () => {
    render(<LocationIntegrations location={LOC} xeroConnection={null} user={MASTER} />)
    expect(screen.queryByRole('img', { name: 'Could not load' })).toBeNull()
  })
})
