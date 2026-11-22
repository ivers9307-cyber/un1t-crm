// @vitest-environment jsdom
//
// SEQSTART.1 — an audience-match flow enrols nobody until someone starts it
// with the exact number of people who match. This panel is the only caller of
// POST/DELETE /api/sequences/[id]/audience/seed.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor, screen } from '@testing-library/react'
import AudienceMatchStart from './AudienceMatchStart.jsx'
import { COOLDOWN_HINT } from './SequenceSettings.jsx'

const SEQ = { id: 'seq-1', status: 'active', audience_seeded_at: null, audience_seed_count: null }
const reply = (status, body) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) })

let fetchMock
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const startButton = () => screen.getByRole('button', { name: /start/i })

describe('AudienceMatchStart', () => {
  it('waits for the count before it can start', () => {
    render(<AudienceMatchStart sequence={SEQ} matchingCount={null} />)
    expect(startButton().disabled).toBe(true)
    expect(screen.getByText(/counting who matches/i)).toBeTruthy()
  })

  it('cannot start with unsaved settings, or with nobody matching', () => {
    const { rerender } = render(<AudienceMatchStart sequence={SEQ} matchingCount={12} dirty />)
    expect(startButton().disabled).toBe(true)
    expect(screen.getByText(/save your settings first/i)).toBeTruthy()
    rerender(<AudienceMatchStart sequence={SEQ} matchingCount={0} />)
    expect(startButton().disabled).toBe(true)
    expect(screen.getByText(/nobody matches/i)).toBeTruthy()
  })

  it('starts with the exact count shown and then says it started', async () => {
    fetchMock.mockReturnValue(reply(200, { success: true, data: { matching: 12, seeded_at: '2026-11-15T12:00:00Z', approx_minutes: 5 } }))
    render(<AudienceMatchStart sequence={SEQ} matchingCount={12} />)
    expect(startButton().textContent).toContain('Start for 12 people')
    fireEvent.click(startButton())
    await waitFor(() => expect(screen.getByText(/started\. enrolling 12/i)).toBeTruthy())
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/sequences/seq-1/audience/seed')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ confirm_count: 12 })
    expect(screen.getByRole('button', { name: /stop enrolling/i })).toBeTruthy()
  })

  it('a stale count (409) shows the fresh number to confirm again', async () => {
    fetchMock.mockReturnValue(reply(409, { success: false, error: 'The audience has changed', data: { matching: 15, confirmed: 12 } }))
    render(<AudienceMatchStart sequence={SEQ} matchingCount={12} />)
    fireEvent.click(startButton())
    await waitFor(() => expect(startButton().textContent).toContain('Start for 15 people'))
    expect(screen.getByText(/the audience has changed/i)).toBeTruthy()
  })

  it('does nothing when the confirm is cancelled', () => {
    window.confirm.mockReturnValue(false)
    render(<AudienceMatchStart sequence={SEQ} matchingCount={12} />)
    fireEvent.click(startButton())
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a started flow shows when and how many, and can stop enrolling new people', async () => {
    fetchMock.mockReturnValue(reply(200, { success: true, data: { seeded_at: null } }))
    render(<AudienceMatchStart sequence={{ ...SEQ, audience_seeded_at: '2026-11-10T09:00:00Z', audience_seed_count: 40 }} matchingCount={44} />)
    expect(screen.getByText(/for 40 people/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /stop enrolling/i }))
    await waitFor(() => expect(screen.getByText(/stopped\. nobody new/i)).toBeTruthy())
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE')
    expect(startButton()).toBeTruthy()
  })

  it('says enrolment waits for publishing when the flow is not live', () => {
    render(<AudienceMatchStart sequence={{ ...SEQ, status: 'draft' }} matchingCount={3} />)
    expect(startButton().disabled).toBe(false)
    expect(screen.getByText(/once the flow is published/i)).toBeTruthy()
  })
})

describe('Re-enrolment cooldown hint (COOLDOWN.1)', () => {
  it('says a cooldown lets people go through again, and that 0 means once', () => {
    const hint = COOLDOWN_HINT.toLowerCase()
    expect(hint).toMatch(/0 and each contact goes through this flow once/)
    expect(hint).toMatch(/go through it again once that many days have passed since their last run ended/)
    expect(hint).toMatch(/nobody is ever in the flow twice at the same time/)
    expect(hint).not.toMatch(/does not let anyone re-enter/)
  })
})
