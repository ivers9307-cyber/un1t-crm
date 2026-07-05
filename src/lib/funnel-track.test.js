import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const trackMock = vi.fn()
vi.mock('@vercel/analytics', () => ({ track: (...a) => trackMock(...a) }))

import { trackFunnelStep } from './funnel-track.js'

describe('trackFunnelStep', () => {
  beforeEach(() => { trackMock.mockClear(); global.window = {} })
  afterEach(() => { delete global.window })

  it('prefixes the step name and fires Vercel Analytics', () => {
    trackFunnelStep('path_class', { kind: 'class' })
    expect(trackMock).toHaveBeenCalledWith('start_path_class', { kind: 'class' })
  })

  it('fires the Meta Pixel custom event when fbq is present', () => {
    const fbq = vi.fn()
    global.window.fbq = fbq
    trackFunnelStep('booked_class')
    expect(fbq).toHaveBeenCalledWith('trackCustom', 'start_booked_class', {})
  })

  it('no-ops safely (no throw) when fbq is absent but still sends analytics', () => {
    expect(() => trackFunnelStep('view')).not.toThrow()
    expect(trackMock).toHaveBeenCalledWith('start_view', {})
  })

  it('does nothing during SSR (no window)', () => {
    delete global.window
    expect(() => trackFunnelStep('view')).not.toThrow()
    expect(trackMock).not.toHaveBeenCalled()
  })
})
