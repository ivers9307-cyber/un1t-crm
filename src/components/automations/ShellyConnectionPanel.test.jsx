// @vitest-environment jsdom
//
// SHELLY-UI.6 — the connection panel's contract with PUT/DELETE
// /api/shelly/connection. The four assertions that exist because of a review
// finding rather than a wish:
//
//   * a non-manager gets a STATUS LINE, never the form (the affordance must
//     match the guard, or an owner-only action reads as broken)
//   * `devices_seen: null` OMITS the sentence — probeConnection answers null
//     for a body it could not count and 0 for a genuinely empty account, and
//     "0 devices found" would send an operator hunting for plugs that are
//     plainly there
//   * a 409 `verification_unavailable` is TRANSIENT and gets a retry, unlike
//     the cross-org refusal
//   * Disconnect is two-step and names what survives it

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import ShellyConnectionPanel from './ShellyConnectionPanel.jsx'

const CONNECTED = {
  host: 'shelly-68-eu.shelly.cloud',
  key_hint: 'ab12',
  has_auth_key: true,
  status: 'connected',
  last_ok_at: new Date(Date.now() - 60_000).toISOString(),
  last_error: null,
  last_error_at: null,
}

function mockFetch(reply) {
  global.fetch = vi.fn(async (url, init = {}) => reply(String(url), init))
}
const json = (status, body) => ({ ok: status < 400, status, json: async () => body })

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { cleanup(); delete global.fetch })

describe('ShellyConnectionPanel — who may manage it', () => {
  it('renders a read-only status line for a non-manager, with no form', () => {
    render(<ShellyConnectionPanel connection={CONNECTED} canManage={false} deviceCount={3} />)
    expect(screen.getByText('Connected')).toBeTruthy()
    expect(screen.getByText(/Managed by the studio owner/)).toBeTruthy()
    expect(screen.queryByLabelText(/Authorization cloud key/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Disconnect/ })).toBeNull()
  })

  it('a non-manager at a never-connected location sees "Not connected", not a form', () => {
    render(<ShellyConnectionPanel connection={null} canManage={false} deviceCount={0} />)
    expect(screen.getByText('Not connected')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Connect$/ })).toBeNull()
  })

  it('an owner at a never-connected location gets the Connect form and the "where to find these" copy', () => {
    render(<ShellyConnectionPanel connection={null} canManage deviceCount={0} />)
    expect(screen.getByRole('button', { name: /^Connect$/ })).toBeTruthy()
    expect(screen.getByPlaceholderText('shelly-68-eu.shelly.cloud')).toBeTruthy()
    expect(screen.getByText(/User settings → Authorization cloud key/)).toBeTruthy()
    expect(screen.getByText(/password invalidates the key/)).toBeTruthy()
  })

  it('the key field is a password input that refuses the browser’s saved password', () => {
    const { container } = render(<ShellyConnectionPanel connection={null} canManage deviceCount={0} />)
    const key = container.querySelector('input[type="password"]')
    expect(key).toBeTruthy()
    // "new-password", not "off" — Chrome ignores `off` on password fields and
    // would offer the saved site password for a field that takes a Shelly key.
    expect(key.getAttribute('autocomplete')).toBe('new-password')
  })
})

