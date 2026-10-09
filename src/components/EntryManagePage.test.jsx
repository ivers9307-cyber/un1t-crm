// @vitest-environment jsdom
// EVENT-MOVE.6 — the customer's own entry page (/event/entry/[token]): shows
// the entry, lists the dates they may move to with no capacity numbers, moves
// at once when the price is the same or lower, sends them to checkout when it
// is higher, and says plainly why an entry cannot move.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import EntryManagePage from './EntryManagePage.jsx'

const TOKEN = 'tok.sig'
const ENTRY = {
  id: 'r1', status: 'confirmed', can_move: true, move_blocked_reason: null, date_change_pending: false,
  race: { id: 'e1', name: 'Hatch Oct 18', kind: 'hyrox_sim', race_date: '2026-10-18', locations: { name: 'UN1T Hatch' } },
  wave: { id: 'w1', start_time: '11:00:00', label: null },
  team: { id: 't1', name: 'The Crushers', size: 2, team_members: [
    { id: 'm1', name: 'Aoife Byrne', role: 'captain', is_member: true },
    { id: 'm2', name: 'Dan Walsh', role: 'member', is_member: false },
  ] },
}
const MOVED_ENTRY = { ...ENTRY, race: { ...ENTRY.race, name: 'Hatch Oct 25', race_date: '2026-10-25' } }
const OPTIONS = {
  can_move: true, move_blocked_reason: null,
  options: [
    { event_id: 'e2', name: 'Hatch Oct 25', race_date: '2026-10-25', location_name: 'UN1T Hatch', price_difference_cents: 0, currency: 'EUR', price_note: 'Same price',
      times: [{ wave_id: 'w9', start_time: '09:00', label: null }, { wave_id: 'w10', start_time: '11:00', label: 'Heat B' }] },
    { event_id: 'e3', name: 'Stillorgan Nov 1', race_date: '2026-11-01', location_name: 'UN1T Stillorgan', price_difference_cents: 1000, currency: 'EUR', price_note: '€10.00 more, paid before the move',
      times: [{ wave_id: 'w20', start_time: '10:00', label: null }] },
    { event_id: 'e4', name: 'Open Day', race_date: '2026-11-08', location_name: 'UN1T Hatch', price_difference_cents: -500, currency: 'EUR', price_note: '€5.00 less, not refunded', times: [] },
  ],
}

