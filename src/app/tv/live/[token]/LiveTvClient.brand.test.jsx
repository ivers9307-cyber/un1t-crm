// @vitest-environment jsdom
//
// W1.S1b — the live board's overlay wordmark is the studio's configured brand
// from the poll payload (`brand.name`), capped to one line at 45% of the
// width so a long brand can never run into the intro's "● Live" chip, and
// not drawn at all when the brand is empty (never a literal gym).
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, screen, waitFor } from '@testing-library/react'

vi.mock('@/fonts/repset', () => ({
  repsetDisplay: { variable: 'f-d' },
  repsetBody: { variable: 'f-b' },
  repsetMono: { variable: 'f-m' },
}))
vi.mock('@/lib/supabase', () => ({ createBrowserClient: () => { throw new Error('no client in tests') } }))

import LiveTvClient from './LiveTvClient.jsx'

const LONG_BRAND = 'Gym A North Performance and Conditioning Studio'

function payload(brandName) {
  // A class that started at the server clock → the intro card plays.
  const serverTime = new Date().toISOString()
  return {
    ok: true,
    brand: { name: brandName, short_name: '' },
    location: { name: 'Gym A North' },
    sessions: [],
    available_straps: [],
    timer: null,
    bridge: { online: false },
    server_time: serverTime,
    current_class: {
      glofox_event_id: `evt-${brandName || 'none'}`,
      starts_at: serverTime,
      class_name: 'STRENGTH',
      starts_at_label: '07:00',
      program: 'Strength',
    },
  }
}

function stubFetch(body) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => body })))
}

beforeEach(() => {
  try { sessionStorage.clear() } catch {}
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('LiveTvClient — the overlay wordmark (W1.S1b)', () => {
  it('renders the payload brand on one ellipsised line capped at 45% of the width', async () => {
    stubFetch(payload(LONG_BRAND))
    render(<LiveTvClient endpoint="/api/public/tv-live/tok" device={null} />)
    const mark = await screen.findByText(LONG_BRAND)
    expect(mark.tagName).toBe('SPAN')
    expect(mark.style.whiteSpace).toBe('nowrap')
    expect(mark.style.textOverflow).toBe('ellipsis')
    expect(mark.style.overflow).toBe('hidden')
    expect(mark.style.maxWidth).toBe('45%')
    await waitFor(() => expect(document.title).toBe(LONG_BRAND))
  })

  it('an empty brand draws no wordmark span at all', async () => {
    stubFetch(payload(''))
    const { container } = render(<LiveTvClient endpoint="/api/public/tv-live/tok" device={null} />)
    // The intro card is up (so the wordmark WOULD be drawn if there were a brand)…
    await screen.findByText('Now starting')
    // …and no span carries the wordmark's cap.
    const capped = [...container.querySelectorAll('span')].filter((s) => s.style.maxWidth === '45%')
    expect(capped).toEqual([])
  })
})
