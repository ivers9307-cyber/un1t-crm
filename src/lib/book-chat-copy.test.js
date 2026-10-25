// BOOKCHATCOPY.1 (C111) — the staff Book panel's chat confirmation is
// customer copy: operator-editable, plain, no em-dashes, no emoji. It uses
// the studio's booking confirmation message (settings.customer_agent
// .booking_confirmation_text, the field Mia's approved bookings already use),
// with the same default.
import { describe, it, expect, vi } from 'vitest'
import { DEFAULT_BOOK_CHAT_TEXT, bookChatConfirmationText, readBookChatTemplate } from './book-chat-copy.js'
import { DEFAULT_BOOKING_CONFIRMATION_TEXT } from './agent/notify.js'

const EMOJI = /\p{Extended_Pictographic}/u

describe('bookChatConfirmationText', () => {
  it('the default is plain: no em-dash, no en-dash, no emoji', () => {
    expect(DEFAULT_BOOK_CHAT_TEXT).not.toMatch(/[—–]/)
    expect(DEFAULT_BOOK_CHAT_TEXT).not.toMatch(EMOJI)
  })

  it('is the same default as the booking confirmation Mia sends, so one setting reads one way', () => {
    expect(DEFAULT_BOOK_CHAT_TEXT).toBe(DEFAULT_BOOKING_CONFIRMATION_TEXT)
  })

  it('fills {class} with what was booked', () => {
    expect(bookChatConfirmationText({ what: 'HIIT, Tue 3 Oct 18:30' }))
      .toBe("Good news, you're booked in for HIIT, Tue 3 Oct 18:30. See you there.")
  })

  it('uses the operator template when set', () => {
    expect(bookChatConfirmationText({ what: 'Consultation, Friday 6 October at 10:00am', template: 'You are in: {class}.' }))
      .toBe('You are in: Consultation, Friday 6 October at 10:00am.')
  })

  it('a blank template falls back to the default', () => {
    expect(bookChatConfirmationText({ what: 'HIIT', template: '   ' })).toBe("Good news, you're booked in for HIIT. See you there.")
  })

  it('drops the "for {class}" clause when nothing is known, rather than a dangling "for ."', () => {
    expect(bookChatConfirmationText({ what: '' })).toBe("Good news, you're booked in. See you there.")
  })

  it('never ships an em-dash, even from an operator template or a class name', () => {
    const out = bookChatConfirmationText({ what: 'Strength — Upper', template: 'Booked — {class}' })
    expect(out).not.toMatch(/[—–]/)
  })
})

describe('readBookChatTemplate', () => {
  // MIAORG.1 — the template now comes through resolveAgentSettings: the
  // location row, then its organisation's layer (`org`).
  const dbWith = (result, org = null) => ({
    from: (t) => {
      expect(['locations', 'org_settings']).toContain(t)
      const r = t === 'org_settings' ? { data: org ? { customer_agent: org } : null, error: null } : result
      const b = { select: () => b, eq: () => b, maybeSingle: async () => r }
      return b
    },
  })

  it('returns the operator text from settings.customer_agent.booking_confirmation_text', async () => {
    const r = await readBookChatTemplate(dbWith({ data: { settings: { customer_agent: { booking_confirmation_text: ' You are in: {class}. ' } } }, error: null }), 'L1')
    expect(r).toEqual({ template: 'You are in: {class}.', error: null })
  })

  it('unset is null (the default applies)', async () => {
    expect(await readBookChatTemplate(dbWith({ data: { settings: {} }, error: null }), 'L1')).toEqual({ template: null, error: null })
  })

  it('a failed read is reported as an error, not as "unset"', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await readBookChatTemplate(dbWith({ data: null, error: { message: 'boom' } }), 'L1')
    expect(r.template).toBeNull()
    expect(r.error).toBe('read_failed') // the resolver logs 'boom' itself
    err.mockRestore()
  })

  it('a throwing client is reported as an error too', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await readBookChatTemplate({ from: () => { throw new Error('down') } }, 'L1')
    expect(r).toEqual({ template: null, error: 'read_failed' })
    err.mockRestore()
  })

  // MIAORG.1 Task 2 — resolved settings.
  it('an org-only booking_confirmation_text reaches a studio that sets none', async () => {
    const r = await readBookChatTemplate(dbWith({ data: { id: 'L1', organization_id: 'O1', settings: { customer_agent: { enabled: true } } }, error: null }, { booking_confirmation_text: 'Org: {class}.' }), 'L1')
    expect(r).toEqual({ template: 'Org: {class}.', error: null })
  })

  it("no behaviour change: Stillorgan's blob (no text) and Hatch (no blob) are unset with the org layer null", async () => {
    const { STILLORGAN_BLOB } = await import('./agent/settings-fixtures.test-helpers')
    expect(await readBookChatTemplate(dbWith({ data: { id: 'L1', organization_id: 'O1', settings: { customer_agent: STILLORGAN_BLOB } }, error: null }), 'L1')).toEqual({ template: null, error: null })
    expect(await readBookChatTemplate(dbWith({ data: { id: 'L1', organization_id: 'O1', settings: {} }, error: null }), 'L1')).toEqual({ template: null, error: null })
  })
})
