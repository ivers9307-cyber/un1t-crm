// @vitest-environment jsdom
//
// CHANNELREAD.1 — a failed devices read rendered "No devices configured. Add
// one above…" and the Add buttons (cases kept below).
// ACDEVLOC.1 — the tab acts on the location in its URL (location.id), never
// the caller's active studio; the stored Sensibo key and ThinQ PAT are never in
// this tab's props or a URL (the `user` object still carries them: C35
// SECFIX.3); only a master manages.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import AcDevicesIntegrationTab from './AcDevicesIntegrationTab.jsx'

const LOC_ID = 'b0000000-0000-4000-8000-00000000000b'
const LOC = { id: LOC_ID, name: 'Test Studio', has_sensibo_key: true, has_thinq_pat: false, thinq_client_id: '', thinq_country_code: 'IE' }
const BASE = `/api/locations/${LOC_ID}/ac-devices`
const LIST = `GET ${BASE}?include_disabled=1`
const DEVICE = {
  id: 'd0000000-0000-4000-8000-000000000001', location_id: LOC_ID, label: 'Gym floor', provider: 'sensibo',
  device_group: 'Gym Floor', default_mode: 'cool', default_temp_c: 22, default_fan: 'auto', session_minutes: 30,
  external_auto_off_minutes: null, enabled: true,
}
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body })

// Answers by "METHOD url"; an unexpected call is recorded and answered 599.
function routeFetch(routes) {
  const unexpected = []
  const fn = vi.fn(async (url, init = {}) => {
    const key = `${init.method || 'GET'} ${url}`
    if (!(key in routes)) { unexpected.push(key); return reply(599, { success: false }) }
    const r = routes[key]
    return typeof r === 'function' ? r(init) : r
  })
  fn.unexpected = unexpected
  return fn
}
const bodyOf = (fetchFn, key) => {
  const call = fetchFn.mock.calls.find(([url, init = {}]) => `${init.method || 'GET'} ${url}` === key)
  return call ? JSON.parse(call[1].body) : undefined
}

beforeEach(() => { window.alert = vi.fn(); window.confirm = vi.fn(() => true); window.prompt = vi.fn(() => 'Floor unit') })
afterEach(() => { cleanup(); delete global.fetch })

describe('AcDevicesIntegrationTab — a failed devices read (CHANNELREAD.1)', () => {
  it('shows Could not load + Try again; no "No devices configured", no Add buttons', async () => {
    global.fetch = routeFetch({ [LIST]: reply(500, { success: false, error: 'boom' }) })
    render(<AcDevicesIntegrationTab location={LOC} canEdit canManage />)
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.queryByText(/No devices configured/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Add Sensibo/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Add LG ThinQ/ })).toBeNull()
  })

  it('Try again that fails again stays on the note and says so', async () => {
    global.fetch = routeFetch({ [LIST]: reply(500, { success: false, error: 'boom' }) })
    render(<AcDevicesIntegrationTab location={LOC} canEdit canManage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Still could not load. Try again in a minute.')).toBeTruthy()
    expect(screen.queryByText(/No devices configured/)).toBeNull()
  })

  it('pin: an empty list is a real "no devices" with the Add buttons', async () => {
    global.fetch = routeFetch({ [LIST]: reply(200, { success: true, devices: [] }) })
    render(<AcDevicesIntegrationTab location={LOC} canEdit canManage />)
    expect(await screen.findByText(/No devices configured/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Add Sensibo/ })).toBeTruthy()
  })
})

