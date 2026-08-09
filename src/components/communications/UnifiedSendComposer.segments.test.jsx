// @vitest-environment jsdom
//
// SEGPICK.1 — the composer's own copy has always said "Build a filter / pick a
// saved segment", but the picker never existed: a segment saved on /contacts
// could not drive a send. `contact_segments.filter` is byte-identical in shape
// to `campaigns.audience_filter`, so applying one is an assignment, never a
// transformation.
//
// The honesty rule under test: once the operator edits the filter after
// applying, the UI must STOP claiming that segment is applied. A label reading
// "Overdue arrears" over a filter that no longer matches it is worse than no
// label at all.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))

// Stand-in AudienceBuilder: renders the filter it was handed, and offers a
// button that edits it by hand (the exact move that must drop the label).
const HAND_EDITED = { logic: 'and', filters: [{ field: 'lead_source', op: 'eq', value: 'meta' }] }
vi.mock('@/components/AudienceBuilder', () => ({
  default: ({ filter, onChange }) => (
    <div>
      <div data-testid="filter-json">{JSON.stringify(filter)}</div>
      <button type="button" onClick={() => onChange(HAND_EDITED)}>edit filter by hand</button>
    </div>
  ),
  // FILTER-P1.1 — the real module exports this named default row; the mock
  // must too, or every host importing it fails to resolve.
  STAGE_MEMBER_DEFAULT_ROW: { field: 'pipeline_stage_slug', op: 'eq', value: 'member' },
}))
vi.mock('./ContactMultiSelect', () => ({ default: () => <div /> }))
vi.mock('./useUnlayerEditor', async () => {
  const actual = await vi.importActual('./useUnlayerEditor.js')
  return {
    ...actual,
    useUnlayerEditor: () => ({ ref: { current: null }, loaded: true, dirty: false, exportHtml: async () => ({ html: '', design: {} }) }),
  }
})

import UnifiedSendComposer from './UnifiedSendComposer.jsx'

const OVERDUE_FILTER = { logic: 'and', filters: [{ field: 'glofox_membership_state', op: 'eq', value: 'locked' }] }
const COLD_FILTER = { logic: 'and', filters: [{ field: 'pipeline_stage_slug', op: 'eq', value: 'cold_lead' }] }

const SEGMENTS = [
  { id: 'seg-1', name: 'Overdue arrears', description: 'Members in payment arrears', filter: OVERDUE_FILTER },
  { id: 'seg-2', name: 'Cold leads', description: null, filter: COLD_FILTER },
]

let calls = []
let segmentsResponse = { success: true, segments: SEGMENTS }

function mockFetch() {
  return vi.fn(async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null })
    if (String(url).includes('/api/contacts/segments')) {
      return { ok: true, json: async () => segmentsResponse }
    }
    if (String(url).includes('audience-count')) {
      return { ok: true, json: async () => ({ success: true, count: 42, matched: 42 }) }
    }
    return { ok: true, json: async () => ({ success: true }) }
  })
}

beforeEach(() => {
  calls = []
  segmentsResponse = { success: true, segments: SEGMENTS }
  vi.stubGlobal('fetch', mockFetch())
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const currentFilter = () => JSON.parse(screen.getByTestId('filter-json').textContent)
const appliedLabel = () => screen.queryByText(/using saved segment/i)

function renderComposer(props = {}) {
  return render(<UnifiedSendComposer locationId="loc-1" channels={['sms']} templates={[]} {...props} />)
}

describe('UnifiedSendComposer — saved segment picker', () => {
  it('lists the location saved segments fetched on mount', async () => {
    renderComposer()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Overdue arrears' })).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Cold leads' })).toBeTruthy()
    const seg = calls.find(c => c.url.includes('/api/contacts/segments'))
    expect(seg.url).toContain('location_id=loc-1')
  })

  it('applies the stored filter verbatim and names the applied segment', async () => {
    renderComposer()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Overdue arrears' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Overdue arrears' }))

    // Assignment, not transformation — byte-identical to what was stored.
    expect(currentFilter()).toEqual(OVERDUE_FILTER)
    expect(appliedLabel()).toBeTruthy()
    expect(appliedLabel().textContent).toContain('Overdue arrears')

    // The live count recomputes through the existing debounce, no special-casing.
    await waitFor(() => {
      const count = calls.filter(c => c.url.includes('audience-count')).at(-1)
      expect(count.body.audience_filter).toEqual(OVERDUE_FILTER)
    })
  })

  // THE honesty requirement: apply is a one-shot seed.
  it('drops the segment label as soon as the filter is edited by hand', async () => {
    renderComposer()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Overdue arrears' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Overdue arrears' }))
    expect(appliedLabel()).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /edit filter by hand/i }))

    expect(appliedLabel()).toBeNull()
    // The operator keeps their edit — only the claim goes away.
    expect(currentFilter()).toEqual(HAND_EDITED)
  })

  it('clears the segment and its filter on Clear', async () => {
    renderComposer()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Overdue arrears' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Overdue arrears' }))
    fireEvent.click(screen.getByRole('button', { name: /clear segment/i }))

    expect(appliedLabel()).toBeNull()
    expect(currentFilter()).toEqual({ logic: 'and', filters: [] })
  })

  it('seeds from ?segment_id via initialSegmentId', async () => {
    renderComposer({ initialSegmentId: 'seg-2' })
    await waitFor(() => expect(currentFilter()).toEqual(COLD_FILTER))
    expect(appliedLabel().textContent).toContain('Cold leads')
  })

  it('ignores an initialSegmentId that is not at this location', async () => {
    renderComposer({ initialSegmentId: 'seg-from-another-gym' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cold leads' })).toBeTruthy())
    expect(currentFilter()).toEqual({ logic: 'and', filters: [] })
    expect(appliedLabel()).toBeNull()
  })

  it('points at /contacts instead of rendering a dead control when there are none', async () => {
    segmentsResponse = { success: true, segments: [] }
    renderComposer()
    await waitFor(() => expect(screen.getByText(/no saved segments yet/i)).toBeTruthy())
    const link = screen.getByRole('link', { name: /contacts/i })
    expect(link.getAttribute('href')).toBe('/contacts')
    expect(screen.queryByRole('button', { name: 'Overdue arrears' })).toBeNull()
  })
})
