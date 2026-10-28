// ROLEUI.1 — the phone contact screen's action buttons follow the server's
// per-contact flags (GET /api/contacts/[id]/command-centre?scope=drawer →
// `permissions`), never canMobile at the ACTIVE studio.
import { describe, it, expect } from 'vitest'
import { contactActionFlags } from './contact-actions'

const ALL = { whatsapp: true, email: true, kudos: true }
const FULL_CONTACT = { phone: '+353870000000', wa_phone: '+353870000000', email: 'member.one@example.com' }
const NONE = {
  whatsapp: false, email: false,
  cancelFormEmail: false, cancelFormWhatsApp: false, cancelForm: false, kudos: false, note: false, task: false,
}

describe('contactActionFlags', () => {
  it('shows each action the server allows for a contact with the address it needs', () => {
    expect(contactActionFlags(ALL, FULL_CONTACT)).toEqual({
      whatsapp: true, email: true,
      cancelFormEmail: true, cancelFormWhatsApp: true, cancelForm: true, kudos: true, note: true, task: false,
    })
  })

  it('CARDLENS-M.8: Task follows `task`; the cancel form follows `cancel_form` (the primary) once the server sends it', () => {
    expect(contactActionFlags({ ...ALL, task: true }, FULL_CONTACT).task).toBe(true)
    // Acting at Hatch with no channels there, the form is still allowed at the primary.
    const atHatch = contactActionFlags({ whatsapp: false, email: false, cancel_form: true }, FULL_CONTACT)
    expect(atHatch).toMatchObject({ whatsapp: false, email: false, cancelForm: true, cancelFormEmail: true, cancelFormWhatsApp: true })
    expect(contactActionFlags({ ...ALL, cancel_form: false }, FULL_CONTACT).cancelForm).toBe(false)
    expect(contactActionFlags({ cancel_form: true }, { email: null, phone: null }).cancelForm).toBe(false)
  })

  it('CARDLENS-M.4: the note composer follows `note`; a server without the key shows it as before', () => {
    expect(contactActionFlags({ ...ALL, note: false }, FULL_CONTACT).note).toBe(false)
    expect(contactActionFlags({ ...ALL, note: true }, FULL_CONTACT).note).toBe(true)
    expect(contactActionFlags({ whatsapp: true }, FULL_CONTACT).note).toBe(true)
  })

  it('hides everything until the flags arrive, and when they could not be read (fail closed)', () => {
    expect(contactActionFlags(null, FULL_CONTACT)).toEqual(NONE)
    expect(contactActionFlags(undefined, FULL_CONTACT)).toEqual(NONE)
    expect(contactActionFlags('nope', FULL_CONTACT)).toEqual(NONE)
  })

  it('only an explicit true counts', () => {
    expect(contactActionFlags({ whatsapp: 'yes', email: {}, kudos: 'true', note: 'yes' }, FULL_CONTACT)).toEqual(NONE)
  })

  it('needs the address each channel sends to', () => {
    const f = contactActionFlags(ALL, { phone: null, wa_phone: null, email: null })
    expect(f).toEqual({ ...NONE, kudos: true, note: true })
  })

  it('WhatsApp goes to wa_phone or, failing that, phone', () => {
    expect(contactActionFlags(ALL, { wa_phone: '+353870000000' })).toMatchObject({ whatsapp: true })
    expect(contactActionFlags(ALL, { phone: '+353870000000' })).toMatchObject({ whatsapp: true })
  })

  // TWILIO-RETIRE.1 — there is no Text action any more, even if a stale
  // server still sends an `sms` flag.
  it('never offers SMS', () => {
    expect('sms' in contactActionFlags({ ...ALL, sms: true }, FULL_CONTACT)).toBe(false)
  })

  it('the cancellation form offers only the channels that can carry it (no empty sheet)', () => {
    // email allowed but no address; WhatsApp not allowed: nothing to offer
    const f = contactActionFlags({ whatsapp: false, email: true }, { phone: '+353870000000' })
    expect(f).toMatchObject({ cancelFormEmail: false, cancelFormWhatsApp: false, cancelForm: false })
    // WhatsApp allowed with a phone: the WhatsApp option only
    const g = contactActionFlags({ whatsapp: true, email: true }, { phone: '+353870000000' })
    expect(g).toMatchObject({ cancelFormEmail: false, cancelFormWhatsApp: true, cancelForm: true })
  })

  it('a missing contact shows no channel', () => {
    expect(contactActionFlags(ALL, null)).toEqual({ ...NONE, kudos: true, note: true })
  })
})
