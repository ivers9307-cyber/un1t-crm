// @vitest-environment jsdom
// APPROVALSQ.3 — every time on the requests history renders on the studio's clock.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import AgentRequestsClient from './AgentRequestsClient.jsx'
import { DEFAULT_TZ } from '@shared/zoned-time'

const contacts = { id: 'c1', name: 'Ann', first_name: 'Ann' }
const decided = (decided_at, extra = {}) => ({
  id: 'd1', kind: 'pause', status: 'declined', details: {}, contacts,
  created_at: '2026-11-14T23:30:00Z', decided_at, decided_by_name: 'Sarah', ...extra,
})
let list
afterEach(cleanup)
beforeEach(() => {
  list = []
  globalThis.fetch = vi.fn(async () => ({ status: 200, json: async () => ({ success: true, requests: list }) }))
})
const text = () => document.getElementById('agent-req-d1').textContent

describe('AgentRequestsClient studio clock', () => {
  it('shows the New York wall time when the studio is in New York', async () => {
    list = [decided('2026-11-14T16:20:00Z')]
    render(<AgentRequestsClient timezone="America/New_York" />)
    await screen.findByText(/Sarah/)
    expect(text()).toContain('by Sarah, 14 Nov 2026, 11:20')
  })

  it('buckets the created date on the studio day', async () => {
    list = [decided(null, { id: 'd1', status: 'pending', created_at: '2026-11-15T02:30:00Z' })]
    render(<AgentRequestsClient timezone="America/New_York" />)
    await screen.findByText('Ann')
    expect(text()).toContain('14 Nov 2026') // 02:30Z on the 15th is 21:30 on the 14th in New York
    expect(text()).not.toContain('15 Nov 2026')
  })

  it('falls back to the platform zone with no prop', async () => {
    list = [decided('2026-11-14T16:20:00Z')]
    expect(DEFAULT_TZ).toBe('Europe/Dublin')
    render(<AgentRequestsClient />)
    await screen.findByText(/Sarah/)
    expect(text()).toContain('by Sarah, 14 Nov 2026, 16:20')
  })

  it('crosses DST: summer in New York (EDT) and in the fallback zone (IST)', async () => {
    list = [decided('2026-07-14T16:20:00Z')]
    const ny = render(<AgentRequestsClient timezone="America/New_York" />)
    await screen.findByText(/Sarah/)
    expect(text()).toContain('14 Jul 2026, 12:20')
    ny.unmount()
    render(<AgentRequestsClient />)
    await screen.findByText(/Sarah/)
    expect(text()).toContain('14 Jul 2026, 17:20')
  })

  it('shows a date-only request date as that calendar day in a zone behind UTC', async () => {
    list = [{ ...decided(null), status: 'pending', details: { start_date: '2026-12-01', end_date: '2026-12-15' } }]
    render(<AgentRequestsClient timezone="America/New_York" />)
    await screen.findByText('Ann')
    expect(text()).toContain('From 1 Dec 2026 to 15 Dec 2026')
  })
})
