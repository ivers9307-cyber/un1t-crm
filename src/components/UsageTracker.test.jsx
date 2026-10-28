// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

vi.mock('next/navigation', () => ({ usePathname: () => '/contacts/abc-123' }))

const { default: UsageTracker, shouldTrackWebUser } = await import('./UsageTracker.jsx')

const staff = { id: 'p1', isMaster: false }
let now

beforeEach(() => {
  now = Date.UTC(2026, 9, 26, 9, 0, 0)
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200 }))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('UsageTracker (web)', () => {
  it('tracks ordinary staff only', () => {
    expect(shouldTrackWebUser(staff)).toBe(true)
    expect(shouldTrackWebUser({ ...staff, isMaster: true })).toBe(false)
    expect(shouldTrackWebUser({ ...staff, impersonatingFrom: { id: 'm' } })).toBe(false)
    expect(shouldTrackWebUser({ ...staff, supportSession: { mode: 'read' } })).toBe(false)
    expect(shouldTrackWebUser(null)).toBe(false)
  })

  it('posts the feature key, never the path, when the page is hidden', async () => {
    render(<UsageTracker user={staff} />)
    now += 30_000
    window.dispatchEvent(new Event('pagehide'))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('/api/usage/events')
    expect(init.keepalive).toBe(true)
    const body = JSON.parse(init.body)
    expect(body.session.platform).toBe('web')
    expect(body.visits.map((v) => v.feature)).toEqual(['contacts'])
    expect(init.body).not.toContain('abc-123')
  })

  it('posts nothing for a master', async () => {
    render(<UsageTracker user={{ ...staff, isMaster: true }} />)
    now += 30_000
    window.dispatchEvent(new Event('pagehide'))
    await new Promise((r) => setTimeout(r, 0))
    expect(fetch).not.toHaveBeenCalled()
  })
})
