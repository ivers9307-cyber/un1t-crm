import { describe, it, expect } from 'vitest'
import {
  bodyVariableSlots,
  templateSendBlock,
  SEND_BLOCK_TEXT,
  initialTemplateValues,
  renderTemplatePreview,
  buildTemplateSend,
  templateHeaderMedia,
  renderSentTemplateBody,
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
  it('lets a FLOW button through: the send route mints its flow_token (WATPLSEND.1)', () => {
    expect(templateSendBlock(tpl({ components: [body('Hi {{1}}'), { type: 'BUTTONS', buttons: [{ type: 'FLOW', text: 'Book' }] }] }))).toBeNull()
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
    for (const key of ['header_media', 'header_value', 'button_value', 'named_variables']) {
      expect(typeof SEND_BLOCK_TEXT[key]).toBe('string')
      expect(SEND_BLOCK_TEXT[key]).not.toMatch(/—/)
    }
    expect(SEND_BLOCK_TEXT).not.toHaveProperty('flow_button')
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

// WATPLLOG.1 (C51) — the thread row must read what the customer read. Meta
// takes ONE value per DISTINCT {{n}}, in number order (buildTemplateSend builds
// exactly that), and fills every occurrence of {{n}} with the n-th value.
const sentBody = (...texts) => [{ type: 'body', parameters: texts.map((text) => ({ type: 'text', text })) }]

describe('renderSentTemplateBody', () => {
  it('fills by NUMBER, not by order of appearance: a repeat and a {{2}} before {{1}}', () => {
    const t = tpl({ components: [body('{{2}} then {{1}} and {{2}} again')] })
    expect(renderSentTemplateBody(t, sentBody('ALPHA', 'BETA'))).toBe('BETA then ALPHA and BETA again')
  })
  it('matches what buildTemplateSend actually sends for the same values', () => {
    const t = tpl({ components: [body('{{2}} then {{1}} and {{2}} again')] })
    const built = buildTemplateSend(t, { 1: 'ALPHA', 2: 'BETA' })
    expect(renderSentTemplateBody(t, built.payload.template_components)).toBe('BETA then ALPHA and BETA again')
  })
  it('accepts spaced placeholders ({{ 1 }}) the way bodyVariableSlots does', () => {
    expect(renderSentTemplateBody(tpl({ components: [body('Hi {{ 1 }}!')] }), sentBody('ALPHA'))).toBe('Hi ALPHA!')
  })
  it('ignores header and button components, and reads the body component case-insensitively', () => {
    const comps = [
      { type: 'header', parameters: [{ type: 'video', video: { link: 'https://example.test/v.mp4' } }] },
      { type: 'BODY', parameters: [{ type: 'text', text: 'ALPHA' }] },
      { type: 'button', sub_type: 'flow', index: '0', parameters: [{ type: 'action', action: { flow_token: 'c.l' } }] },
    ]
    expect(renderSentTemplateBody(tpl(), comps)).toBe('Hi ALPHA, are you still interested?')
  })
  it('leaves a slot with no value visible as {{n}} rather than silently blank', () => {
    expect(renderSentTemplateBody(tpl(), [])).toBe('Hi {{1}}, are you still interested?')
    expect(renderSentTemplateBody(tpl(), null)).toBe('Hi {{1}}, are you still interested?')
  })
  it('is null when the template has no body text; named placeholders are left as they are', () => {
    expect(renderSentTemplateBody(tpl({ components: [] }), sentBody('ALPHA'))).toBeNull()
    expect(renderSentTemplateBody(tpl({ components: [body('Hi {{first_name}}')] }), sentBody('ALPHA'))).toBe('Hi {{first_name}}')
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
    const t = tpl({ components: [body('Hi {{1}}'), { type: 'BUTTONS', buttons: [{ type: 'URL', url: 'https://pay.example.test/{{1}}' }] }] })
    expect(buildTemplateSend(t, { 1: 'Sam' })).toEqual({ ok: false, blocked: 'button_value' })
  })
  it('builds a FLOW-button template like any other: only the body goes up, the route adds the button', () => {
    const t = tpl({ name: 'book_first_visit', components: [body('Hi {{1}}'), { type: 'BUTTONS', buttons: [{ type: 'FLOW', text: 'Book' }] }] })
    expect(buildTemplateSend(t, { 1: 'Sam' })).toEqual({
      ok: true,
      payload: {
        type: 'template',
        template_name: 'book_first_visit',
        template_language: 'en',
        template_components: [{ type: 'body', parameters: [{ type: 'text', text: 'Sam' }] }],
      },
    })
  })
  it("falls back to 'en' only when the row has no language", () => {
    expect(buildTemplateSend(tpl({ language: null }), { 1: 'Sam' }).payload.template_language).toBe('en')
  })
})

describe('pasted whitespace (Meta 132018 refuses newlines, tabs, 4+ spaces)', () => {
  it('collapses every whitespace run in a value to one space before sending', () => {
    const out = buildTemplateSend(tpl(), { 1: '  Ann\n\tMarie    Lee ' })
    expect(out.ok).toBe(true)
    expect(out.payload.template_components[0].parameters[0].text).toBe('Ann Marie Lee')
  })
  it('the preview shows the same collapsed value', () => {
    expect(renderTemplatePreview(tpl(), { 1: 'Ann\nMarie' })).toBe('Hi Ann Marie, are you still interested?')
  })
  it('a value that is only whitespace is still missing', () => {
    expect(buildTemplateSend(tpl(), { 1: ' \n\t ' })).toEqual({ ok: false, missing: [1] })
  })
})

describe('templateHeaderMedia', () => {
  it('names the media a template header attaches, or null', () => {
    expect(templateHeaderMedia(tpl({ components: [{ type: 'HEADER', format: 'VIDEO' }, body('Hi')] }))).toBe('video')
    expect(templateHeaderMedia(tpl({ components: [{ type: 'HEADER', format: 'IMAGE' }, body('Hi')] }))).toBe('image')
    expect(templateHeaderMedia(tpl({ components: [{ type: 'HEADER', format: 'DOCUMENT' }, body('Hi')] }))).toBe('document')
    expect(templateHeaderMedia(tpl({ components: [{ type: 'HEADER', format: 'TEXT', text: 'Hey' }, body('Hi')] }))).toBe(null)
    expect(templateHeaderMedia(tpl())).toBe(null)
    expect(templateHeaderMedia({ name: 'x' })).toBe(null)
    expect(templateHeaderMedia(null)).toBe(null)
  })
})
