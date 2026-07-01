import { describe, it, expect } from 'vitest'
import { buildFlowPayload } from './whatsapp.js'

describe('buildFlowPayload', () => {
  it('builds an interactive flow message with a published mode + token', () => {
    const p = buildFlowPayload('353871234567', { flowId: 'F1', flowToken: 'ct1.loc1', flowCta: 'Book now', screen: 'PATH' })
    expect(p.type).toBe('interactive')
    expect(p.interactive.type).toBe('flow')
    const params = p.interactive.action.parameters
    expect(params.flow_id).toBe('F1')
    expect(params.flow_token).toBe('ct1.loc1')
    expect(params.flow_cta).toBe('Book now')
    expect(params.mode).toBe('published')
    expect(params.flow_action).toBe('navigate')
    expect(params.flow_action_payload.screen).toBe('PATH')
  })

  it('defaults the CTA when none is given', () => {
    const p = buildFlowPayload('353871234567', { flowId: 'F1', flowToken: 'ct1.loc1', screen: 'PATH' })
    expect(p.interactive.action.parameters.flow_cta).toBe('Book now')
  })
})