// Routes by URL + method so the order of calls does not matter.
function stubFetch(handlers) {
  const calls = []
  const fetchMock = vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET'
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : null })
    const key = `${method} ${url}`
    const h = handlers[key]
    const r = typeof h === 'function' ? h(calls) : h
    if (!r) throw new Error(`unexpected ${key}`)
    return { ok: r.status < 400, status: r.status, json: async () => r.body }
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, calls }
}
const ok = (data) => ({ status: 200, body: { success: true, data } })
const ENTRY_URL = `GET /api/public/entry/${TOKEN}`
const OPTIONS_URL = `GET /api/public/entry/${TOKEN}/move-options`
const MOVE_URL = `POST /api/public/entry/${TOKEN}/move`

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('EntryManagePage', () => {
  it('shows the entry and the options, with no number that reads as capacity', async () => {
    stubFetch({ [ENTRY_URL]: ok(ENTRY), [OPTIONS_URL]: ok(OPTIONS) })
    const { container } = render(<EntryManagePage token={TOKEN} />)
    await screen.findByText('Stillorgan Nov 1')
    expect(screen.getAllByText('Hatch Oct 18').length).toBeGreaterThan(0)
    expect(screen.getByText(/Aoife Byrne/)).toBeTruthy()
    expect(screen.getByText('Same price')).toBeTruthy()
    expect(screen.getByText('€10.00 more, paid before the move')).toBeTruthy()
    expect(screen.getByText('€5.00 less, not refunded')).toBeTruthy()
    const text = container.textContent
    expect(text).not.toMatch(/spot|capacity|left|places|remaining|full/i)
    expect(text).not.toMatch(/—|–/)
  })

  it('a dearer date: confirms the amount, posts, and goes to the checkout', async () => {
    const { calls } = stubFetch({
      [ENTRY_URL]: ok(ENTRY), [OPTIONS_URL]: ok(OPTIONS),
      [MOVE_URL]: ok({ moved: false, pay_url: 'https://crm.test/event-pay/gp1' }),
    })
    const navigate = vi.fn()
    render(<EntryManagePage token={TOKEN} navigate={navigate} />)
    fireEvent.click(await screen.findByRole('button', { name: /10:00/ }))
    expect(await screen.findByText(/€10\.00 more/, { selector: '[data-confirm] *' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Pay €10\.00 and move/ }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://crm.test/event-pay/gp1'))
    expect(calls.find((c) => c.method === 'POST').body).toEqual({ target_event_id: 'e3', target_wave_id: 'w20' })
  })

  it('the same price: posts, re-reads the entry and says the new tickets are on their way', async () => {
    let entryReads = 0
    const { calls } = stubFetch({
      [ENTRY_URL]: () => { entryReads += 1; return ok(entryReads === 1 ? ENTRY : MOVED_ENTRY) },
      [OPTIONS_URL]: ok(OPTIONS),
      [MOVE_URL]: ok({ moved: true, registration: { id: 'r1', race_event_id: 'e2', wave_id: 'w10' }, notified: true }),
    })
    const navigate = vi.fn()
    render(<EntryManagePage token={TOKEN} navigate={navigate} />)
    fireEvent.click(await screen.findByRole('button', { name: /Heat B/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Move my entry$/ }))
    await screen.findByText('Moved. New tickets are on their way by email.')
    expect(entryReads).toBe(2)
    expect(calls.find((c) => c.method === 'POST').body).toEqual({ target_event_id: 'e2', target_wave_id: 'w10' })
    expect(navigate).not.toHaveBeenCalled()
  })

  it('an event with no times is chosen as a whole (no time sent)', async () => {
    const { calls } = stubFetch({
      [ENTRY_URL]: ok(ENTRY), [OPTIONS_URL]: ok(OPTIONS),
      [MOVE_URL]: ok({ moved: true, registration: { id: 'r1' }, notified: true }),
    })
    render(<EntryManagePage token={TOKEN} />)
    fireEvent.click(await screen.findByRole('button', { name: /Choose Open Day/ }))
    expect(screen.getByText(/not refunded/, { selector: '[data-confirm] *' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Move my entry$/ }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    expect(calls.find((c) => c.method === 'POST').body).toEqual({ target_event_id: 'e4', target_wave_id: null })
  })

  it('Back closes the confirm without posting', async () => {
    const { calls } = stubFetch({ [ENTRY_URL]: ok(ENTRY), [OPTIONS_URL]: ok(OPTIONS) })
    render(<EntryManagePage token={TOKEN} />)
    fireEvent.click(await screen.findByRole('button', { name: /09:00/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Back$/ }))
    expect(screen.queryByRole('button', { name: /^Move my entry$/ })).toBeNull()
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('a refusal shows the server\'s message inline and keeps the page', async () => {
    stubFetch({
      [ENTRY_URL]: ok(ENTRY), [OPTIONS_URL]: ok(OPTIONS),
      [MOVE_URL]: { status: 409, body: { success: false, error: 'wave_full', message: 'That time has just filled up. Pick another one.' } },
    })
    render(<EntryManagePage token={TOKEN} />)
    fireEvent.click(await screen.findByRole('button', { name: /09:00/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Move my entry$/ }))
    await screen.findByText('That time has just filled up. Pick another one.')
    expect(screen.getByText('Stillorgan Nov 1')).toBeTruthy()
  })

  it('a blocked entry shows why and offers no dates (options never fetched)', async () => {
    const { calls } = stubFetch({
      [ENTRY_URL]: ok({ ...ENTRY, can_move: false, move_blocked_reason: 'This entry has already been checked in, so its date cannot be changed.' }),
    })
    render(<EntryManagePage token={TOKEN} />)
    await screen.findByText('This entry has already been checked in, so its date cannot be changed.')
    expect(calls.some((c) => c.url.endsWith('/move-options'))).toBe(false)
    expect(screen.queryByRole('button', { name: /Choose|09:00/ })).toBeNull()
  })

  it('a bad link says so', async () => {
    stubFetch({ [ENTRY_URL]: { status: 404, body: { success: false, error: 'not_found', message: 'This link is not valid any more.' } } })
    render(<EntryManagePage token={TOKEN} />)
    await screen.findByText('This link is not valid any more.')
  })

  it('a paid date change still settling says so', async () => {
    stubFetch({ [ENTRY_URL]: ok({ ...ENTRY, date_change_pending: true }), [OPTIONS_URL]: ok(OPTIONS) })
    render(<EntryManagePage token={TOKEN} />)
    await screen.findByText(/If you have just paid/)
  })

  it('no other dates: a plain line, no options', async () => {
    stubFetch({ [ENTRY_URL]: ok(ENTRY), [OPTIONS_URL]: ok({ can_move: true, move_blocked_reason: null, options: [] }) })
    render(<EntryManagePage token={TOKEN} />)
    await screen.findByText(/no other dates you can move to right now/i)
  })
})
