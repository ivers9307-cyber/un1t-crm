// @vitest-environment jsdom
// EVENT-MOVE.1 — the move dialog: loads targets, shows the gap and the studio
// notice, posts the move, and turns a wave_full answer into Move anyway / Don't move.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import MoveEntryDialog from './MoveEntryDialog.jsx'

const TARGETS = {
  entry: { id: 'r1', label: 'The Crushers', headcount: 2, status: 'confirmed', lead_first_name: 'Aoife' },
  source: { event_id: 'e1', event_name: 'Hatch Oct 18', race_date: '2026-10-18', wave_id: 'w1', location_id: 'L1' },
  targets: [
    { id: 'e2', name: 'Hatch Oct 25', race_date: '2026-10-25', location_id: 'L1', location_name: 'Hatch St', crosses_studio: false, price_gap_cents: 1000, currency: 'EUR',
      waves: [{ id: 'w9', start_time: '11:00:00', label: null, capacity: 10, spots_left: 6 }, { id: 'w10', start_time: '12:30:00', label: null, capacity: 10, spots_left: 0 }] },
    { id: 'e4', name: 'Stillorgan Nov 1', race_date: '2026-11-01', location_id: 'L2', location_name: 'Stillorgan', crosses_studio: true, price_gap_cents: 0, currency: 'EUR', waves: [] },
  ],
}
const registration = { id: 'r1', status: 'confirmed', teams: { name: 'The Crushers', size: 2, team_members: [{ name: 'Aoife', role: 'captain', email: 'a@x.ie' }, { name: 'Dan' }] } }

