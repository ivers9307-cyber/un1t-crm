// @vitest-environment jsdom
//
// MEMBERWRITESWEEP.1e — the campaign editor writes through its session routes.
//
// Until this PR every action here was a browser-direct read or write on
// `campaigns` (db.from('campaigns') via createBrowserClient), fenced only by
// the mig 014 membership policy. Mig 684 closes the table to every client
// session, so each action must now call its route, and a refusal from the
// route must reach the operator in the editor's error slot.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

const push = vi.fn()
const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }))
vi.mock('./AudienceBuilder', () => ({ default: () => <div data-testid="audience-builder" /> }))
vi.mock('./communications/SendQuietHoursNotice', () => ({ default: () => null }))

import CampaignEditor from './CampaignEditor.jsx'

const ID = 'c0000000-0000-4000-8000-000000000001'
const BASE = {
  id: ID,
  name: 'Weekend offer',
  subject: 'Last chance',
  status: 'draft',
  location_id: 'loc-1',
  html_content: '<html><body>hi</body></html>',
  design_json: null,
  audience_filter: { logic: 'and', filters: [] },
}

let routeCalls
let answer
function installFetch() {
  routeCalls = []
  answer = () => ({ status: 200, body: { success: true, data: { id: ID } } })
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const u = String(url)
    if (u.startsWith('/api/communications/campaigns')) {
      const call = { url: u, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined }
      routeCalls.push(call)
      const a = answer(call)
      return { ok: a.status < 400, status: a.status, json: async () => a.body }
    }
    return { ok: true, status: 200, json: async () => ({ success: true, audience_count: 10 }) }
  }))
}

const renderEditor = (overrides = {}, props = {}) =>
  render(<CampaignEditor campaign={overrides === null ? null : { ...BASE, ...overrides }} locationId="loc-1" userId="user-1" {...props} />)

const writes = () => routeCalls.filter((c) => c.method !== 'GET')

beforeEach(() => {
  vi.clearAllMocks()
  installFetch()
  vi.stubGlobal('confirm', vi.fn(() => true))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Save', () => {
  it('PUTs an existing campaign\'s content to its route, never created_by, status or location_id', async () => {
    renderEditor()
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(writes()).toHaveLength(1))
    const [put] = writes()
    expect(put.method).toBe('PUT')
    expect(put.url).toBe(`/api/communications/campaigns/${ID}`)
    expect(put.body).toMatchObject({
      name: 'Weekend offer', subject: 'Last chance', html_content: BASE.html_content,
      postmark_stream: 'broadcast', ab_subject_b: null, ab_test_pct: 10, ab_wait_hours: 4,
    })
    for (const k of ['created_by', 'status', 'location_id', 'scheduled_at']) expect(put.body).not.toHaveProperty(k)
    await screen.findByText(/^Saved /)
  })

  it('POSTs a new campaign with its studio, and adopts the id the route returns', async () => {
    const replace = vi.spyOn(window.history, 'replaceState')
    answer = () => ({ status: 200, body: { success: true, data: { id: 'new-id', status: 'draft', location_id: 'loc-1' } } })
    renderEditor(null)
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(writes()).toHaveLength(1))
    const [post] = writes()
    expect(post.method).toBe('POST')
    expect(post.url).toBe('/api/communications/campaigns')
    expect(post.body.location_id).toBe('loc-1')
    expect(post.body).not.toHaveProperty('created_by')
    await waitFor(() => expect(replace).toHaveBeenCalledWith(null, '', '/communications/sent/email/new-id'))
  })

  it('shows the route\'s refusal in the error slot', async () => {
    answer = () => ({ status: 409, body: { success: false, error: 'This campaign is sent, so its content is locked.', data: { status: 'sent' } } })
    renderEditor()
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    await screen.findByText('This campaign is sent, so its content is locked.')
  })

  it('shows a readable error when the answer is not JSON (a plain-text 413)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).startsWith('/api/communications/campaigns')) {
        return { ok: false, status: 413, json: async () => { throw new SyntaxError("Unexpected token 'R'") } }
      }
      return { ok: true, status: 200, json: async () => ({ success: true, audience_count: 10 }) }
    }))
    renderEditor()
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    await screen.findByText('Request failed (413)')
  })
})

