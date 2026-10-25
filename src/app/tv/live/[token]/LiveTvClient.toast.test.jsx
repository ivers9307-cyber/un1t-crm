// @vitest-environment jsdom
//
// TVTOAST.1 — a toast must auto-dismiss even though the board re-renders
// every second.
//
// The live board ticks its own `setNow(new Date())` state once a second for
// the header clock, so EVERY second the parent re-renders and hands
// <ToastLayer> a brand-new inline `onDone`. ToastLayer's effect listed
// `onDone` in its dependency array and clears its dismiss timeout on
// cleanup, so the TOAST_MS=6000 timer was torn down and restarted six times
// before it could ever fire: no toast on this board had EVER auto-dismissed.
//
// Observed live on stillorgan-tv1/tv2 on 2026-10-15 — "Strap 49931 just hit
// Zone 5 — Redline" sat burned on both screens for ~4h, with the header
// reading `0 live`, long after that strap's session ended at 18:10 UTC.
// Worse than the stale toast: only queue[0] renders, so every LATER toast
// (a real member's zone crossing, mid-class) queued behind it and was never
// seen at all.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'

// next/font only runs under the Next compiler.
vi.mock('@/fonts/repset', () => ({
  repsetDisplay: { style: { fontFamily: 'sans-serif' } },
  repsetBody: { style: { fontFamily: 'sans-serif' } },
  repsetMono: { style: { fontFamily: 'monospace' } },
}))
vi.mock('@/lib/supabase', () => ({ createBrowserClient: vi.fn(() => null) }))

import { ToastLayer } from './LiveTvClient.jsx'

const TOAST_MS = 6000
const toast = { key: 'ant:49931', event: 'zone5', message: 'Strap 49931 just hit Zone 5 — Redline' }

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('ToastLayer auto-dismiss', () => {
  it('dismisses once even while the parent re-renders every second with a fresh onDone', async () => {
    const dismissed = vi.fn()
    // A NEW arrow each render — exactly what the board passes, and what the
    // 1 Hz clock tick regenerates.
    const el = () => <ToastLayer queue={[toast]} onDone={(t) => dismissed(t)} />
    const { rerender } = render(el())

    // Ten seconds of board life: a re-render every second, well past TOAST_MS.
    for (let i = 0; i < 10; i += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      rerender(el())
    }

    expect(dismissed).toHaveBeenCalledTimes(1)
    expect(dismissed).toHaveBeenCalledWith(toast)
  })

  it('still dismisses on a quiet parent that never re-renders', async () => {
    const dismissed = vi.fn()
    render(<ToastLayer queue={[toast]} onDone={dismissed} />)

    await act(async () => { await vi.advanceTimersByTimeAsync(TOAST_MS + 100) })

    expect(dismissed).toHaveBeenCalledTimes(1)
  })

  it('renders nothing when the queue is empty', () => {
    const { container } = render(<ToastLayer queue={[]} onDone={() => {}} />)
    expect(container.firstChild).toBeNull()
  })
})
