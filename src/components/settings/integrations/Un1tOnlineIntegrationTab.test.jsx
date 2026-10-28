// @vitest-environment jsdom
// UN1TSYNC.7 — the un1t.online tab: connected studio, token name, expiry,
// last sync, and the connect / sync now / disconnect actions. Everything goes
// through /api/locations/[id]/un1t-online*; the token is typed into a password
// field, posted, and cleared, never rendered back.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }))

import Un1tOnlineIntegrationTab from './Un1tOnlineIntegrationTab.jsx'

const LOC = { id: 'a0000000-0000-4000-8000-000000000001', name: 'Hatch' }
const TOKEN = 'un1t_ABCDEFGHIJKLMNOPQRSTUVWX_abc'
const DAY = 24 * 60 * 60 * 1000
const inDays = (n) => new Date(Date.now() + n * DAY).toISOString()

const NOT_CONNECTED = { connected: false, status: 'not_connected', last_run: null }
function connected(overrides = {}) {
  return {
    connected: true,
    status: 'connected',
    studio_title: 'UN1T Hatch Street',
    token_name: 'CRM sync',
    permissions_count: 4,
    has_write_permissions: false,
    expires_at: inDays(200),
    last_error: null,
    last_ok_at: null,
    last_run: null,
    ...overrides,
  }
}

let fetchMock
let current
function reply(data, { ok = true, status = 200, extra = {} } = {}) {
  return { ok, status, json: async () => (ok ? { success: true, data, ...extra } : { success: false, ...data }) }
}
beforeEach(() => {
  refresh.mockReset()
  current = NOT_CONNECTED
  fetchMock = vi.fn(async (url, init) => {
    const method = init?.method || 'GET'
    if (method === 'GET') return reply(current)
    if (method === 'PUT') { current = connected(); return reply(current) }
    if (method === 'DELETE') { current = NOT_CONNECTED; return reply({ disconnected: true }) }
    if (method === 'POST') return reply({ ok: true, counts: {}, runId: 'r1' })
    throw new Error(`unexpected ${method}`)
  })
  vi.stubGlobal('fetch', fetchMock)
})
let confirmSpy = null
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  if (confirmSpy) { confirmSpy.mockRestore(); confirmSpy = null }
})

const callsOf = (method) => fetchMock.mock.calls.filter(([, init]) => (init?.method || 'GET') === method)

