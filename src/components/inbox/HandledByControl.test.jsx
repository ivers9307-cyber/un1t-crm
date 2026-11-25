// @vitest-environment jsdom
//
// INBOXFOLLOW.1 — "Handled by" reads the shared handledBy rule, so a coach's
// WhatsApp thread (staff_owned_since, not paused) shows "You" and "Mia" hands it back.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import HandledByControl from './HandledByControl'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true }) })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const mia = () => screen.getByRole('button', { name: /mia/i })
const you = () => screen.getByRole('button', { name: /you/i })
const active = (el) => el.className.includes('bg-mia/10') || el.className.includes('bg-un1t-text')

describe('HandledByControl reads the shared rule', () => {
  it('a coach-owned, unpaused WhatsApp thread shows You, and Mia sends { active: true }', async () => {
    render(<HandledByControl channel="wa" conversation={{ id: 'c1', agent_paused_at: null, agent_active: false, staff_owned_since: '2026-11-25T10:00:00Z' }} />)
    expect(active(you())).toBe(true)
    expect(active(mia())).toBe(false)
    fireEvent.click(mia())
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(fetch.mock.calls[0][0]).toBe('/api/whatsapp/conversations/c1/agent')
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ active: true })
  })

  it('a WhatsApp thread with nothing set shows Mia, and pressing Mia does not call fetch', () => {
    render(<HandledByControl channel="wa" conversation={{ id: 'c1' }} />)
    expect(active(mia())).toBe(true)
    fireEvent.click(mia())
    expect(fetch).not.toHaveBeenCalled()
  })

  it('pressing You on a thread Mia handles still sends { active: false }', async () => {
    render(<HandledByControl channel="wa" conversation={{ id: 'c1' }} />)
    fireEvent.click(you())
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ active: false })
  })

  it('a paused WhatsApp thread shows You', () => {
    render(<HandledByControl channel="wa" conversation={{ id: 'c1', agent_paused_at: '2026-11-25T10:00:00Z' }} />)
    expect(active(you())).toBe(true)
    expect(active(mia())).toBe(false)
  })

  it('an Instagram thread with agent_active false shows You', () => {
    render(<HandledByControl channel="ig" conversation={{ id: 'i1', agent_active: false }} />)
    expect(active(you())).toBe(true)
    expect(active(mia())).toBe(false)
  })
})

// INBOXFOLLOW.2 — the status line says who has the thread.
describe('HandledByControl status label', () => {
  const label = () => screen.queryByTestId('handled-by-status')
  const wa = (extra) => ({ id: 'c1', ...extra })
  const OWNED = { staff_owned_since: '2026-11-25T10:00:00Z', agent_active: false }

  it('WhatsApp, Mia has it: no label', () => {
    render(<HandledByControl channel="wa" conversation={wa({})} />)
    expect(label()).toBeNull()
  })

  it('WhatsApp, a coach has it: the first name from handled_by_name', () => {
    render(<HandledByControl channel="wa" conversation={wa({ ...OWNED, handled_by_name: 'Anna' })} />)
    expect(label().textContent).toBe('Anna')
    expect(active(you())).toBe(true)
  })

  it('a coach with no name reads "A coach"', () => {
    render(<HandledByControl channel="wa" conversation={wa({ ...OWNED, handled_by_name: null })} />)
    expect(label().textContent).toBe('A coach')
  })

  it('WhatsApp, paused: "Mia paused"', () => {
    render(<HandledByControl channel="wa" conversation={wa({ agent_paused_at: '2026-11-25T10:00:00Z' })} />)
    expect(label().textContent).toBe('Mia paused')
    expect(active(you())).toBe(true)
  })

  it('WhatsApp, Mia asked for a person and none has replied: "Waiting for a person"', () => {
    render(<HandledByControl channel="wa" conversation={wa({ agent_active: false, handoff_requested_at: '2026-11-25T10:00:00Z' })} />)
    expect(label().textContent).toBe('Waiting for a person')
    expect(active(you())).toBe(true)
  })

  it('Instagram, Mia has it: no label', () => {
    render(<HandledByControl channel="ig" conversation={{ id: 'i1' }} />)
    expect(label()).toBeNull()
  })

  it('Instagram, a coach has it: the name', () => {
    render(<HandledByControl channel="ig" conversation={{ id: 'i1', ...OWNED, handled_by_name: 'Ben' }} />)
    expect(label().textContent).toBe('Ben')
  })

  it('Instagram never says "Mia paused", even with a pause stamp on the row', () => {
    render(<HandledByControl channel="ig" conversation={{ id: 'i1', agent_paused_at: '2026-11-25T10:00:00Z' }} />)
    expect(screen.queryByText('Mia paused')).toBeNull()
    expect(label()).toBeNull()
  })

  it('Instagram, waiting for a person', () => {
    render(<HandledByControl channel="ig" conversation={{ id: 'i1', agent_active: false, handoff_requested_at: '2026-11-25T10:00:00Z' }} />)
    expect(label().textContent).toBe('Waiting for a person')
  })

  it('the toggle sends the same requests with a label showing', async () => {
    render(<HandledByControl channel="wa" conversation={wa({ ...OWNED, handled_by_name: 'Anna' })} />)
    fireEvent.click(mia())
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(fetch.mock.calls[0][0]).toBe('/api/whatsapp/conversations/c1/agent')
    expect(fetch.mock.calls[0][1]).toEqual({ method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: true }) })
  })
})
