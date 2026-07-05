import { describe, it, expect } from 'vitest'
import { parseFunnelEvent, VALID_STEPS } from './funnel-events.js'

describe('parseFunnelEvent', () => {
  it('accepts a valid event and normalizes fields', () => {
    const out = parseFunnelEvent({
      step: 'path_class', session_id: 'abc', funnel: 'start',
      ad_external_id: '120248413617870055', utm_campaign: 'META_x', meta: { count: 3 },
    })
    expect(out).toMatchObject({
      step: 'path_class', session_id: 'abc', funnel: 'start',
      ad_external_id: '120248413617870055', ad_provider: 'meta', utm_campaign: 'META_x',
    })
    expect(out.meta).toEqual({ count: 3 })
  })

  it('defaults funnel to start and infers ad_provider=meta from an ad id', () => {
    const out = parseFunnelEvent({ step: 'view', session_id: 's', ad_external_id: '9' })
    expect(out.funnel).toBe('start')
    expect(out.ad_provider).toBe('meta')
  })

  it('leaves ad_provider null when there is no ad id', () => {
    const out = parseFunnelEvent({ step: 'view', session_id: 's' })
    expect(out.ad_provider).toBeNull()
    expect(out.ad_external_id).toBeNull()
  })

  it('rejects an unknown step', () => {
    expect(parseFunnelEvent({ step: 'hacktheplanet', session_id: 's' })).toBeNull()
  })

  it('rejects a missing session_id', () => {
    expect(parseFunnelEvent({ step: 'view' })).toBeNull()
    expect(parseFunnelEvent({ step: 'view', session_id: '' })).toBeNull()
  })

  it('caps overlong strings and coerces non-object meta to {}', () => {
    const out = parseFunnelEvent({ step: 'view', session_id: 'x'.repeat(500), utm_content: 'y'.repeat(500), meta: 'nope' })
    expect(out.session_id.length).toBe(200)
    expect(out.utm_content.length).toBe(200)
    expect(out.meta).toEqual({})
  })

  it('exposes the valid step list', () => {
    expect(VALID_STEPS).toContain('booked_class')
    expect(VALID_STEPS).toContain('slots_view')
  })
})
