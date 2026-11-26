// CONDBLOCKS.2 — the MCP email tools accept CONDBLOCKS.1's conditional blocks,
// and refuse any the send path could not read.
import { describe, it, expect } from 'vitest'
import {
  conditionalBlockProblem,
  mergeTagProblem,
  unknownMergeTags,
  validateBlocks,
  renderAgentEmail,
} from '@/lib/agent-email-blocks'
import { MERGE_CONDITIONS } from '@/lib/merge-tags'
import { applyMergeTags, evaluateMergeCondition } from '@/lib/postmark'
import { MERGE_TAG_HELP, checkSubject, resendColumns } from '@/lib/agent-tools/_email-draft'

const lib = { allowedImageUrls: new Set() }
const member = { first_name: 'Anne', glofox_membership_state: 'active', glofox_membership_status: 'member', pipeline_stage_slug: 'member' }
const lead = { first_name: '', name: '', glofox_membership_state: null, glofox_membership_status: 'lead', pipeline_stage_slug: 'dormant' }

describe('conditional blocks in agent email text', () => {
  it.each([
    '{{#if member}}Thanks for training with us.{{else}}Come and try a class.{{/if}}',
    '{{#unless member}}Join now.{{/unless}}',
    'Hi{{#if first_name}} {{first_name}}{{/if}},',
    '{{#if stage=dormant}}We miss you, {{first_name|there}}.{{/if}}',
    '{{#if stage=trial_done}}a{{/if}} and {{#unless first_name}}b{{else}}c{{/unless}}',
  ])('accepts %s', (t) => {
    expect(conditionalBlockProblem(t)).toBeNull()
    expect(unknownMergeTags(t)).toEqual([])
    expect(mergeTagProblem(t)).toBeNull()
  })

  it.each([
    ['{{#if vip}}x{{/if}}', /"vip".*not one emails understand/],
    ['{{#if  member}}x{{/if}}', /not written correctly/],
    ['{{#if member }}x{{/if}}', /not written correctly/],
    ['{{#if Member}}x{{/if}}', /not written correctly/],
    ['{{#if stage}}x{{/if}}', /needs a value/],
    ['{{#if member=yes}}x{{/if}}', /takes no value/],
    ['{{#if stage=Dormant!}}x{{/if}}', /not written correctly/],
    ['{{#each member}}x{{/each}}', /not written correctly/],
    ['{{#if member}}x', /never closed/],
    ['x{{/if}}', /has no \{\{#if …\}\} to close/],
    ['{{else}}', /must sit inside/],
    ['{{#if member}}a{{else}}b{{else}}c{{/if}}', /only one \{\{else\}\}/],
    ['{{#if member}}a{{/unless}}', /must be closed with \{\{\/if\}\}/],
    ['{{#if member}}{{#if first_name}}a{{/if}}{{/if}}', /cannot be nested/],
    ['{{#if member}}a{{/fi}}', /not a block ending/],
  ])('refuses %s', (t, re) => {
    expect(mergeTagProblem(t)).toMatch(re)
  })

  it('still refuses an unknown plain tag inside a valid block', () => {
    expect(mergeTagProblem('{{#if member}}{{nickname}}{{/if}}')).toMatch(/\{\{nickname\}\} is not available/)
  })

  it('validateBlocks takes blocks in paragraphs, headings, list items and button labels', () => {
    const blocks = [
      { type: 'heading', level: 1, text: '{{#if member}}Welcome back{{else}}Hello{{/if}}' },
      { type: 'paragraph', text: '{{#unless member}}Your first class is on us.{{/unless}}' },
      { type: 'list', items: ['{{#if stage=dormant}}We kept your spot.{{/if}}'] },
      { type: 'button', label: '{{#if member}}Book{{else}}Try a class{{/if}}', url: 'https://x.ie/' },
    ]
    expect(validateBlocks(blocks, lib)).toBeNull()
  })

  it('validateBlocks refuses a block split across two texts', () => {
    const blocks = [
      { type: 'paragraph', text: '{{#if member}}Members:' },
      { type: 'paragraph', text: 'thanks.{{/if}}' },
    ]
    expect(validateBlocks(blocks, lib)).toMatch(/never closed/)
  })

  it('refuses a condition in a link or image address', () => {
    expect(validateBlocks([{ type: 'button', label: 'Go', url: '{{#if member}}https://x.ie/{{/if}}' }], lib))
      .toMatch(/cannot be used inside a link address/)
    // A raw-link target with a space in it is never read as a link: it renders as text, not an <a>.
    const html = renderAgentEmail({ blocks: [{ type: 'paragraph', text: '[go]({{#if member}}https://x.ie/{{/if}})' }], branding: {} })
    expect(html).not.toContain('<a href')
  })

  it('what the renderer stores is what the send path resolves', () => {
    const html = renderAgentEmail({
      blocks: [{ type: 'paragraph', text: '{{#if member}}**Thanks**, {{first_name}}.{{else}}Come and try a class.{{/if}}' }],
      branding: { companyName: 'Studio' },
    })
    expect(applyMergeTags(html, member)).toContain('<strong>Thanks</strong>, Anne.')
    expect(applyMergeTags(html, member)).not.toContain('Come and try')
    expect(applyMergeTags(html, lead)).toContain('Come and try a class.')
    expect(applyMergeTags(html, lead)).not.toContain('{{')
  })
})

describe('the condition registry matches the send path', () => {
  it('every registered condition is one evaluateMergeCondition decides', () => {
    for (const c of MERGE_CONDITIONS) {
      expect(evaluateMergeCondition(c.name, c.takesValue ? 'dormant' : null, lead)).not.toBeNull()
    }
  })

  it('an unregistered name is undecided by the send path too', () => {
    expect(evaluateMergeCondition('vip', null, member)).toBeNull()
  })

  it('the tool help names every condition', () => {
    for (const c of MERGE_CONDITIONS) expect(MERGE_TAG_HELP).toContain(`{{#if ${c.name}`)
    expect(MERGE_TAG_HELP).toContain('{{#unless')
    expect(MERGE_TAG_HELP).toContain('{{else}}')
  })
})

describe('subjects', () => {
  it('checkSubject accepts a valid block and refuses a broken one', () => {
    expect(() => checkSubject('{{#if first_name}}{{first_name}}, {{/if}}your week')).not.toThrow()
    expect(() => checkSubject('{{#if first_name}}{{first_name}}, your week')).toThrow(/The subject: .*never closed/)
    expect(() => checkSubject(undefined)).not.toThrow()
  })

  it('the resend subject is checked the same way', () => {
    expect(resendColumns({ after_hours: 48, subject: '{{#unless member}}Still time{{/unless}}' }))
      .toMatchObject({ resend_enabled: true, resend_subject: '{{#unless member}}Still time{{/unless}}' })
    expect(() => resendColumns({ after_hours: 48, subject: '{{#if vip}}x{{/if}}' })).toThrow(/The resend subject: /)
    expect(() => resendColumns({ after_hours: 48, subject: '{{nickname}}' })).toThrow(/The resend subject: .*nickname/)
  })
})
