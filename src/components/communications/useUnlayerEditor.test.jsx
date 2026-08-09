// @vitest-environment jsdom
//
// COMMSFIX.D.2a — exportHtml used to RESOLVE { html: '', design: null } when
// the Unlayer CDN script hadn't loaded, when exportHtml threw, or when the
// 2.5s timeout fired. The composer then posted that '' straight to
// email-draft with action 'send', queueing a bodyless campaign to the entire
// audience (Postmark rejects every recipient). Audit 2026-08-09 composer-ux,
// CONFIRMED high. A failed export must REJECT so the caller can refuse to
// send instead of silently sending nothing.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, render, cleanup, screen, act } from '@testing-library/react'
import { useUnlayerEditor } from './useUnlayerEditor.js'

function hook() {
  // active:false — we only exercise exportHtml, not the init effect.
  return renderHook(() => useUnlayerEditor({ mountId: 'unlayer-test', active: false }))
}

beforeEach(() => {
  delete window.unlayer
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete window.unlayer
})

describe('useUnlayerEditor — exportHtml failure modes reject', () => {
  it('rejects when the Unlayer script has not loaded', async () => {
    const { result } = hook()
    await expect(result.current.exportHtml()).rejects.toThrow(/designer/i)
  })

  it('rejects when exportHtml throws', async () => {
    window.unlayer = { exportHtml: () => { throw new Error('iframe gone') } }
    const { result } = hook()
    await expect(result.current.exportHtml()).rejects.toThrow(/designer/i)
  })

  it('rejects when the export times out', async () => {
    vi.useFakeTimers()
    window.unlayer = { exportHtml: () => {} }   // callback never fires
    const { result } = hook()
    const p = result.current.exportHtml()
    const assertion = expect(p).rejects.toThrow(/designer/i)
    await vi.advanceTimersByTimeAsync(3000)
    await assertion
  })

  it('rejects when Unlayer hands back an empty body', async () => {
    window.unlayer = { exportHtml: (cb) => cb({ html: '   ', design: { rows: [] } }) }
    const { result } = hook()
    await expect(result.current.exportHtml()).rejects.toThrow(/designer/i)
  })

  it('resolves the html + design on a successful export', async () => {
    const design = { body: { rows: [1] } }
    window.unlayer = { exportHtml: (cb) => cb({ html: '<html><body>Hi</body></html>', design }) }
    const { result } = hook()
    await expect(result.current.exportHtml()).resolves.toEqual({
      html: '<html><body>Hi</body></html>',
      design,
    })
  })
})

// COMMSFIX.D.4a — the composer needs to know whether the canvas holds operator
// work before it lets a channel switch destroy it.
describe('useUnlayerEditor — dirty tracking', () => {
  function Harness() {
    const { ref, dirty } = useUnlayerEditor({ mountId: 'unlayer-dirty', active: true })
    return <div ref={ref} data-testid="mount" data-dirty={String(dirty)} />
  }
  const isDirty = () => screen.getByTestId('mount').getAttribute('data-dirty')

  it('starts clean and flips on the first design:updated event', async () => {
    let handler = null
    window.unlayer = {
      init: () => {},
      addEventListener: (evt, cb) => { if (evt === 'design:updated') handler = cb },
    }
    render(<Harness />)
    expect(isDirty()).toBe('false')

    await act(async () => { handler() })
    expect(isDirty()).toBe('true')
  })

  it('stays clean on an embed build with no addEventListener', () => {
    window.unlayer = { init: () => {} }
    render(<Harness />)
    expect(isDirty()).toBe('false')
  })
})
