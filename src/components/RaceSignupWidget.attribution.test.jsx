// @vitest-environment jsdom
// HOSTSTATS.1 — the signup widget records the page view on mount (with the
// tab's first-touch attribution) and sends the same attribution with the
// registration; a tab whose storage is unusable does neither, quietly.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import RaceSignupWidget from './RaceSignupWidget.jsx'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const HC = '80000000-0000-4000-8000-000000000001'
const RACE = {
  id: 'ev-1', name: 'Mobility', slug: 'mob', kind: 'workshop', race_date: '2026-12-05',
  allowed_team_sizes: [1], capacity_mode: 'people',
  waves: [{ id: 'w1', start_time: '10:00:00', label: null, is_full: false }],
  registration_state: 'open', payment_currency: 'EUR', members_only: false, organization_name: 'UN1T',
  member_pricing_enabled: false, member_fee_cents: null, non_member_fee_cents: 0,
}
const jsonRes = (body) => ({ ok: true, status: 200, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) }, json: async () => body })
function serve(data) {
  const fetchMock = vi.fn((url) => {
    if (String(url).endsWith('/register')) return Promise.resolve(jsonRes({ success: true, data: { registration_id: 'r1', payment: { free: true } } }))
    if (String(url).endsWith('/view')) return Promise.resolve(jsonRes({ success: true, data: { recorded: true } }))
    return Promise.resolve(jsonRes({ success: true, data }))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
async function renderWidget() {
  const fetchMock = serve(RACE)
  render(<RaceSignupWidget slug="mob" />)
  await screen.findByPlaceholderText('Your email *')
  return fetchMock
}
const viewCall = (m) => m.mock.calls.find(([u]) => String(u).endsWith('/view'))
const registerCall = (m) => m.mock.calls.find(([u]) => String(u).endsWith('/register'))
async function submit(fetchMock) {
  const form = document.getElementById('event-signup-form-mob')
  for (const el of form.querySelectorAll('input')) {
    if (el.type === 'email') fireEvent.change(el, { target: { value: 'ann@example.test' } })
    else if (el.type === 'tel') fireEvent.change(el, { target: { value: '0870000000' } })
    else if (el.type === 'text' && !el.value) fireEvent.change(el, { target: { value: 'Ann Example' } })
  }
  fireEvent.submit(form)
  await waitFor(() => expect(registerCall(fetchMock)).toBeTruthy())
  return JSON.parse(registerCall(fetchMock)[1].body)
}

beforeEach(() => {
  window.sessionStorage.clear()
  window.history.replaceState({}, '', `/event/mob?utm_source=instagram&hc=${HC}`)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('RaceSignupWidget — page view + attribution', () => {
  it('posts one view on mount with the tab session and the URL attribution, then sends the same attribution on register', async () => {
    const fetchMock = await renderWidget()
    await waitFor(() => expect(viewCall(fetchMock)).toBeTruthy())
    const view = JSON.parse(viewCall(fetchMock)[1].body)
    expect(view.session_id).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(view.attribution).toMatchObject({ session_id: view.session_id, utm_source: 'instagram', hc: HC })
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/view')).length).toBe(1)
    const body = await submit(fetchMock)
    expect(body.attribution).toMatchObject({ session_id: view.session_id, hc: HC })
  })
  it('with storage unusable: no view call, attribution null on register, nothing throws', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    const fetchMock = await renderWidget()
    const body = await submit(fetchMock)
    expect(viewCall(fetchMock)).toBeUndefined()
    expect(body.attribution).toBeNull()
  })
})