describe('ShellyConnectionPanel — connecting', () => {
  it('PUTs { server, auth_key } and reports the device count when the route gave one', async () => {
    let sent = null
    mockFetch((url, init) => {
      sent = { url, method: init.method, body: JSON.parse(init.body) }
      return json(200, { success: true, connection: CONNECTED, devices_seen: 4, shared_with: [] })
    })
    const onSaved = vi.fn()
    render(<ShellyConnectionPanel connection={null} canManage deviceCount={0} onSaved={onSaved} />)

    fireEvent.change(screen.getByLabelText('Server'), { target: { value: 'shelly-68-eu.shelly.cloud' } })
    fireEvent.change(screen.getByLabelText(/Authorization cloud key/), { target: { value: 'a'.repeat(24) } })
    fireEvent.click(screen.getByRole('button', { name: /^Connect$/ }))

    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(sent.method).toBe('PUT')
    expect(sent.url).toBe('/api/shelly/connection')
    expect(sent.body).toEqual({ server: 'shelly-68-eu.shelly.cloud', auth_key: 'a'.repeat(24) })
    expect(screen.getByText(/Connected — 4 devices found/)).toBeTruthy()
  })

  it('reports a genuinely empty account as 0 devices found', async () => {
    mockFetch(() => json(200, { success: true, connection: CONNECTED, devices_seen: 0, shared_with: [] }))
    render(<ShellyConnectionPanel connection={null} canManage deviceCount={0} />)
    fireEvent.click(screen.getByRole('button', { name: /^Connect$/ }))
    await waitFor(() => expect(screen.getByText(/Connected — 0 devices found/)).toBeTruthy())
  })

  it('OMITS the device sentence entirely when devices_seen is null', async () => {
    mockFetch(() => json(200, { success: true, connection: CONNECTED, devices_seen: null, shared_with: [] }))
    render(<ShellyConnectionPanel connection={null} canManage deviceCount={0} />)
    fireEvent.click(screen.getByRole('button', { name: /^Connect$/ }))
    await waitFor(() => expect(screen.getByText(/^Connected$/)).toBeTruthy())
    expect(screen.queryByText(/devices found/)).toBeNull()
  })

  it('names same-org siblings when the key is shared', async () => {
    mockFetch(() => json(200, { success: true, connection: CONNECTED, devices_seen: 2, shared_with: ['Hatch Street'] }))
    render(<ShellyConnectionPanel connection={null} canManage deviceCount={0} />)
    fireEvent.click(screen.getByRole('button', { name: /^Connect$/ }))
    await waitFor(() => expect(screen.getByText(/Also used by Hatch Street/)).toBeTruthy())
  })
})

