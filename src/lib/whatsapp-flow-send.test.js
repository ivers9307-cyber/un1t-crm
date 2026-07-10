import { describe, it, expect } from 'vitest'
import { buildFlowPayload } from './whatsapp.js'

describe('buildFlowPayload', () => {
  it('data_exchange mode when no screen given — endpoint INIT drives the first screen', () => {
    const p = buildFlowPayload('353871234567', { flowId: 'F1', flowToken: 'ct1.loc1', flowCta: 'Book now' })
    expect(p.type).toBe('interactive')
    expect(p.interactive.type).toBe('flow')
    const params = p.interactive.action.parameters
    expect(params.flow_id).toBe('F1')
    expect(params.flow_token).toBe('ct1.loc1')
    expect(params.flow_cta).toBe('Book now')
    expect(params.mode).toBe('published')
    expect(params.flow_action).toBe('data_exchange')
    expect(params.flow_action_payload).toBeUndefined()
  })

  it('navigate mode when a screen is given', () => {
    const p = buildFlowPayload('353871234567', { flowId: 'F1', flowToken: 'ct1.loc1', screen: 'DAY', data: { path: 'class' } })
    const params = p.interactive.action.parameters
    expect(params.flow_action).toBe('navigate')
    expect(params.flow_action_payload).toEqual({ screen: 'DAY', data: { path: 'class' } })
  })

  it('defaults the CTA when none is given', () => {
    const p = buildFlowPayload('353871234567', { flowId: 'F1', flowToken: 'ct1.loc1' })
    expect(p.interactive.action.parameters.flow_cta).toBe('Book now')
  })

  it('defaults the body text when none is given', () => {
    const p = buildFlowPayload('353871234567', { flowId: 'F1', flowToken: 'ct1.loc1' })
    expect(p.interactive.body.text).toBe('Tap below to book your first visit.')
  })

  it('uses operator-supplied body text when given (FLOW-SEND invite_text)', () => {
    const p = buildFlowPayload('353871234567', {
      flowId: 'F1', flowToken: 'ct1.loc1',
      bodyText: 'Grab a slot for your first session 💪',
    })
    expect(p.interactive.body.text).toBe('Grab a slot for your first session 💪')
  })
})
