// UN1TMOVE.2 — "your booking was moved" is customer copy: operator-editable
// (settings.customer_agent.class_move_confirmation_text), plain, the same
// default wherever it is sent (the staff Move and Mia's approved move cards).
import { describe, it, expect } from 'vitest'
import { DEFAULT_MOVE_CHAT_TEXT, moveChatConfirmationText, readMoveChatTemplate } from './book-chat-copy.js'
import { DEFAULT_CLASS_MOVE_CONFIRMATION_TEXT, buildClassMoveConfirmationText } from './agent/notify.js'

describe('the class move confirmation', () => {
  it('one default, plain, in both renderers', () => {
    expect(DEFAULT_MOVE_CHAT_TEXT).toBe(DEFAULT_CLASS_MOVE_CONFIRMATION_TEXT)
    expect(DEFAULT_MOVE_CHAT_TEXT).toBe('All sorted, your booking has been moved from {from} to {to}. See you there.')
    expect(DEFAULT_MOVE_CHAT_TEXT).not.toMatch(/[—–]|\p{Extended_Pictographic}/u)
  })

  it('fills {from} and {to}; the operator text wins; blank is the default; the two renderers agree', () => {
    const from = 'HIIT, Fri 30 Oct 18:30'
    const to = 'Strength, Fri 30 Oct 20:00'
    expect(moveChatConfirmationText({ from, to })).toBe('All sorted, your booking has been moved from HIIT, Fri 30 Oct 18:30 to Strength, Fri 30 Oct 20:00. See you there.')
    expect(moveChatConfirmationText({ from, to, template: 'Moved: {from} → {to}' })).toBe('Moved: HIIT, Fri 30 Oct 18:30 → Strength, Fri 30 Oct 20:00')
    expect(moveChatConfirmationText({ from, to, template: '   ' })).toBe(moveChatConfirmationText({ from, to }))
    for (const template of [null, 'You are now in {to} (was {from}) — enjoy']) {
      expect(buildClassMoveConfirmationText({ from, to, template })).toBe(moveChatConfirmationText({ from, to, template }))
    }
    expect(moveChatConfirmationText({ from, to, template: 'A — B {to}' })).not.toMatch(/[—–]/)
  })

  it('drops a clause it cannot fill rather than a dangling "from ."', () => {
    expect(moveChatConfirmationText({ to: 'Strength, Fri 18:30' })).toBe('All sorted, your booking has been moved to Strength, Fri 18:30. See you there.')
    expect(moveChatConfirmationText({})).toBe('All sorted, your booking has been moved. See you there.')
  })

  it('reads the studio text from settings.customer_agent.class_move_confirmation_text; unset is null', async () => {
    const dbWith = (settings) => ({
      from: (t) => {
        const r = t === 'org_settings' ? { data: null, error: null } : { data: { settings }, error: null }
        const b = { select: () => b, eq: () => b, maybeSingle: async () => r }
        return b
      },
    })
    expect(await readMoveChatTemplate(dbWith({ customer_agent: { class_move_confirmation_text: ' Now {to}. ' } }), 'L1')).toEqual({ template: 'Now {to}.', error: null })
    expect(await readMoveChatTemplate(dbWith({}), 'L1')).toEqual({ template: null, error: null })
  })
})
