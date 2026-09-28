// @vitest-environment jsdom
//
// CHANNELREAD.1 — the Instagram card (hub drawer + Instagram tab). A failed
// GET /api/locations/[id]/channels used to leave `connections = []`, so the
// card said "Not connected", showed the token form, and Save POSTed a new
// connection OVER the live one. A failed read now renders "Could not load" +
// Try again, and nothing that can connect, update or disconnect.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import ConnectionsSection from './ConnectionsSection.jsx'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const LIVE_IG = {
  id: 'conn-1', location_id: LOC, platform: 'instagram', is_active: true,
  display_name: '@studio', external_account_id: '17841000000000000', app_id: '2691000000',
  access_token: '••••••••abcd', has_access_token: true, app_secret: '', has_app_secret: false,
  agent_enabled: false,
}
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body })
const ok = (connections) => reply(200, { success: true, connections })
const boom = () => reply(500, { success: false, error: 'canceling statement due to statement timeout' })

// GET answers in order (the last repeats); an Error is thrown as a network
// failure. `post` / `patch` answer the writes.
function mockFetch({ gets, post = reply(200, { success: true, connection: LIVE_IG }), patch = reply(200, { success: true, connection: LIVE_IG }) }) {
  let i = 0
  global.fetch = vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET'
    if (method === 'GET') {
      const a = gets[Math.min(i++, gets.length - 1)]
      if (a instanceof Error) throw a
      return a
    }
    if (method === 'POST') return post
    if (method === 'PATCH') return patch
    return reply(200, { success: true })
  })
}
const calls = (method) => global.fetch.mock.calls.filter(([, init = {}]) => (init.method || 'GET') === method)

afterEach(() => { cleanup(); delete global.fetch })

function expectNothingActionable(container) {
  expect(screen.queryByText('Not connected')).toBeNull()
  expect(screen.queryByText('Connected')).toBeNull()
  expect(screen.queryByRole('button', { name: /Connect Instagram|Update Instagram|Disconnect/ })).toBeNull()
  expect(container.querySelectorAll('input').length).toBe(0)
}

describe('ConnectionsSection — a failed read (CHANNELREAD.1)', () => {
  it('a 500 renders Could not load + Try again, never Not connected or the token form', async () => {
    mockFetch({ gets: [boom()] })
    const { container } = render(<ConnectionsSection locationId={LOC} embedded />)
    expect(await screen.findByText('Could not load')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
    expectNothingActionable(container)
  })

  it('a network failure renders the same', async () => {
    mockFetch({ gets: [new TypeError('Failed to fetch')] })
    const { container } = render(<ConnectionsSection locationId={LOC} embedded />)
    expect(await screen.findByText('Could not load')).toBeTruthy()
    expectNothingActionable(container)
  })

  it('a 200 without a connections array is not "nothing connected"', async () => {
    mockFetch({ gets: [reply(200, { success: true })] })
    const { container } = render(<ConnectionsSection locationId={LOC} embedded />)
    expect(await screen.findByText('Could not load')).toBeTruthy()
    expectNothingActionable(container)
  })

  it('the standalone section keeps the WhatsApp pointer but still offers no Instagram action', async () => {
    mockFetch({ gets: [boom()] })
    const { container } = render(<ConnectionsSection locationId={LOC} />)
    expect(await screen.findByText('Could not load')).toBeTruthy()
    expect(screen.getByText('WhatsApp')).toBeTruthy()
    expectNothingActionable(container)
  })

  it('never writes anything after a failed read', async () => {
    mockFetch({ gets: [boom()] })
    render(<ConnectionsSection locationId={LOC} embedded />)
    await screen.findByText('Could not load')
    expect(calls('POST')).toHaveLength(0)
    expect(calls('PATCH')).toHaveLength(0)
    expect(calls('DELETE')).toHaveLength(0)
  })

  it('Try again re-reads, and a live connection then shows as Connected with Update', async () => {
    mockFetch({ gets: [boom(), ok([LIVE_IG])] })
    render(<ConnectionsSection locationId={LOC} embedded />)
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Connected')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Update Instagram' })).toBeTruthy()
  })

  it('Try again that fails again stays unknown and says so', async () => {
    mockFetch({ gets: [boom(), boom()] })
    render(<ConnectionsSection locationId={LOC} embedded />)
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Still could not load. Try again in a minute.')).toBeTruthy()
    expect(screen.queryByText('Not connected')).toBeNull()
  })
})

describe('ConnectionsSection — real answers are unchanged (pins)', () => {
  it('a genuinely empty location shows Not connected + Connect Instagram', async () => {
    mockFetch({ gets: [ok([])] })
    render(<ConnectionsSection locationId={LOC} embedded />)
    expect(await screen.findByText('Not connected')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connect Instagram' })).toBeTruthy()
  })

  it('a live connection saves with PATCH to its own row, never POST', async () => {
    mockFetch({ gets: [ok([LIVE_IG])] })
    render(<ConnectionsSection locationId={LOC} embedded />)
    fireEvent.click(await screen.findByRole('button', { name: 'Update Instagram' }))
    await screen.findByText('Saved ✓')
    expect(calls('POST')).toHaveLength(0)
    expect(calls('PATCH')).toHaveLength(1)
    expect(String(calls('PATCH')[0][0])).toBe(`/api/locations/${LOC}/channels/conn-1`)
  })

  it('a 409 already_connected shows the message and reloads, so the card switches to Update', async () => {
    const msg = 'This location already has an active Instagram connection. Reload the page and use Update instead.'
    mockFetch({
      gets: [ok([]), ok([LIVE_IG])],
      post: reply(409, { success: false, code: 'already_connected', error: msg }),
    })
    render(<ConnectionsSection locationId={LOC} embedded />)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Instagram' }))
    expect(await screen.findByRole('button', { name: 'Update Instagram' })).toBeTruthy()
    expect(screen.getByText(msg)).toBeTruthy()
  })
})
