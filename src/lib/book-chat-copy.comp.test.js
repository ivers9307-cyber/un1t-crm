// UN1TCOMP.1 — "we've added complimentary credits" is customer copy:
// operator-editable (settings.customer_agent.comp_credits_confirmation_text),
// plain, with {credits}, {date} and {studio} filled from the grant.
import { describe, it, expect } from 'vitest'
import { DEFAULT_COMP_CHAT_TEXT, compCreditsChatText, readCompChatTemplate } from './book-chat-copy.js'

describe('the complimentary credits message', () => {
  it('one plain default, no studio name hard-coded', () => {
    expect(DEFAULT_COMP_CHAT_TEXT).toBe("Good news, we've added {credits} to your {studio} account, use them by {date}. See you soon.")
    expect(DEFAULT_COMP_CHAT_TEXT).not.toMatch(/[—–]|\p{Extended_Pictographic}|Hatch/u)
  })

  it('fills {credits} (singular or plural), {date} and {studio}', () => {
    expect(compCreditsChatText({ credits: 2, date: 'Thu 5 Nov', studio: 'UN1T Hatch Street' }))
      .toBe("Good news, we've added 2 complimentary credits to your UN1T Hatch Street account, use them by Thu 5 Nov. See you soon.")
    expect(compCreditsChatText({ credits: 1, date: 'Thu 5 Nov', studio: 'UN1T Hatch Street' }))
      .toBe("Good news, we've added 1 complimentary credit to your UN1T Hatch Street account, use them by Thu 5 Nov. See you soon.")
  })

  it('the operator text wins; blank is the default; dashes become plain', () => {
    expect(compCreditsChatText({ credits: 3, date: 'Fri 6 Nov', template: '{credits} — yours until {date}' })).toBe('3 complimentary credits, yours until Fri 6 Nov')
    expect(compCreditsChatText({ credits: 3, date: 'Fri 6 Nov', studio: 'S', template: '  ' })).toBe(compCreditsChatText({ credits: 3, date: 'Fri 6 Nov', studio: 'S' }))
  })

  it('drops what it cannot fill rather than leaving a placeholder', () => {
    expect(compCreditsChatText({ credits: 2, date: 'Thu 5 Nov' }))
      .toBe("Good news, we've added 2 complimentary credits to your account, use them by Thu 5 Nov. See you soon.")
    expect(compCreditsChatText({ credits: 2, studio: 'S' })).toBe("Good news, we've added 2 complimentary credits to your S account. See you soon.")
  })

  it('reads the studio text from settings.customer_agent.comp_credits_confirmation_text; unset is null', async () => {
    const dbWith = (settings) => ({
      from: (t) => {
        const r = t === 'org_settings' ? { data: null, error: null } : { data: { settings }, error: null }
        const b = { select: () => b, eq: () => b, maybeSingle: async () => r }
        return b
      },
    })
    expect(await readCompChatTemplate(dbWith({ customer_agent: { comp_credits_confirmation_text: ' Added {credits}. ' } }), 'L1')).toEqual({ template: 'Added {credits}.', error: null })
    expect(await readCompChatTemplate(dbWith({}), 'L1')).toEqual({ template: null, error: null })
  })
})
