// @vitest-environment jsdom
//
// EVENT-WAITLIST.1 — the signup widget shows the waitlist form when (and only
// when) the event is sold out, and a page opened from an offer link (?wl=)
// sends the token on register and says so.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import RaceSignupWidget from './RaceSignupWidget.jsx'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const base = {
  id: 'ev-1', name: 'Hatch Relay', slug: 'hatch-relay', kind: 'open_day', race_date: '2026-10-18',
  allowed_team_sizes: [1], member_pricing_enabled: false, non_member_fee_cents: null, payment_currency: 'EUR', members_only: false,
  waves: [{ id: 'w1', start_time: '11:00:00', label: null, is_full: false }],
}
const jsonRes = (body) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body })

function serve(data, onRegister) {
  const fetchMock = vi.fn((url, init) => {
    const u = String(url)
    if (u.endsWith('/register')) return Promise.resolve(jsonRes(onRegister ? onRegister(JSON.parse(init.body)) : { success: true, data: { registration_id: 'r1', payment: { free: true } } }))
    if (u.includes('/api/public/events/')) return Promise.resolve(jsonRes({ success: true, data }))
    return Promise.resolve(jsonRes({ success: false }))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/') })

describe('RaceSignupWidget — waitlist', () => {
  it('sold out: shows the waitlist form', async () => {
    serve({ ...base, registration_state: 'full', waves: [{ ...base.waves[0], is_full: true }] })
    render(<RaceSignupWidget slug="hatch-relay" />)
    expect(await screen.findByRole('form', { name: 'Join the waitlist' })).toBeTruthy()
  })

  it.each(['open', 'closed', 'not_yet_open'])('%s: no waitlist form', async (state) => {
    serve({ ...base, registration_state: state })
    render(<RaceSignupWidget slug="hatch-relay" />)
    await waitFor(() => { if (!document.getElementById('event-signup-form-hatch-relay')) throw new Error('not rendered') })
    expect(screen.queryByRole('form', { name: 'Join the waitlist' })).toBeNull()
  })

  it('opened from an offer link: says a spot opened and sends waitlist_token on register', async () => {
    window.history.replaceState({}, '', '/event/hatch-relay?wl=tok.sig')
    let sent = null
    serve({ ...base, registration_state: 'open' }, (body) => { sent = body; return { success: true, data: { registration_id: 'r1', payment: { free: true } } } })
    render(<RaceSignupWidget slug="hatch-relay" />)
    await screen.findByText(/A spot opened up\. Book now; first come, first served\./)
    const form = document.getElementById('event-signup-form-hatch-relay')
    const inputs = form.querySelectorAll('input')
    for (const el of inputs) {
      if (el.type === 'email') fireEvent.change(el, { target: { value: 'ann@example.test' } })
      else if (el.type === 'tel') fireEvent.change(el, { target: { value: '0870000000' } })
      else if (el.type === 'text' && !el.value) fireEvent.change(el, { target: { value: 'Ann Example' } })
    }
    fireEvent.submit(form)
    await waitFor(() => expect(sent).not.toBeNull())
    expect(sent.waitlist_token).toBe('tok.sig')
  })

  it('no offer link: no token on register', async () => {
    let sent = null
    serve({ ...base, registration_state: 'open' }, (body) => { sent = body; return { success: true, data: { registration_id: 'r1', payment: { free: true } } } })
    render(<RaceSignupWidget slug="hatch-relay" />)
    const form = await waitFor(() => { const f = document.getElementById('event-signup-form-hatch-relay'); if (!f) throw new Error('no form'); return f })
    for (const el of form.querySelectorAll('input')) {
      if (el.type === 'email') fireEvent.change(el, { target: { value: 'ann@example.test' } })
      else if (el.type === 'tel') fireEvent.change(el, { target: { value: '0870000000' } })
      else if (el.type === 'text' && !el.value) fireEvent.change(el, { target: { value: 'Ann Example' } })
    }
    fireEvent.submit(form)
    await waitFor(() => expect(sent).not.toBeNull())
    expect(sent).not.toHaveProperty('waitlist_token')
    expect(screen.queryByText(/A spot opened up/)).toBeNull()
  })
})
