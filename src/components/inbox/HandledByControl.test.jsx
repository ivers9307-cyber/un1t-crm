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