describe('Schedule', () => {
  function scheduleFor(localValue) {
    fireEvent.click(screen.getByTitle('Send at a later date and time'))
    fireEvent.change(document.querySelector('input[type="datetime-local"]'), { target: { value: localValue } })
    const tray = screen.getAllByRole('button', { name: /Schedule/ }).find((b) => !b.title)
    fireEvent.click(tray)
  }

  it('saves, then POSTs scheduled_at to the schedule route', async () => {
    answer = (call) => (call.url.endsWith('/schedule')
      ? { status: 200, body: { success: true, data: { status: 'scheduled', scheduled_at: '2099-01-01T09:00:00.000Z' } } }
      : { status: 200, body: { success: true, data: { id: ID } } })
    renderEditor()
    scheduleFor('2099-01-01T09:00')
    await waitFor(() => expect(writes()).toHaveLength(2))
    const [save, schedule] = writes()
    expect(save.method).toBe('PUT')
    expect(schedule).toMatchObject({ method: 'POST', url: `/api/communications/campaigns/${ID}/schedule` })
    expect(schedule.body).toEqual({ scheduled_at: new Date('2099-01-01T09:00').toISOString() })
    await waitFor(() => expect(screen.getByTestId('campaign-status-pill').textContent).toMatch(/scheduled/i))
  })

  it('does not schedule when the save failed', async () => {
    answer = () => ({ status: 500, body: { success: false, error: 'Could not save' } })
    renderEditor()
    scheduleFor('2099-01-01T09:00')
    await screen.findByText('Could not save')
    expect(writes().map((c) => c.url)).toEqual([`/api/communications/campaigns/${ID}`])
  })

  it('shows the route\'s refusal (the send route\'s body guard)', async () => {
    answer = (call) => (call.url.endsWith('/schedule')
      ? { status: 400, body: { success: false, error: 'This campaign has no email body — nothing was queued. Open it in the editor and add content.' } }
      : { status: 200, body: { success: true, data: { id: ID } } })
    renderEditor()
    scheduleFor('2099-01-01T09:00')
    await screen.findByText(/has no email body/)
    expect(screen.getByTestId('campaign-status-pill').textContent).toMatch(/draft/i)
  })
})

describe('Stop', () => {
  it('Unschedule POSTs to the stop route and returns the editor to draft', async () => {
    answer = () => ({ status: 200, body: { success: true, data: { status: 'draft', cancel_requested_at: null } } })
    renderEditor({ status: 'scheduled', scheduled_at: '2099-01-01T09:00:00.000Z' })
    fireEvent.click(screen.getByRole('button', { name: /Unschedule/ }))
    await waitFor(() => expect(writes()).toEqual([{ method: 'POST', url: `/api/communications/campaigns/${ID}/stop`, body: undefined }]))
    await waitFor(() => expect(screen.getByTestId('campaign-status-pill').textContent).toMatch(/draft/i))
    expect(refresh).toHaveBeenCalled()
  })

  it('Cancel on a queued campaign POSTs to the stop route and shows Cancelling', async () => {
    answer = (call) => (call.method === 'GET'
      ? { status: 200, body: { success: true, data: { status: 'queued', total_sent: 0, total_recipients: 10, cancel_requested_at: null } } }
      : { status: 200, body: { success: true, data: { status: 'queued', cancel_requested_at: '2099-01-01T00:00:00.000Z' } } })
    renderEditor({ status: 'queued' })
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }))
    await waitFor(() => expect(writes().map((c) => c.url)).toEqual([`/api/communications/campaigns/${ID}/stop`]))
    await screen.findByText('Cancelling…')
  })

  it('shows the route\'s refusal', async () => {
    answer = (call) => (call.method === 'GET'
      ? { status: 200, body: { success: true, data: { status: 'scheduled', total_sent: 0, total_recipients: 0, cancel_requested_at: null } } }
      : { status: 409, body: { success: false, error: "The campaign's status changed; reload.", data: { status: 'queued' } } })
    renderEditor({ status: 'scheduled' })
    fireEvent.click(screen.getByRole('button', { name: /Unschedule/ }))
    await screen.findByText("The campaign's status changed; reload.")
  })
})

describe('Progress poll', () => {
  it('reads the progress from the route (GET), not from the database', async () => {
    answer = () => ({ status: 200, body: { success: true, data: { status: 'sending', total_sent: 5, total_recipients: 10, cancel_requested_at: null } } })
    renderEditor({ status: 'queued' })
    await screen.findByText('Sending 5 / 10')
    expect(routeCalls[0]).toEqual({ method: 'GET', url: `/api/communications/campaigns/${ID}`, body: undefined })
  })

  it('keeps the last good state when a poll fails', async () => {
    answer = () => ({ status: 500, body: { success: false, error: 'boom' } })
    renderEditor({ status: 'queued' })
    await waitFor(() => expect(routeCalls.length).toBeGreaterThan(0))
    expect(screen.getByText('Queued — sending will start within 60s')).toBeTruthy()
  })
})

describe('the editor no longer holds a database client', () => {
  it('imports no browser Supabase client', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(`${process.cwd()}/src/components/CampaignEditor.jsx`, 'utf8')
    expect(src).not.toMatch(/createBrowserClient|from '@\/lib\/supabase'/)
  })
})
