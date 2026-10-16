import { describe, it, expect } from 'vitest'
import { agentOptionId, buttonTapBody, interactiveReplyBody } from './whatsapp-inbound-tap'
import { buildInteractivePayload } from './whatsapp'
import { PICKER_ID_PREFIX } from './wa-studio-pick/config'

describe('buttonTapBody (template quick-reply, WABUTTONTAP.1)', () => {
  it('stores the tapped text when the payload is the default (same as the text)', () => {
    expect(buttonTapBody({ text: 'Book a consultation', payload: 'Book a consultation' })).toBe('Book a consultation')
  })
  it('keeps a custom payload beside the text, since nothing else can hold it', () => {
    expect(buttonTapBody({ text: 'First class', payload: 'WELCOME_FIRST_CLASS' }))
      .toBe('First class (button payload: WELCOME_FIRST_CLASS)')
  })
  it('falls back to the payload when there is no text', () => {
    expect(buttonTapBody({ payload: 'WELCOME_CONSULT' })).toBe('WELCOME_CONSULT')
  })
  it('is empty for a missing or empty button, so the agent gate reads it as empty', () => {
    expect(buttonTapBody(undefined)).toBe('')
    expect(buttonTapBody({ text: '  ', payload: '' })).toBe('')
  })
})

describe('interactiveReplyBody (session button / list reply)', () => {
  it("drops Mia's own opt_<n> ids: the title already says it", () => {
    expect(interactiveReplyBody({ type: 'button_reply', button_reply: { id: 'opt_0', title: '7am' } })).toBe('7am')
    expect(interactiveReplyBody({ type: 'list_reply', list_reply: { id: 'opt_7', title: 'Sat 9am' } })).toBe('Sat 9am')
  })
  it('keeps any other id beside the title (it was dropped before)', () => {
    expect(interactiveReplyBody({ type: 'button_reply', button_reply: { id: 'slot_123', title: '7am' } }))
      .toBe('7am (option id: slot_123)')
  })
  it('falls back to the id when the title is missing', () => {
    expect(interactiveReplyBody({ type: 'list_reply', list_reply: { id: 'slot_123' } })).toBe('slot_123')
  })
  it('is empty when there is no reply', () => {
    expect(interactiveReplyBody({ type: 'nfm_reply' })).toBe('')
    expect(interactiveReplyBody(undefined)).toBe('')
  })
})

describe("agentOptionId matches the ids Mia's interactive sends carry", () => {
  it('buttons and list rows both use it', () => {
    const buttons = buildInteractivePayload('353870000000', 'Pick', ['7am', '8am'])
    expect(buttons.interactive.action.buttons.map((b) => b.reply.id)).toEqual([agentOptionId(0), agentOptionId(1)])
    const list = buildInteractivePayload('353870000000', 'Pick', ['a', 'b', 'c', 'd'])
    expect(list.interactive.action.sections[0].rows.map((r) => r.id)).toEqual([0, 1, 2, 3].map(agentOptionId))
    // and the reader drops exactly these
    expect(interactiveReplyBody({ button_reply: { id: agentOptionId(2), title: 'x' } })).toBe('x')
  })
})

describe('studio picker taps (WASTUDIOPICK.1 F4)', () => {
  it("drops the picker's studio:<id> ids too: the title already says it", () => {
    const id = `${PICKER_ID_PREFIX}a0000000-0000-4000-8000-000000000002`
    expect(interactiveReplyBody({ type: 'button_reply', button_reply: { id, title: 'Hatch Street' } })).toBe('Hatch Street')
    expect(interactiveReplyBody({ type: 'list_reply', list_reply: { id, title: 'Hatch Street' } })).toBe('Hatch Street')
  })
  it('an id that merely contains studio: is still kept', () => {
    expect(interactiveReplyBody({ button_reply: { id: 'xstudio:a2', title: 'Hatch' } })).toBe('Hatch (option id: xstudio:a2)')
  })
})