describe('Un1tOnlineIntegrationTab', () => {
  it('shows the connected studio, token name and permission count', async () => {
    current = connected()
    render(<Un1tOnlineIntegrationTab location={LOC} canEdit />)
    expect(await screen.findByText('UN1T Hatch Street')).toBeTruthy()
    expect(screen.getByText(/CRM sync/)).toBeTruthy()
    expect(screen.getByText(/4 permissions/)).toBeTruthy()
    expect(document.body.innerHTML).not.toContain(TOKEN)
  })

  it('renders an expiry warning when the token expires within 30 days', async () => {
    current = connected({ expires_at: inDays(10) })
    render(<Un1tOnlineIntegrationTab location={LOC} canEdit />)
    const note = await screen.findByTestId('un1t-expiry')
    expect(note.getAttribute('data-expiring')).toBe('true')
    expect(note.className).toMatch(/amber-700/)
  })

  it('does not warn about expiry for a token with plenty of time left', async () => {
    current = connected({ expires_at: inDays(200) })
    render(<Un1tOnlineIntegrationTab location={LOC} canEdit />)
    const note = await screen.findByTestId('un1t-expiry')
    expect(note.getAttribute('data-expiring')).toBe('false')
  })

  it('shows the write-permission note when the token can change data', async () => {
    current = connected({ has_write_permissions: true })
    render(<Un1tOnlineIntegrationTab location={LOC} canEdit />)
    expect(await screen.findByText(/This token can change data on un1t\.online\. The CRM only reads, so a read-only token is safer: create one with the Read-only preset and paste it here\./)).toBeTruthy()
  })

  it('omits the write-permission note for a read-only token', async () => {
    current = connected()
    render(<Un1tOnlineIntegrationTab location={LOC} canEdit />)
    await screen.findByText('UN1T Hatch Street')
    expect(screen.queryByText(/can change data on un1t\.online/)).toBeNull()
  })

  it('shows the last sync time, status, counts and last_error', async () => {
    current = connected({
      status: 'action_needed',
      last_error: 'un1t.online refused the token',
      last_run: {
        status: 'error', started_at: '2026-10-02T09:00:00.000Z', finished_at: '2026-10-02T09:00:05.000Z', duration_ms: 5000,
        first_error: 'un1t.online refused the token', counts: { pulled: { clients: 120, subscriptions: 40 } },
      },
    })
    render(<Un1tOnlineIntegrationTab location={LOC} canEdit />)
    expect(await screen.findByTestId('un1t-last-run')).toBeTruthy()
    expect(screen.getByTestId('un1t-last-run').textContent).toMatch(/error/i)
    expect(screen.getByTestId('un1t-last-run').textContent).toMatch(/clients 120/)
    expect(screen.getAllByText(/un1t\.online refused the token/).length).toBeGreaterThan(0)
  })

  it('shows the contact-matching counts next to the pulled counts', async () => {
    current = connected({
      last_run: {
        status: 'ok', started_at: '2026-10-02T09:00:00.000Z', finished_at: '2026-10-02T09:00:05.000Z', duration_ms: 5000, first_error: null,
        counts: { pulled: { clients: 120 }, contacts: { created: 5, attached_by_email: 3, linked: 100, failed: 2, conflict: 1, ambiguous_email: 4 } },
      },
    })
    render(<Un1tOnlineIntegrationTab location={LOC} canEdit />)
    const el = await screen.findByTestId('un1t-contact-counts')
    expect(el.textContent).toBe('Contacts: 5 created, 3 attached, 2 failed, 1 conflicts, 4 ambiguous emails')
  })

  it('on a 400 with issues, shows the first issue message', async () => {
    fetchMock.mockImplementation(async (url, init) => (init?.method === 'PUT'
      ? { ok: false, status: 400, json: async () => ({ success: false, error: 'Invalid request body', issues: [{ path: ['token'], message: 'That does not look like an un1t.online token.' }] }) }
      : reply(NOT_CONNECTED)))
    render(<Un1tOnlineIntegrationTab location={LOC} canEdit />)
    fireEvent.change(await screen.findByLabelText(/API token/i), { target: { value: TOKEN } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByText('That does not look like an un1t.online token.')).toBeTruthy()
    expect(screen.queryByText('Invalid request body')).toBeNull()
  })

  it('Connect posts the token and clears the field', async () => {
    render(<Un1tOnlineIntegrationTab location={LOC} canEdit />)
    const input = await screen.findByLabelText(/API token/i)
    expect(input.getAttribute('type')).toBe('password')
    expect(input.getAttribute('autocomplete')).toBe('new-password')
    fireEvent.change(input, { target: { value: `  ${TOKEN}  ` } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(callsOf('PUT')).toHaveLength(1))
    const [url, init] = callsOf('PUT')[0]
    expect(url).toBe(`/api/locations/${LOC.id}/un1t-online`)
    expect(JSON.parse(init.body)).toEqual({ token: TOKEN })
    await waitFor(() => expect(screen.getByText('UN1T Hatch Street')).toBeTruthy())
    expect(screen.getByLabelText(/API token/i).value).toBe('')
    expect(document.body.innerHTML).not.toContain(TOKEN)
    expect(refresh).toHaveBeenCalled()
  })

  it('shows the route\'s error when the token is refused and keeps nothing', async () => {
    fetchMock.mockImplementation(async (url, init) => (init?.method === 'PUT'
      ? { ok: false, status: 400, json: async () => ({ success: false, code: 'token_rejected', error: 'un1t.online rejected that token.' }) }
      : reply(NOT_CONNECTED)))
    render(<Un1tOnlineIntegrationTab location={LOC} canEdit />)
    fireEvent.change(await screen.findByLabelText(/API token/i), { target: { value: TOKEN } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByText('un1t.online rejected that token.')).toBeTruthy()
  })

  it('Connect is the only submit button; every other button is type="button"', async () => {
    current = connected()
    render(<Un1tOnlineIntegrationTab location={LOC} canEdit />)
    await screen.findByText('UN1T Hatch Street')
    const buttons = [...document.querySelectorAll('button')]
    const submits = buttons.filter((b) => b.getAttribute('type') === 'submit')
    expect(submits.map((b) => b.textContent.trim())).toEqual(['Connect'])
    for (const b of buttons.filter((x) => !submits.includes(x))) expect(b.getAttribute('type')).toBe('button')
  })

  it('Sync now posts to the sync route and shows the outcome', async () => {
    current = connected()
    render(<Un1tOnlineIntegrationTab location={LOC} canEdit />)
    fireEvent.click(await screen.findByRole('button', { name: /Sync now/ }))
    await waitFor(() => expect(callsOf('POST')).toHaveLength(1))
    expect(callsOf('POST')[0][0]).toBe(`/api/locations/${LOC.id}/un1t-online/sync`)
    expect(await screen.findByText(/Sync finished/)).toBeTruthy()
  })

  it('Sync now shows the failure reason when the run did not go through', async () => {
    current = connected()
    fetchMock.mockImplementation(async (url, init) => (init?.method === 'POST'
      ? reply({ ok: false, reason: 'auth', counts: {}, runId: 'r2' })
      : reply(current)))
    render(<Un1tOnlineIntegrationTab location={LOC} canEdit />)
    fireEvent.click(await screen.findByRole('button', { name: /Sync now/ }))
    expect(await screen.findByText(/Sync failed \(auth\)/)).toBeTruthy()
  })

  it('Disconnect asks for confirmation and only then DELETEs', async () => {
    current = connected()
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    render(<Un1tOnlineIntegrationTab location={LOC} canEdit />)
    const btn = await screen.findByRole('button', { name: 'Disconnect' })
    fireEvent.click(btn)
    expect(callsOf('DELETE')).toHaveLength(0)
    fireEvent.click(btn)
    await waitFor(() => expect(callsOf('DELETE')).toHaveLength(1))
    expect(callsOf('DELETE')[0][0]).toBe(`/api/locations/${LOC.id}/un1t-online`)
    await waitFor(() => expect(screen.queryByText('UN1T Hatch Street')).toBeNull())
    expect(confirmSpy).toHaveBeenCalledTimes(2)
  })

  it('Connect shows the membership-source note when the studio was not switched', async () => {
    fetchMock.mockImplementation(async (url, init) => {
      if (init?.method === 'PUT') { current = connected(); return reply({ ...current, membership_source_set: false }) }
      return reply(current)
    })
    render(<Un1tOnlineIntegrationTab location={LOC} canEdit />)
    fireEvent.change(await screen.findByLabelText(/API token/i), { target: { value: TOKEN } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByText("Connected, but this studio's membership source was not switched to un1t.online. Set it on the Membership source card.")).toBeTruthy()
  })

  it('Connect shows no such note when the source was set', async () => {
    fetchMock.mockImplementation(async (url, init) => {
      if (init?.method === 'PUT') { current = connected(); return reply({ ...current, membership_source_set: true }) }
      return reply(current)
    })
    render(<Un1tOnlineIntegrationTab location={LOC} canEdit />)
    fireEvent.change(await screen.findByLabelText(/API token/i), { target: { value: TOKEN } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await screen.findByText('UN1T Hatch Street')
    expect(screen.queryByText(/was not switched to un1t\.online/)).toBeNull()
  })

  it('shows the route\'s readable message for a 409 (studio_changed)', async () => {
    fetchMock.mockImplementation(async (url, init) => (init?.method === 'PUT'
      ? { ok: false, status: 409, json: async () => ({ success: false, error: 'studio_changed', message: 'That token is for a different un1t.online studio.' }) }
      : reply(NOT_CONNECTED)))
    render(<Un1tOnlineIntegrationTab location={LOC} canEdit />)
    fireEvent.change(await screen.findByLabelText(/API token/i), { target: { value: TOKEN } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByText('That token is for a different un1t.online studio.')).toBeTruthy()
  })

  it('an unrecognised status renders a neutral chip, never "Connected"', async () => {
    current = connected({ status: 'mystery' })
    render(<Un1tOnlineIntegrationTab location={LOC} canEdit />)
    const chip = await screen.findByText('mystery')
    expect(chip.className).not.toMatch(/green/)
    expect(screen.queryByText('Connected')).toBeNull()
  })

  it('without edit rights it offers no actions', async () => {
    current = connected()
    render(<Un1tOnlineIntegrationTab location={LOC} canEdit={false} />)
    await screen.findByText('UN1T Hatch Street')
    expect(screen.queryByRole('button', { name: /Sync now|Disconnect/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull()
    expect(screen.queryByLabelText(/API token/i)).toBeNull()
  })
})

// UN1TWRITE.12 — the Writes section: masters only (the GET carries `write`
// only for them), the switch, the trial product picker and the permissions line.
describe('Un1tOnlineIntegrationTab — Writes (UN1TWRITE.12)', () => {
  const write = (over = {}) => ({
    writes_enabled: false, trial_product_id: null,
    trial_products: [{ un1t_id: 'p-trial', title: 'Trial' }],
    permissions: { all_present: true, missing: [] },
    ...over,
  })

  it('the Writes section shows only when the GET carries the write block (masters)', async () => {
    current = connected()
    render(<Un1tOnlineIntegrationTab location={LOC} canEdit />)
    await screen.findByText('UN1T Hatch Street')
    expect(screen.queryByText('Allow the CRM to write to un1t.online')).toBeNull()
    cleanup()
    current = connected({ write: write() })
    render(<Un1tOnlineIntegrationTab location={LOC} canEdit />)
    expect(await screen.findByText('Allow the CRM to write to un1t.online')).toBeTruthy()
    expect(screen.getByText('Write permissions: all present')).toBeTruthy()
  })

  it('the permissions line lists missing permissions, or says it could not check', async () => {
    current = connected({ write: write({ permissions: { all_present: false, missing: ['purchases:create', 'credits:read'] } }) })
    render(<Un1tOnlineIntegrationTab location={LOC} canEdit />)
    expect(await screen.findByText('Write permissions missing: purchases:create, credits:read')).toBeTruthy()
    cleanup()
    current = connected({ write: write({ permissions: { unreadable: true } }) })
    render(<Un1tOnlineIntegrationTab location={LOC} canEdit />)
    expect(await screen.findByText(/Write permissions could not be checked/)).toBeTruthy()
  })

  it('toggling the switch PATCHes writes_enabled; picking a product PATCHes trial_product_id', async () => {
    current = connected({ write: write() })
    fetchMock.mockImplementation(async (url, init) => {
      const method = init?.method || 'GET'
      if (method === 'PATCH') {
        const body = JSON.parse(init.body)
        current = connected({ write: write({ writes_enabled: body.writes_enabled ?? current.write.writes_enabled, trial_product_id: body.trial_product_id ?? current.write.trial_product_id }) })
        return reply({ write: current.write })
      }
      return reply(current)
    })
    render(<Un1tOnlineIntegrationTab location={LOC} canEdit />)
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Allow the CRM to write to un1t.online' }))
    await waitFor(() => expect(callsOf('PATCH')).toHaveLength(1))
    expect(JSON.parse(callsOf('PATCH')[0][1].body)).toEqual({ writes_enabled: true })
    fireEvent.change(screen.getByLabelText('Trial product'), { target: { value: 'p-trial' } })
    await waitFor(() => expect(callsOf('PATCH')).toHaveLength(2))
    expect(JSON.parse(callsOf('PATCH')[1][1].body)).toEqual({ trial_product_id: 'p-trial' })
  })

  it('an owner (no write block) is not told a write token is unsafe once writes are on', async () => {
    current = connected({ has_write_permissions: true, writes_enabled: true })
    render(<Un1tOnlineIntegrationTab location={LOC} canEdit />)
    await screen.findByText('UN1T Hatch Street')
    expect(screen.queryByText(/a read-only token is safer/)).toBeNull()
  })

  it('with writes on, the read-only token note is not shown (writes need a write token)', async () => {
    current = connected({ has_write_permissions: true, write: write({ writes_enabled: true }) })
    render(<Un1tOnlineIntegrationTab location={LOC} canEdit />)
    await screen.findByText('Allow the CRM to write to un1t.online')
    expect(screen.queryByText(/a read-only token is safer/)).toBeNull()
  })
})

describe('Un1tOnlineIntegrationTab — funnel settings (UN1TWRITE.24)', () => {
  const write = (over = {}) => ({
    writes_enabled: false, funnel_enabled: false, trial_product_id: null, trial_products: [],
    hidden_class_keywords: '', un1t_sends_welcome: false, un1t_welcome_sets_login: false, un1t_sends_booking_confirmation: false,
    permissions: { all_present: true, missing: [] }, ...over,
  })

  it('the funnel switch is disabled while writes are off', async () => {
    current = connected({ write: write() })
    render(<Un1tOnlineIntegrationTab location={LOC} canEdit />)
    const funnel = await screen.findByRole('checkbox', { name: 'Take new people through un1t.online' })
    expect(funnel.disabled).toBe(true)
    cleanup()
    current = connected({ write: write({ writes_enabled: true }) })
    render(<Un1tOnlineIntegrationTab location={LOC} canEdit />)
    expect((await screen.findByRole('checkbox', { name: 'Take new people through un1t.online' })).disabled).toBe(false)
  })

  it('the keyword box and the three flags PATCH their keys', async () => {
    current = connected({ write: write({ writes_enabled: true }) })
    fetchMock.mockImplementation(async (url, init) => {
      if ((init?.method || 'GET') === 'PATCH') return reply({ write: { ...current.write, ...JSON.parse(init.body) } })
      return reply(current)
    })
    render(<Un1tOnlineIntegrationTab location={LOC} canEdit />)
    const box = await screen.findByLabelText('Classes to hide from new people')
    fireEvent.change(box, { target: { value: 'elite' } })
    fireEvent.blur(box)
    await waitFor(() => expect(callsOf('PATCH')).toHaveLength(1))
    expect(JSON.parse(callsOf('PATCH')[0][1].body)).toEqual({ hidden_class_keywords: 'elite' })
    fireEvent.click(screen.getByRole('checkbox', { name: 'un1t.online sends its own welcome email' }))
    await waitFor(() => expect(callsOf('PATCH')).toHaveLength(2))
    expect(JSON.parse(callsOf('PATCH')[1][1].body)).toEqual({ un1t_sends_welcome: true })
  })

  it('the app link boxes PATCH app_links, and an emptied box sends null', async () => {
    current = connected({ write: write({ writes_enabled: true, app_links: { android_url: 'https://play.google.com/x' } }) })
    fetchMock.mockImplementation(async (url, init) => {
      if ((init?.method || 'GET') === 'PATCH') return reply({ write: { ...current.write } })
      return reply(current)
    })
    render(<Un1tOnlineIntegrationTab location={LOC} canEdit />)
    const ios = await screen.findByLabelText('App Store link')
    fireEvent.change(ios, { target: { value: 'https://apps.apple.com/x' } })
    fireEvent.blur(ios)
    await waitFor(() => expect(callsOf('PATCH')).toHaveLength(1))
    expect(JSON.parse(callsOf('PATCH')[0][1].body)).toEqual({ app_links: { ios_url: 'https://apps.apple.com/x' } })
    const play = screen.getByLabelText('Google Play link')
    fireEvent.change(play, { target: { value: '' } })
    fireEvent.blur(play)
    await waitFor(() => expect(callsOf('PATCH')).toHaveLength(2))
    expect(JSON.parse(callsOf('PATCH')[1][1].body)).toEqual({ app_links: { android_url: null } })
    expect(screen.getByLabelText('App section heading')).toBeTruthy()
    expect(screen.getByLabelText('App section text')).toBeTruthy()
  })
})