describe('ShellyConnectionPanel — refusals', () => {
  it('renders the route’s key_rejected copy verbatim', async () => {
    const copy = 'Shelly rejected that auth key — copy it again from the Shelly app (User settings → Authorization cloud key)'
    mockFetch(() => json(400, { success: false, error: copy, code: 'key_rejected' }))
    render(<ShellyConnectionPanel connection={null} canManage deviceCount={0} />)
    fireEvent.click(screen.getByRole('button', { name: /^Connect$/ }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(copy))
    // Transient-only affordance — a rejected key is not retryable by clicking.
    expect(screen.queryByRole('button', { name: /Try again/ })).toBeNull()
  })

  it('offers a retry for a 409 verification_unavailable', async () => {
    let calls = 0
    mockFetch(() => {
      calls += 1
      return calls === 1
        ? json(409, { success: false, error: 'Could not verify this Shelly account right now', code: 'verification_unavailable' })
        : json(200, { success: true, connection: CONNECTED, devices_seen: 1, shared_with: [] })
    })
    render(<ShellyConnectionPanel connection={null} canManage deviceCount={0} />)
    fireEvent.click(screen.getByRole('button', { name: /^Connect$/ }))
    const retry = await screen.findByRole('button', { name: /Try again/ })
    fireEvent.click(retry)
    await waitFor(() => expect(screen.getByText(/Connected — 1 devices found/)).toBeTruthy())
    expect(calls).toBe(2)
  })

  it('shows the cross-org refusal with no retry and no other business named', async () => {
    mockFetch(() => json(409, { success: false, error: 'This Shelly account is already linked to another business' }))
    render(<ShellyConnectionPanel connection={null} canManage deviceCount={0} />)
    fireEvent.click(screen.getByRole('button', { name: /^Connect$/ }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('already linked to another business'))
    expect(screen.queryByRole('button', { name: /Try again/ })).toBeNull()
  })

  it('a validation 400 renders issues[0].message, not the generic error', async () => {
    mockFetch(() => json(400, { success: false, error: 'Invalid request', issues: [{ message: 'Give the server a name' }] }))
    render(<ShellyConnectionPanel connection={null} canManage deviceCount={0} />)
    fireEvent.click(screen.getByRole('button', { name: /^Connect$/ }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Give the server a name'))
  })
})

describe('ShellyConnectionPanel — the linked state', () => {
  it('shows host, masked key and last OK, plus the status chip', () => {
    render(<ShellyConnectionPanel connection={CONNECTED} canManage deviceCount={2} />)
    expect(screen.getByText('Connected')).toBeTruthy()
    expect(screen.getByText(/shelly-68-eu\.shelly\.cloud · key ••••ab12 · last OK/)).toBeTruthy()
  })

  it('an error status reads as retrying, never as broken', () => {
    render(<ShellyConnectionPanel canManage deviceCount={1}
      connection={{ ...CONNECTED, status: 'error', last_error: 'Shelly cloud did not answer' }} />)
    expect(screen.getByText('Retrying — Shelly unreachable')).toBeTruthy()
    expect(screen.getByText('Shelly cloud did not answer')).toBeTruthy()
  })

  it('action_needed asks for a re-paste', () => {
    render(<ShellyConnectionPanel canManage deviceCount={1}
      connection={{ ...CONNECTED, status: 'action_needed', last_error: 'Shelly rejected the stored auth key' }} />)
    expect(screen.getByText('Action needed — re-paste the key')).toBeTruthy()
  })

  it('Re-paste key reopens the form with the server prefilled and the key blank', () => {
    const { container } = render(<ShellyConnectionPanel connection={CONNECTED} canManage deviceCount={2} />)
    fireEvent.click(screen.getByRole('button', { name: /Re-paste key/ }))
    expect(screen.getByLabelText('Server').value).toBe('shelly-68-eu.shelly.cloud')
    expect(container.querySelector('input[type="password"]').value).toBe('')
    // Blank keeps the stored key (the route's secret merge), so the field is
    // NOT required on a re-paste.
    expect(container.querySelector('input[type="password"]').getAttribute('aria-required')).toBeNull()
  })

  it('Disconnect is two-step, names the surviving plugs, and only then DELETEs', async () => {
    let method = null
    mockFetch((url, init) => {
      method = init.method
      return json(200, { success: true, message: 'Disconnected.' })
    })
    const onDisconnected = vi.fn()
    render(<ShellyConnectionPanel connection={CONNECTED} canManage deviceCount={3} onDisconnected={onDisconnected} />)

    fireEvent.click(screen.getByRole('button', { name: /Disconnect/ }))
    expect(global.fetch).not.toHaveBeenCalled()
    expect(screen.getByText(/Your 3 adopted plugs stay adopted; control stops until you re-link\./)).toBeTruthy()

    fireEvent.click(screen.getAllByRole('button', { name: /^Disconnect$/ }).at(-1))
    await waitFor(() => expect(onDisconnected).toHaveBeenCalled())
    expect(method).toBe('DELETE')
  })

  it('backing out of Disconnect sends nothing', () => {
    mockFetch(() => json(200, { success: true }))
    render(<ShellyConnectionPanel connection={CONNECTED} canManage deviceCount={3} />)
    fireEvent.click(screen.getByRole('button', { name: /Disconnect/ }))
    fireEvent.click(screen.getByRole('button', { name: /Keep it/ }))
    expect(global.fetch).not.toHaveBeenCalled()
    expect(screen.queryByText(/stay adopted/)).toBeNull()
  })

  it('an unknown device count drops the number rather than printing a zero', () => {
    render(<ShellyConnectionPanel connection={CONNECTED} canManage deviceCount={null} />)
    fireEvent.click(screen.getByRole('button', { name: /Disconnect/ }))
    expect(screen.getByText(/Your adopted plugs stay adopted/)).toBeTruthy()
  })
})