describe('AcDevicesIntegrationTab — the location in the URL (ACDEVLOC.1)', () => {
  it('lists the units of location.id (disabled included), never the active studio', async () => {
    global.fetch = routeFetch({ [LIST]: reply(200, { success: true, devices: [DEVICE] }) })
    render(<AcDevicesIntegrationTab location={LOC} canEdit canManage />)
    expect(await screen.findByText('Gym floor')).toBeTruthy()
    expect(global.fetch.unexpected).toEqual([])
    expect(global.fetch.mock.calls.some(([url]) => String(url).includes('studio-management'))).toBe(false)
  })

  it('never shows a stored key, even if one reached the props', async () => {
    global.fetch = routeFetch({ [LIST]: reply(200, { success: true, devices: [] }) })
    render(<AcDevicesIntegrationTab location={{ ...LOC, sensibo_api_key: 'sk-leaked-synthetic', thinq_pat: 'pat-leaked-synthetic' }} canEdit canManage />)
    await screen.findByText(/No devices configured/)
    expect(screen.getByLabelText('Sensibo API key').value).toBe('')
    expect(screen.getByLabelText('Sensibo API key').getAttribute('type')).toBe('password')
    expect(document.body.innerHTML).not.toContain('leaked-synthetic')
  })

  it('discovery POSTs to location.id; the saved key is used server-side, so none is sent', async () => {
    global.fetch = routeFetch({
      [LIST]: reply(200, { success: true, devices: [] }),
      [`POST ${BASE}/discover`]: reply(200, { success: true, data: [] }),
    })
    render(<AcDevicesIntegrationTab location={LOC} canEdit canManage />)
    fireEvent.click(await screen.findByRole('button', { name: /Add Sensibo/ }))
    await waitFor(() => expect(bodyOf(global.fetch, `POST ${BASE}/discover`)).toEqual({ provider: 'sensibo' }))
    expect(global.fetch.mock.calls.every(([url]) => !String(url).includes('?api_key'))).toBe(true)
  })

  it('a typed key travels in the body, never in a URL', async () => {
    global.fetch = routeFetch({
      [LIST]: reply(200, { success: true, devices: [] }),
      [`POST ${BASE}/discover`]: reply(200, { success: true, data: [] }),
    })
    render(<AcDevicesIntegrationTab location={LOC} canEdit canManage />)
    await screen.findByText(/No devices configured/)
    fireEvent.change(screen.getByLabelText('Sensibo API key'), { target: { value: 'sk-typed-synthetic' } })
    fireEvent.click(screen.getByRole('button', { name: /Add Sensibo/ }))
    await waitFor(() => expect(bodyOf(global.fetch, `POST ${BASE}/discover`)).toEqual({ provider: 'sensibo', api_key: 'sk-typed-synthetic' }))
    expect(global.fetch.mock.calls.every(([url]) => !String(url).includes('sk-typed-synthetic'))).toBe(true)
  })

  it('adding a discovered unit POSTs to location.id, then re-reads the list', async () => {
    global.fetch = routeFetch({
      [LIST]: reply(200, { success: true, devices: [] }),
      [`POST ${BASE}/discover`]: reply(200, { success: true, data: [{ id: 'pod1', room_name: 'Floor', product_model: 'sky' }] }),
      [`POST ${BASE}`]: reply(201, { success: true, device: { ...DEVICE, label: 'Floor unit' } }),
    })
    render(<AcDevicesIntegrationTab location={LOC} canEdit canManage />)
    fireEvent.click(await screen.findByRole('button', { name: /Add Sensibo/ }))
    fireEvent.click(await screen.findByText('Floor'))
    await waitFor(() => expect(bodyOf(global.fetch, `POST ${BASE}`)).toEqual({ provider: 'sensibo', provider_device_id: 'pod1', label: 'Floor unit' }))
    await waitFor(() => expect(global.fetch.mock.calls.filter(([, init = {}]) => !init.method).length).toBe(2))
    expect(global.fetch.unexpected).toEqual([])
  })

  it('credentials save through the masked integrations route, sending only a typed secret', async () => {
    global.fetch = routeFetch({
      [LIST]: reply(200, { success: true, devices: [] }),
      [`PUT /api/locations/${LOC_ID}/integrations/ac`]: reply(200, {
        success: true,
        data: { has_sensibo_key: true, has_thinq_pat: true, thinq_client_id: 'cid-new', thinq_country_code: 'IE' },
      }),
    })
    render(<AcDevicesIntegrationTab location={LOC} canEdit canManage />)
    await screen.findByText(/No devices configured/)
    fireEvent.change(screen.getByLabelText('LG ThinQ PAT'), { target: { value: 'pat-typed-synthetic' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save credentials' }))
    await waitFor(() => expect(bodyOf(global.fetch, `PUT /api/locations/${LOC_ID}/integrations/ac`))
      .toEqual({ thinq_pat: 'pat-typed-synthetic', thinq_country_code: 'IE' }))
    expect(await screen.findByText(/Credentials saved at/)).toBeTruthy()
    expect(screen.getByLabelText('LG ThinQ PAT').value).toBe('')
    expect(screen.getByLabelText('ThinQ client ID').value).toBe('cid-new')
    expect(global.fetch.mock.calls.some(([url]) => String(url).includes('/connections/refresh'))).toBe(false)
  })

  it('a disabled unit can be re-enabled at location.id', async () => {
    global.fetch = routeFetch({
      [LIST]: reply(200, { success: true, devices: [{ ...DEVICE, enabled: false }] }),
      [`PATCH ${BASE}/${DEVICE.id}`]: reply(200, { success: true, device: DEVICE }),
    })
    render(<AcDevicesIntegrationTab location={LOC} canEdit canManage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Re-enable device' }))
    await waitFor(() => expect(bodyOf(global.fetch, `PATCH ${BASE}/${DEVICE.id}`)).toEqual({ enabled: true }))
  })

  it('disable PATCHes enabled:false at location.id', async () => {
    global.fetch = routeFetch({
      [LIST]: reply(200, { success: true, devices: [DEVICE] }),
      [`PATCH ${BASE}/${DEVICE.id}`]: reply(200, { success: true, device: { ...DEVICE, enabled: false } }),
    })
    render(<AcDevicesIntegrationTab location={LOC} canEdit canManage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Disable device' }))
    await waitFor(() => expect(bodyOf(global.fetch, `PATCH ${BASE}/${DEVICE.id}`)).toEqual({ enabled: false }))
  })

  it('an owner (canManage false) sees the units and "Saved", but no Save, Add, Edit or Disable', async () => {
    global.fetch = routeFetch({ [LIST]: reply(200, { success: true, devices: [DEVICE] }) })
    render(<AcDevicesIntegrationTab location={LOC} canEdit canManage={false} />)
    expect(await screen.findByText('Gym floor')).toBeTruthy()
    expect(screen.getByText('Saved')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Save credentials' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Add Sensibo/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit device' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Disable device' })).toBeNull()
    expect(screen.queryByLabelText('Sensibo API key')).toBeNull()
  })
})
