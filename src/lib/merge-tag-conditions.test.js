// CONDBLOCKS.1 — conditional blocks in emails.
import { describe, it, expect } from 'vitest'
import { applyMergeTags } from './postmark'

const member = { first_name: 'Anne', glofox_membership_state: 'active', glofox_membership_status: 'member', pipeline_stage_slug: 'member' }
const lead = { first_name: '', name: '', glofox_membership_state: null, glofox_membership_status: 'lead', pipeline_stage_slug: 'dormant' }

describe('conditional blocks (CONDBLOCKS.1)', () => {
  it('if member / else', () => {
    const t = '{{#if member}}Thanks for training with us.{{else}}Come and try a class.{{/if}}'
    expect(applyMergeTags(t, member)).toBe('Thanks for training with us.')
    expect(applyMergeTags(t, lead)).toBe('Come and try a class.')
  })

  it('unless, first_name and stage', () => {
    expect(applyMergeTags('{{#unless member}}Join now.{{/unless}}', member)).toBe('')
    expect(applyMergeTags('Hi{{#if first_name}} {{first_name}}{{/if}},', lead)).toBe('Hi,')
    expect(applyMergeTags('Hi{{#if first_name}} {{first_name}}{{/if}},', member)).toBe('Hi Anne,')
    expect(applyMergeTags('{{#if stage=dormant}}We miss you.{{/if}}', lead)).toBe('We miss you.')
  })

  it('leaves an unknown condition exactly as written', () => {
    const t = '{{#if vip}}x{{/if}}'
    expect(applyMergeTags(t, member)).toBe(t)
  })

  it('handles several blocks and HTML inside them', () => {
    const t = '<p>{{#if member}}<b>A</b>{{/if}}</p><p>{{#if stage=member}}B{{/if}}</p>'
    expect(applyMergeTags(t, member)).toBe('<p><b>A</b></p><p>B</p>')
  })
})
