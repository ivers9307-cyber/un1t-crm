// @vitest-environment jsdom
//
// WAYSIN.5 — the Lead Source value picker offers the studio's vocabulary
// (GET /api/locations/[id]/lead-sources): the nine defaults while it loads or
// when it cannot, then the studio's own list and values seen on its contacts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import AudienceBuilder, { FIELD_OPTIONS, withLeadSources } from './AudienceBuilder.jsx'
import { DEFAULT_LEAD_SOURCES } from '@/lib/lead-source-vocabulary'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const json = (body) => Promise.resolve({ json: () => Promise.resolve(body) })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const leadField = () => FIELD_OPTIONS.find((f) => f.value === 'lead_source')
const valueOptions = (container) => Array.from(container.querySelectorAll('select')[2].querySelectorAll('option')).map((o) => [o.value, o.textContent])

describe('withLeadSources', () => {
  it('appends the vocabulary after the defaults, never twice, keeping the default labels', () => {
    const cfg = withLeadSources(leadField(), [
      { value: 'meta', label: 'Meta (Facebook/Instagram)', origin: 'default' },
      { value: 'corp_promo', label: 'corp_promo', origin: 'seen' },
    ])
    expect(cfg.options).toEqual([...DEFAULT_LEAD_SOURCES, 'corp_promo'])
    expect(cfg.valueLabels.walkin).toBe('Walk-in')
    expect(cfg.valueLabels.corp_promo).toBe('corp_promo')
  })
  it('nothing loaded, or another field, is the static field', () => {
    expect(withLeadSources(leadField(), null)).toBe(leadField())
    const other = FIELD_OPTIONS.find((f) => f.value === 'pipeline_stage_slug')
    expect(withLeadSources(other, [{ value: 'x' }])).toBe(other)
  })
})

describe('AudienceBuilder — Lead Source row', () => {
  let fetchMock
  beforeEach(() => {
    fetchMock = vi.fn((url) => (String(url).includes('/lead-sources')
      ? json({ success: true, data: { sources: [
        ...DEFAULT_LEAD_SOURCES.map((v) => ({ value: v, label: v, origin: 'default' })),
        { value: 'clubhouse_partner', label: 'clubhouse_partner', origin: 'studio' },
      ] } })
      : new Promise(() => {})))
    vi.stubGlobal('fetch', fetchMock)
  })

  it("fetches the studio's vocabulary and offers it", async () => {
    let view
    await act(async () => {
      view = render(<AudienceBuilder filter={{ logic: 'and', filters: [{ field: 'lead_source', op: 'eq', value: 'meta' }] }} onChange={() => {}} locationId={LOC} />)
    })
    expect(fetchMock).toHaveBeenCalledWith(`/api/locations/${LOC}/lead-sources`)
    const opts = valueOptions(view.container)
    expect(opts.map(([v]) => v)).toEqual([...DEFAULT_LEAD_SOURCES, 'clubhouse_partner'])
    expect(Object.fromEntries(opts).walkin).toBe('Walk-in')
  })

  it('with no studio, offers the nine and asks nothing', async () => {
    let view
    await act(async () => {
      view = render(<AudienceBuilder filter={{ logic: 'and', filters: [{ field: 'lead_source', op: 'eq', value: 'meta' }] }} onChange={() => {}} />)
    })
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/lead-sources'))).toBe(false)
    expect(valueOptions(view.container).map(([v]) => v)).toEqual([...DEFAULT_LEAD_SOURCES])
  })
})
