// @vitest-environment jsdom
//
// FILTER-B.9 — the operator-facing half of "show me who matches".
//
// Collapsed by default: a preview is a deliberate act of checking, not
// something that dumps 50 customers' details onto every screen that renders a
// filter. Once opened it must say WHICH question it is answering — the people
// who would actually receive this send, or (for a sequence) the people who
// currently match a continuing condition.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

import AudiencePreview from './AudiencePreview.jsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const FILTER = { logic: 'and', filters: [{ field: 'pipeline_stage_slug', op: 'eq', value: 'member' }] }

const ROWS = [
  { id: 'c1', name: 'Richard Ivers', stage: 'member', identifier: 'ri•••@example.com', identifier_kind: 'email' },
  { id: 'c2', name: 'Ann Byrne', stage: 'dormant', identifier: 'an•••@example.com', identifier_kind: 'email' },
]

function stubPreview(handler) {
  const calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (String(url).includes('/api/communications/audience-preview')) {
      calls.push(JSON.parse(init.body))
      return handler()
    }
    return { ok: true, status: 200, json: async () => ({ success: true }) }
  }))
  return calls
}

function ok(data) { return { ok: true, status: 200, json: async () => ({ success: true, data }) } }
function bad(error) { return { ok: false, status: 400, json: async () => ({ success: false, error }) } }

const PAGE = { rows: ROWS, total: 2, offset: 0, limit: 50, channel: 'email', basis: 'will_receive' }

function open() {
  fireEvent.click(screen.getByRole('button', { name: /who matches/i }))
}

describe('AudiencePreview — collapsed until asked', () => {
  it('fetches nothing until the operator opens it', () => {
    const calls = stubPreview(() => ok(PAGE))
    render(<AudiencePreview locationId="loc-1" filter={FILTER} channel="email" />)
    expect(calls.length).toBe(0)
    expect(screen.queryByText('Richard Ivers')).toBeNull()
  })

  it('fetches the first page on open, for its own channel', async () => {
    const calls = stubPreview(() => ok(PAGE))
    render(<AudiencePreview locationId="loc-1" filter={FILTER} channel="email" />)
    open()
    await screen.findByText('Richard Ivers')
    expect(calls[0]).toEqual({
      location_id: 'loc-1', audience_filter: FILTER, channel: 'email', limit: 50, offset: 0,
    })
  })

  it('omits the channel for a matching-mode (sequence) preview', async () => {
    const calls = stubPreview(() => ok({ ...PAGE, channel: null, basis: 'matching' }))
    render(<AudiencePreview locationId="loc-1" filter={FILTER} mode="matching" />)
    open()
    await screen.findByText('Richard Ivers')
    expect(calls[0].channel).toBeUndefined()
  })
})

describe('AudiencePreview — says which question it answers', () => {
  it('a send preview says these are the people who would RECEIVE it', async () => {
    stubPreview(() => ok(PAGE))
    render(<AudiencePreview locationId="loc-1" filter={FILTER} channel="email" />)
    open()
    await screen.findByText(/would receive/i)
  })

  it('a sequence preview says these are the people who MATCH, not who receives', async () => {
    stubPreview(() => ok({ ...PAGE, channel: null, basis: 'matching' }))
    render(<AudiencePreview locationId="loc-1" filter={FILTER} mode="matching" />)
    open()
    await screen.findByText(/currently match/i)
    expect(screen.queryByText(/would receive/i)).toBeNull()
  })

  it('shows the total, not just the page', async () => {
    stubPreview(() => ok({ ...PAGE, total: 3195 }))
    render(<AudiencePreview locationId="loc-1" filter={FILTER} channel="email" />)
    open()
    const hits = await screen.findAllByText(/3,195/)
    expect(hits.length).toBeGreaterThan(0)
  })
})

describe('AudiencePreview — masked, and says so', () => {
  it('renders the masked identifier the server sent and never asks for more', async () => {
    stubPreview(() => ok(PAGE))
    render(<AudiencePreview locationId="loc-1" filter={FILTER} channel="email" />)
    open()
    await screen.findByText('ri•••@example.com')
    expect(screen.getByText(/masked/i)).toBeTruthy()
  })

  it('offers no export — that is a different feature with different consent', async () => {
    stubPreview(() => ok(PAGE))
    const { container } = render(<AudiencePreview locationId="loc-1" filter={FILTER} channel="email" />)
    open()
    await screen.findByText('Richard Ivers')
    const labels = Array.from(container.querySelectorAll('button')).map(b => b.textContent.toLowerCase())
    expect(labels.some(l => /export|download|copy all|csv/.test(l))).toBe(false)
  })
})

describe('AudiencePreview — pagination', () => {
  it('walks forward a page at a time and back again', async () => {
    const calls = stubPreview(() => ok({ ...PAGE, total: 120 }))
    render(<AudiencePreview locationId="loc-1" filter={FILTER} channel="email" />)
    open()
    await screen.findByText('Richard Ivers')
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    await waitFor(() => expect(calls.length).toBe(2))
    expect(calls[1].offset).toBe(50)
    fireEvent.click(screen.getByRole('button', { name: /previous/i }))
    await waitFor(() => expect(calls.length).toBe(3))
    expect(calls[2].offset).toBe(0)
  })

  it('does not offer a next page when the whole audience already fits', async () => {
    stubPreview(() => ok(PAGE))
    render(<AudiencePreview locationId="loc-1" filter={FILTER} channel="email" />)
    open()
    await screen.findByText('Richard Ivers')
    expect(screen.queryByRole('button', { name: /next/i })).toBeNull()
  })
})

describe('AudiencePreview — states', () => {
  it('surfaces the server error rather than an empty list', async () => {
    stubPreview(() => bad('Unknown audience field: nope'))
    render(<AudiencePreview locationId="loc-1" filter={FILTER} channel="email" />)
    open()
    await screen.findByText(/Unknown audience field/)
  })

  it('says plainly when nobody matches', async () => {
    stubPreview(() => ok({ ...PAGE, rows: [], total: 0 }))
    render(<AudiencePreview locationId="loc-1" filter={FILTER} channel="email" />)
    open()
    await screen.findByText(/nobody/i)
  })

  it('every control is type="button" (a builder is often inside a form)', async () => {
    stubPreview(() => ok({ ...PAGE, total: 120 }))
    const { container } = render(<AudiencePreview locationId="loc-1" filter={FILTER} channel="email" />)
    open()
    await screen.findByText('Richard Ivers')
    const untyped = Array.from(container.querySelectorAll('button')).filter(b => b.getAttribute('type') !== 'button')
    expect(untyped).toEqual([])
  })
})
