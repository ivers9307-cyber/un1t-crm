// @vitest-environment jsdom
//
// ACDEVLOC.1 — the page no longer sends the AC credentials, so the tab's
// status comes from has_sensibo_key / has_thinq_pat; and only a master gets
// the AC tab's manage controls (canManage).

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams('tab=ac-devices'),
  usePathname: () => '/settings/locations/loc-1',
}))

import LocationIntegrations from './LocationIntegrations.jsx'

const LOC = { id: 'a0000000-0000-4000-8000-000000000001', name: 'Synthetic Studio', features: {}, settings: {}, has_sensibo_key: true, has_thinq_pat: false }

beforeEach(() => {
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, devices: [] }) }))
})
afterEach(() => { cleanup(); delete global.fetch })

describe('LocationIntegrations — AC tab (ACDEVLOC.1)', () => {
  it('shows connected from has_sensibo_key', () => {
    render(<LocationIntegrations location={LOC} xeroConnection={null} user={{ role: 'master' }} />)
    expect(screen.getByRole('button', { name: /AC Devices/ }).querySelector('.text-green-500')).not.toBeNull()
  })

  it('a raw key on the row (the old shape) no longer counts', () => {
    render(<LocationIntegrations location={{ ...LOC, has_sensibo_key: false, sensibo_api_key: 'sk-synthetic' }} xeroConnection={null} user={{ role: 'master' }} />)
    expect(screen.getByRole('button', { name: /AC Devices/ }).querySelector('.text-green-500')).toBeNull()
  })

  it('a master gets Save credentials; an owner does not', async () => {
    render(<LocationIntegrations location={LOC} xeroConnection={null} user={{ role: 'master' }} />)
    expect(await screen.findByRole('button', { name: 'Save credentials' })).toBeTruthy()
    cleanup()
    render(<LocationIntegrations location={LOC} xeroConnection={null} user={{ role: 'owner' }} />)
    expect(await screen.findByText(/No devices configured/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Save credentials' })).toBeNull()
  })
})
