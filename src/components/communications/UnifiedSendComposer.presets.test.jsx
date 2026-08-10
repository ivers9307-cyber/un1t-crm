// @vitest-environment jsdom
//
// FILTER-A.1 — presets are mounted on the SEND COMPOSER, and the count they
// produce comes from the composer's existing count path, not from a second
// counting mechanism baked into a chip.
//
// Sequences and /contacts deliberately do NOT get presets: a sequence audience
// has been a CONTINUING condition since SEQEXIT.1, so the same rows carry a
// meaning there that the chip's label does not describe.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import { AUDIENCE_PRESETS, presetFilter } from '@/lib/audience-presets'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))

// Stand-in AudienceBuilder that reports the props it was handed and can fire a
// preset click the way the real chip does.
let builderProps = null
vi.mock('@/components/AudienceBuilder', () => ({
  default: (props) => {
    builderProps = props
    return (
      <div>
        <div data-testid="filter-json">{JSON.stringify(props.filter)}</div>
        <div data-testid="preset-count">{props.presets ? props.presets.length : 'none'}</div>
      </div>
    )
  },
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

let calls = []
beforeEach(() => {
  calls = []
  builderProps = null
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null })
    if (String(url).includes('/api/contacts/segments')) return { ok: true, json: async () => ({ success: true, segments: [] }) }
    if (String(url).includes('audience-count')) return { ok: true, json: async () => ({ success: true, count: 42, matched: 42 }) }
    return { ok: true, json: async () => ({ success: true }) }
  }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('UnifiedSendComposer — presets are mounted here', () => {
  // FILTER-C.3 — a preset is a CHOSEN audience; a seeded default row is not.
  // FILTER-B.3 stripped the `Stage = member` seed from the WhatsApp and SMS
  // editors because a guess the operator never made renders identically to a
  // deliberate filter. The composer was one of the last two hosts still
  // passing it.
  it('seeds no guessed filter row — the operator starts from nothing', async () => {
    render(<UnifiedSendComposer locationId="loc-1" channels={['sms']} templates={[]} />)
    await waitFor(() => expect(builderProps).toBeTruthy())
    expect(builderProps.defaultFilterRow ?? null).toBeNull()
    expect(builderProps.filter?.filters ?? []).toHaveLength(0)
  })

  it('hands the verified preset registry to the builder', async () => {
    render(<UnifiedSendComposer locationId="loc-1" channels={['sms']} templates={[]} />)
    await waitFor(() => expect(builderProps).toBeTruthy())
    expect(builderProps.presets).toBe(AUDIENCE_PRESETS)
    expect(screen.getByTestId('preset-count').textContent).toBe(String(AUDIENCE_PRESETS.length))
  })

  it('a preset click routes through the existing count path — no second counting mechanism', async () => {
    render(<UnifiedSendComposer locationId="loc-1" channels={['sms']} templates={[]} />)
    await waitFor(() => expect(builderProps).toBeTruthy())

    const arrears = AUDIENCE_PRESETS.find(p => p.id === 'in_arrears')
    fireEvent.click(document.body) // no-op; the click below is the real action
    builderProps.onChange(presetFilter(arrears))

    await waitFor(() => {
      const count = calls.filter(c => c.url.includes('audience-count')).at(-1)
      expect(count.body.audience_filter).toEqual(presetFilter(arrears))
    })
    // …and the only count request went to the shared endpoint.
    for (const c of calls.filter(c => c.url.includes('count'))) {
      expect(c.url).toContain('/api/communications/audience-count')
    }
  })
})
