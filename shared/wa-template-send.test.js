import { describe, it, expect } from 'vitest'
import {
  bodyVariableSlots,
  templateSendBlock,
  SEND_BLOCK_TEXT,
  initialTemplateValues,
  renderTemplatePreview,
  buildTemplateSend,
} from './wa-template-send.js'

// Row shapes are the live whatsapp_templates `components` (Meta's template
// definition), trimmed to what these rules read.
const body = (text) => ({ type: 'BODY', text })
const tpl = (over = {}) => ({
  id: 't1',
  name: 'reopen_message_',
  language: 'en',
  status: 'APPROVED',
  components: [body('Hi {{1}}, are you still interested?')],
  header_media_url: null,
  ...over,
})

describe('bodyVariableSlots', () => {
  it('lists the numeric body variables, distinct and ascending', () => {
    expect(bodyVariableSlots(tpl({ components: [body('{{2}} then {{1}} then {{2}}')] }))).toEqual([1, 2])
  })
  it('is empty for a body without variables, or no body at all', () => {
    expect(bodyVariableSlots(tpl({ components: [body('Hello')] }))).toEqual([])
    expect(bodyVariableSlots(tpl({ components: [] }))).toEqual([])
    expect(bodyVariableSlots({})).toEqual([])
  })
})

describe('templateSendBlock', () => {
  it('lets a plain body-variable template through', () => {
    expect(templateSendBlock(tpl())).toBeNull()
  })
  it('lets a text header without a variable and static/quick-reply buttons through', () => {
    expect(templateSendBlock(tpl({
      components: [
        { type: 'HEADER', format: 'TEXT', text: 'Hello' },
        body('Hi {{1}}'),
        { type: 'BUTTONS', buttons: [{ type: 'URL', url: 'https://example.com/book' }, { type: 'QUICK_REPLY', text: 'Yes' }] },
      ],
    }))).toBeNull()
  })
  it('lets a media header through when the row stores its file (the route attaches it)', () => {
    expect(templateSendBlock(tpl({
      components: [{ type: 'HEADER', format: 'VIDEO' }, body('Hi {{1}}')],
      header_media_url: 'https://example.com/v.mp4',
    }))).toBeNull()
  })
  it('refuses a media header with no stored file', () => {
    expect(templateSendBlock(tpl({ components: [{ type: 'HEADER', format: 'IMAGE' }, body('Hi')] }))).toBe('header_media')
  })
  it('refuses a text header that needs a value', () => {
    expect(templateSendBlock(tpl({ components: [{ type: 'HEADER', format: 'TEXT', text: 'Hi {{1}}' }, body('x')] }))).toBe('header_value')
  })
  it('refuses a FLOW button (Meta needs a per-send flow_token: 131009)', () => {
    expect(templateSendBlock(tpl({ components: [body('Hi {{1}}'), { type: 'BUTTONS', buttons: [{ type: 'FLOW', text: 'Book' }] }] }))).toBe('flow_button')
  })
  it('refuses a dynamic URL button or a copy-code button (Meta needs a per-send value: 132012)', () => {
    expect(templateSendBlock(tpl({ components: [body('Hi {{1}}'), { type: 'BUTTONS', buttons: [{ type: 'URL', url: 'https://pay.example.com/{{1}}' }] }] }))).toBe('button_value')
    expect(templateSendBlock(tpl({ components: [body('Code'), { type: 'BUTTONS', buttons: [{ type: 'COPY_CODE' }] }] }))).toBe('button_value')
  })
  it('refuses named variables and numbering with a gap', () => {
    expect(templateSendBlock(tpl({ components: [body('Hi {{first_name}}')] }))).toBe('named_variables')
    expect(templateSendBlock(tpl({ components: [body('Hi {{1}} and {{3}}')] }))).toBe('named_variables')
  })
  it('has words for every reason it can return', () => {
    for (const key of ['header_media', 'header_value', 'flow_button', 'button_value', 'named_variables']) {
      expect(typeof SEND_BLOCK_TEXT[key]).toBe('string')
      expect(SEND_BLOCK_TEXT[key]).not.toMatch(/—/)
    }
  })
})

describe('initialTemplateValues', () => {
  it('fills {{1}} with the first name, trimmed', () => {
    expect(initialTemplateValues(tpl(), '  Sam ')).toEqual({ 1: 'Sam' })
  })
  it('fills nothing without a name or without a {{1}}', () => {
    expect(initialTemplateValues(tpl(), null)).toEqual({})
    expect(initialTemplateValues(tpl(), '   ')).toEqual({})
    expect(initialTemplateValues(tpl({ components: [body('No variables')] }), 'Sam')).toEqual({})
  })
})

describe('renderTemplatePreview', () => {
  it('substitutes filled slots and leaves blank ones visible', () => {
    const t = tpl({ components: [body('Hi {{1}}, class at {{2}}. See you {{1}}!')] })
    expect(renderTemplatePreview(t, { 1: 'Sam', 2: '  ' })).toBe('Hi Sam, class at {{2}}. See you Sam!')
  })
  it('reads the BODY component (there is no body_text column)', () => {
    expect(renderTemplatePreview(tpl(), {})).toBe('Hi {{1}}, are you still interested?')
  })
})

describe('buildTemplateSend', () => {
  it("sends the row's own language, not a hard-coded 'en' (Meta 132001)", () => {
    const res = buildTemplateSend(tpl({ name: 'hello_world', language: 'en_US', components: [body('Hello World')] }), {})
    expect(res).toEqual({
      ok: true,
      payload: { type: 'template', template_name: 'hello_world', template_language: 'en_US', template_components: [] },
    })
  })
  it('sends one body parameter per slot, in order, trimmed (Meta 132000 without them)', () => {
    const t = tpl({ components: [body('Hi {{1}}, class at {{2}}')] })
    expect(buildTemplateSend(t, { 2: ' 6pm ', 1: 'Sam' })).toEqual({
      ok: true,
      payload: {
        type: 'template',
        template_name: 'reopen_message_',
        template_language: 'en',
        template_components: [{ type: 'body', parameters: [{ type: 'text', text: 'Sam' }, { type: 'text', text: '6pm' }] }],
      },
    })
  })
  it('never sends a blank value: names the missing slots instead', () => {
    const t = tpl({ components: [body('Hi {{1}}, class at {{2}}')] })
    expect(buildTemplateSend(t, { 1: 'Sam', 2: '   ' })).toEqual({ ok: false, missing: [2] })
    expect(buildTemplateSend(t, {})).toEqual({ ok: false, missing: [1, 2] })
  })
  it('refuses a template the picker cannot send, with the reason', () => {
    const t = tpl({ components: [body('Hi {{1}}'), { type: 'BUTTONS', buttons: [{ type: 'FLOW' }] }] })
    expect(buildTemplateSend(t, { 1: 'Sam' })).toEqual({ ok: false, blocked: 'flow_button' })
  })
  it("falls back to 'en' only when the row has no language", () => {
    expect(buildTemplateSend(tpl({ language: null }), { 1: 'Sam' }).payload.template_language).toBe('en')
  })
})
