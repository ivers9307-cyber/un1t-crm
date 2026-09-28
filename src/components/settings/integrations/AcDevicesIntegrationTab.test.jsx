// @vitest-environment jsdom
//
// CHANNELREAD.1 — a failed devices read rendered "No devices configured.
// Add one above…" and the Add Sensibo / Add LG ThinQ buttons. The server
// refuses a duplicate device (409), so this was low severity, but the tab
// said the studio's units were gone.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('@/lib/supabase', () => ({ createBrowserClient: vi.fn() }))

import AcDevicesIntegrationTab from './AcDevicesIntegrationTab.jsx'

const LOC = { id: 'a0000000-0000-4000-8000-000000000001', name: 'Test Studio', sensibo_api_key: 'sk-test', thinq_pat: '', thinq_client_id: '', thinq_country_code: 'IE' }
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body })

afterEach(() => { cleanup(); delete global.fetch })

describe('AcDevicesIntegrationTab — a failed devices read (CHANNELREAD.1)', () => {
  it('shows Could not load + Try again; no "No devices configured", no Add buttons', async () => {
    global.fetch = vi.fn(async () => reply(500, { success: false, error: 'boom' }))
    render(<AcDevicesIntegrationTab location={LOC} canEdit />)
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.queryByText(/No devices configured/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Add Sensibo/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Add LG ThinQ/ })).toBeNull()
  })

  it('Try again that fails again stays on the note and says so', async () => {
    global.fetch = vi.fn(async () => reply(500, { success: false, error: 'boom' }))
    render(<AcDevicesIntegrationTab location={LOC} canEdit />)
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Still could not load. Try again in a minute.')).toBeTruthy()
    expect(screen.queryByText(/No devices configured/)).toBeNull()
  })

  it('pin: an empty list is a real "no devices" with the Add buttons', async () => {
    global.fetch = vi.fn(async () => reply(200, { success: true, data: [] }))
    render(<AcDevicesIntegrationTab location={LOC} canEdit />)
    expect(await screen.findByText(/No devices configured/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Add Sensibo/ })).toBeTruthy()
  })
})