// A response is { status, body }, { status, notJson: true } (an HTML error
// page: json() rejects), or { throws: Error } (the request never answered).
function stubFetch(responses) {
  const fetchMock = vi.fn(async () => {
    const r = responses.shift()
    if (r.throws) throw r.throws
    return { ok: r.status < 400, status: r.status, json: async () => { if (r.notJson) throw new SyntaxError('Unexpected token <'); return r.body } }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('MoveEntryDialog', () => {
  it('lists targets, shows the price gap, and posts the move', async () => {
    const fetchMock = stubFetch([{ status: 200, body: { success: true, data: TARGETS } }, { status: 200, body: { success: true, data: {} } }])
    const onMoved = vi.fn()
    render(<MoveEntryDialog open registration={registration} onClose={() => {}} onMoved={onMoved} onError={() => {}} />)
    await screen.findByText(/Move The Crushers to another event/)
    fireEvent.change(screen.getByLabelText(/Target event/), { target: { value: 'e2' } })
    fireEvent.change(screen.getByLabelText(/^Time|^Wave/), { target: { value: 'w9' } })
    expect(screen.getByText(/€5\.00 more per person/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Move entry$/ }))
    await waitFor(() => expect(onMoved).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe('/api/event-registrations/r1/move')
    expect(JSON.parse(init.body)).toMatchObject({ target_event_id: 'e2', target_wave_id: 'w9', notify: true, force: false })
  })
  it('names the studio when the move crosses one', async () => {
    stubFetch([{ status: 200, body: { success: true, data: TARGETS } }])
    render(<MoveEntryDialog open registration={registration} onClose={() => {}} onMoved={() => {}} onError={() => {}} />)
    await screen.findByText(/Move The Crushers/)
    fireEvent.change(screen.getByLabelText(/Target event/), { target: { value: 'e4' } })
    expect(screen.getByText(/moves the entry to Stillorgan/)).toBeTruthy()
  })
  it('wave_full offers Move anyway, which resends with force', async () => {
    const fetchMock = stubFetch([
      { status: 200, body: { success: true, data: TARGETS } },
      { status: 409, body: { success: false, error: 'wave_full', spots_left: 0, message: 'That time is full.' } },
      { status: 200, body: { success: true, data: {} } },
    ])
    const onMoved = vi.fn()
    render(<MoveEntryDialog open registration={registration} onClose={() => {}} onMoved={onMoved} onError={() => {}} />)
    await screen.findByText(/Move The Crushers/)
    fireEvent.change(screen.getByLabelText(/Target event/), { target: { value: 'e2' } })
    fireEvent.change(screen.getByLabelText(/^Time|^Wave/), { target: { value: 'w10' } })
    fireEvent.click(screen.getByRole('button', { name: /^Move entry$/ }))
    await screen.findByText(/This time is full/)
    fireEvent.click(screen.getByRole('button', { name: /Move anyway/ }))
    await waitFor(() => expect(onMoved).toHaveBeenCalled())
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).force).toBe(true)
  })
  it("Don't move returns to the form without posting again", async () => {
    const fetchMock = stubFetch([
      { status: 200, body: { success: true, data: TARGETS } },
      { status: 409, body: { success: false, error: 'wave_full', spots_left: 0, message: 'That time is full.' } },
    ])
    render(<MoveEntryDialog open registration={registration} onClose={() => {}} onMoved={() => {}} onError={() => {}} />)
    await screen.findByText(/Move The Crushers/)
    fireEvent.change(screen.getByLabelText(/Target event/), { target: { value: 'e2' } })
    fireEvent.change(screen.getByLabelText(/^Time|^Wave/), { target: { value: 'w10' } })
    fireEvent.click(screen.getByRole('button', { name: /^Move entry$/ }))
    await screen.findByText(/This time is full/)
    fireEvent.click(screen.getByRole('button', { name: /Don't move/ }))
    expect(screen.getByRole('button', { name: /^Move entry$/ })).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('says so when nothing is eligible', async () => {
    stubFetch([{ status: 200, body: { success: true, data: { ...TARGETS, targets: [] } } }])
    render(<MoveEntryDialog open registration={registration} onClose={() => {}} onMoved={() => {}} onError={() => {}} />)
    await screen.findByText(/No other upcoming events are paid to the same host/)
  })
  it('a conflict shows its message in the form, not the full-time choice', async () => {
    const fetchMock = stubFetch([
      { status: 200, body: { success: true, data: TARGETS } },
      { status: 409, body: { success: false, error: 'conflict', message: 'This entry changed while you were moving it. Reload and try again.' } },
    ])
    const onMoved = vi.fn()
    render(<MoveEntryDialog open registration={registration} onClose={() => {}} onMoved={onMoved} onError={() => {}} />)
    await screen.findByText(/Move The Crushers/)
    fireEvent.change(screen.getByLabelText(/Target event/), { target: { value: 'e2' } })
    fireEvent.change(screen.getByLabelText(/^Time|^Wave/), { target: { value: 'w9' } })
    fireEvent.click(screen.getByRole('button', { name: /^Move entry$/ }))
    await screen.findByText(/This entry changed while you were moving it/)
    expect(screen.queryByText(/This time is full/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Move anyway/ })).toBeNull()
    expect(screen.getByRole('button', { name: /^Move entry$/ })).toBeTruthy()
    expect(onMoved).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('tells staff when the customer could not be emailed, then closes as moved', async () => {
    stubFetch([
      { status: 200, body: { success: true, data: TARGETS } },
      { status: 200, body: { success: true, data: { move: { id: 'mv1' }, registration: { id: 'r1' }, notified: false } } },
    ])
    const calls = []
    const onMoved = vi.fn(() => calls.push('moved'))
    const onNotice = vi.fn(() => calls.push('notice'))
    const onError = vi.fn()
    render(<MoveEntryDialog open registration={registration} onClose={() => {}} onMoved={onMoved} onError={onError} onNotice={onNotice} />)
    await screen.findByText(/Move The Crushers/)
    fireEvent.change(screen.getByLabelText(/Target event/), { target: { value: 'e2' } })
    fireEvent.change(screen.getByLabelText(/^Time|^Wave/), { target: { value: 'w9' } })
    fireEvent.click(screen.getByRole('button', { name: /^Move entry$/ }))
    await waitFor(() => expect(onMoved).toHaveBeenCalled())
    expect(onNotice).toHaveBeenCalledWith('Moved. The customer could not be emailed; tell them yourself.')
    expect(onError).not.toHaveBeenCalled()
    expect(calls).toEqual(['notice', 'moved'])
  })
  it('says nothing about email when staff chose not to send one', async () => {
    const fetchMock = stubFetch([
      { status: 200, body: { success: true, data: TARGETS } },
      { status: 200, body: { success: true, data: { move: { id: 'mv1' }, registration: { id: 'r1' }, notified: false } } },
    ])
    const onMoved = vi.fn()
    const onError = vi.fn()
    const onNotice = vi.fn()
    render(<MoveEntryDialog open registration={registration} onClose={() => {}} onMoved={onMoved} onError={onError} onNotice={onNotice} />)
    await screen.findByText(/Move The Crushers/)
    fireEvent.change(screen.getByLabelText(/Target event/), { target: { value: 'e2' } })
    fireEvent.change(screen.getByLabelText(/^Time|^Wave/), { target: { value: 'w9' } })
    fireEvent.click(screen.getByLabelText(/Email Aoife/))
    fireEvent.click(screen.getByRole('button', { name: /^Move entry$/ }))
    await waitFor(() => expect(onMoved).toHaveBeenCalled())
    expect(onError).not.toHaveBeenCalled()
    expect(onNotice).not.toHaveBeenCalled()
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).notify).toBe(false)
  })

  async function pickAndMove(eventId = 'e2', waveId = 'w9') {
    await screen.findByText(/to another event/)
    fireEvent.change(screen.getByLabelText(/Target event/), { target: { value: eventId } })
    if (waveId) fireEvent.change(screen.getByLabelText(/^Time$/), { target: { value: waveId } })
    fireEvent.click(screen.getByRole('button', { name: /^Move entry$/ }))
  }

  it('a POST that answers non-JSON stays in the dialog with a reload-and-check message', async () => {
    stubFetch([{ status: 200, body: { success: true, data: TARGETS } }, { status: 502, notJson: true }])
    const onError = vi.fn(); const onMoved = vi.fn()
    render(<MoveEntryDialog open registration={registration} onClose={() => {}} onMoved={onMoved} onError={onError} />)
    await pickAndMove()
    const msg = await screen.findByText('The server did not answer clearly (status 502). Reload the page to check whether the entry moved before trying again.')
    expect(msg.closest('[role="alert"]')).toBeTruthy()
    expect(onError).not.toHaveBeenCalled()
    expect(onMoved).not.toHaveBeenCalled()
  })
  it('a POST that throws stays in the dialog, never the page banner', async () => {
    stubFetch([{ status: 200, body: { success: true, data: TARGETS } }, { throws: new TypeError('Failed to fetch') }])
    const onError = vi.fn()
    render(<MoveEntryDialog open registration={registration} onClose={() => {}} onMoved={() => {}} onError={onError} />)
    await pickAndMove()
    const msg = await screen.findByText(/Failed to fetch/)
    expect(msg.closest('[role="alert"]')).toBeTruthy()
    expect(onError).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /^Move entry$/ })).toBeTruthy()
  })
  it('a targets GET that answers non-JSON shows a load error', async () => {
    stubFetch([{ status: 500, notJson: true }])
    render(<MoveEntryDialog open registration={registration} onClose={() => {}} onMoved={() => {}} onError={() => {}} />)
    const msg = await screen.findByText(/Could not load events \(500\)/)
    expect(msg.closest('[role="alert"]')).toBeTruthy()
  })
  it('a targets GET refusal shows its plain-English message', async () => {
    stubFetch([{ status: 404, body: { success: false, error: 'not_found', message: 'That entry no longer exists.' } }])
    render(<MoveEntryDialog open registration={registration} onClose={() => {}} onMoved={() => {}} onError={() => {}} />)
    await screen.findByText('That entry no longer exists.')
  })
  it('Move anyway answered by a conflict drops the full-time choice and shows the message', async () => {
    stubFetch([
      { status: 200, body: { success: true, data: TARGETS } },
      { status: 409, body: { success: false, error: 'wave_full', spots_left: 0, message: 'That time is full.' } },
      { status: 409, body: { success: false, error: 'conflict', message: 'This entry changed while you were moving it. Reload and try again.' } },
    ])
    render(<MoveEntryDialog open registration={registration} onClose={() => {}} onMoved={() => {}} onError={() => {}} />)
    await pickAndMove('e2', 'w10')
    const full = await screen.findByText(/This time is full/)
    expect(full.closest('[role="alert"]')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Move anyway/ }))
    const msg = await screen.findByText(/This entry changed while you were moving it/)
    expect(msg.closest('[role="alert"]')).toBeTruthy()
    expect(screen.queryByText(/This time is full/)).toBeNull()
    expect(screen.getByRole('button', { name: /^Move entry$/ })).toBeTruthy()
  })
  it('names the email recipient from the server, else "the customer"', async () => {
    stubFetch([{ status: 200, body: { success: true, data: { ...TARGETS, entry: { ...TARGETS.entry, lead_first_name: 'Ciara' } } } }])
    render(<MoveEntryDialog open registration={registration} onClose={() => {}} onMoved={() => {}} onError={() => {}} />)
    expect(await screen.findByLabelText(/Email Ciara the new tickets/)).toBeTruthy()
    cleanup()
    stubFetch([{ status: 200, body: { success: true, data: { ...TARGETS, entry: { ...TARGETS.entry, lead_first_name: null } } } }])
    render(<MoveEntryDialog open registration={registration} onClose={() => {}} onMoved={() => {}} onError={() => {}} />)
    expect(await screen.findByLabelText(/Email the customer the new tickets/)).toBeTruthy()
  })
  it('a cross-studio move of a team says the team is copied; a solo entry does not', async () => {
    stubFetch([{ status: 200, body: { success: true, data: TARGETS } }])
    render(<MoveEntryDialog open registration={registration} onClose={() => {}} onMoved={() => {}} onError={() => {}} />)
    await screen.findByText(/to another event/)
    fireEvent.change(screen.getByLabelText(/Target event/), { target: { value: 'e4' } })
    expect(screen.getByText(/The Crushers is copied there\./)).toBeTruthy()
    cleanup()
    const solo = { id: 'r2', status: 'confirmed', teams: { name: 'Mark Kelly', size: 1, team_members: [{ name: 'Mark Kelly', role: 'captain', email: 'm@x.ie' }] } }
    stubFetch([{ status: 200, body: { success: true, data: { ...TARGETS, entry: { id: 'r2', label: 'Mark Kelly', headcount: 1, status: 'confirmed', lead_first_name: 'Mark' } } } }])
    render(<MoveEntryDialog open registration={solo} onClose={() => {}} onMoved={() => {}} onError={() => {}} />)
    await screen.findByText(/Move Mark Kelly to another event/)
    fireEvent.change(screen.getByLabelText(/Target event/), { target: { value: 'e4' } })
    expect(screen.getByText(/moves the entry to Stillorgan/)).toBeTruthy()
    expect(screen.queryByText(/copied there/)).toBeNull()
  })
  it('a cheaper target says less per person and that nothing is refunded', async () => {
    const cheaper = { ...TARGETS, targets: [{ ...TARGETS.targets[0], price_gap_cents: -1000 }] }
    stubFetch([{ status: 200, body: { success: true, data: cheaper } }])
    render(<MoveEntryDialog open registration={registration} onClose={() => {}} onMoved={() => {}} onError={() => {}} />)
    await screen.findByText(/to another event/)
    fireEvent.change(screen.getByLabelText(/Target event/), { target: { value: 'e2' } })
    expect(screen.getByText(/€5\.00 less per person \(€10\.00 for this entry\)/)).toBeTruthy()
    expect(screen.getByText(/Nothing is refunded by this move/)).toBeTruthy()
  })
  it('never imports server code into the client bundle', () => {
    const src = readFileSync(path.resolve(process.cwd(), 'src/components/MoveEntryDialog.jsx'), 'utf8')
    expect(src).not.toMatch(/from\s+['"]@\/lib\/registration-move['"]/)
    expect(src).not.toMatch(/from\s+['"]@\/lib\/supabase['"]/)
    expect(src).not.toMatch(/import\(\s*['"]@\/lib\/(registration-move|supabase)['"]/)
  })
})
