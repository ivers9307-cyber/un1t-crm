// RADAR-AGENT.0 — unit tests for the customer-agent prompt builder.
import { describe, it, expect } from 'vitest'
import {
  buildKnowledgeBlock,
  buildCustomerSystemPrompt,
  HANDOFF_PREFIX,
  CUSTOMER_AGENT_BASE_PROMPT,
} from './prompt'

describe('buildKnowledgeBlock', () => {
  it('returns an explicit empty notice when there is no knowledge', () => {
    const out = buildKnowledgeBlock([])
    expect(out).toMatch(/No knowledge has been added/i)
  })
  it('drops disabled and empty entries', () => {
    const out = buildKnowledgeBlock([
      { category: 'sales', title: 'Price', content: '€89/mo', enabled: true },
      { category: 'sales', title: 'Hidden', content: 'secret', enabled: false },
      { category: 'sales', title: 'Blank', content: '   ', enabled: true },
    ])
    expect(out).toContain('€89/mo')
    expect(out).not.toContain('secret')
    expect(out).not.toContain('Blank')
  })
  it('orders sales before general', () => {
    const out = buildKnowledgeBlock([
      { category: 'general', title: 'G', content: 'gen' },
      { category: 'sales', title: 'S', content: 'sale' },
    ])
    expect(out.indexOf('SALES')).toBeLessThan(out.indexOf('GENERAL'))
  })
})

describe('buildCustomerSystemPrompt', () => {
  it('always includes the base rules + handoff convention', () => {
    const p = buildCustomerSystemPrompt({})
    expect(p).toContain(CUSTOMER_AGENT_BASE_PROMPT)
    expect(p).toContain(HANDOFF_PREFIX)
  })
  it('includes context, tone, extra rules and knowledge when provided', () => {
    const p = buildCustomerSystemPrompt({
      businessName: 'UN1T',
      locationName: 'Stillorgan',
      tone: 'Friendly and brief',
      extraRules: 'Never discuss competitors',
      today: '2026-06-01',
      knowledge: [{ category: 'sales', title: 'Trial', content: 'First class free' }],
    })
    expect(p).toContain('Stillorgan')
    expect(p).toContain('Friendly and brief')
    expect(p).toContain('Never discuss competitors')
    expect(p).toContain('First class free')
    expect(p).toContain('2026-06-01')
  })
  it('omits optional sections cleanly when absent', () => {
    const p = buildCustomerSystemPrompt({ knowledge: [] })
    expect(p).not.toContain('Tone & voice')
    expect(p).not.toContain('Extra rules (from the studio)')
  })
})
