import { describe, it, expect } from 'vitest'
import { isBsuid, recipientFields, inboundSender, conversationAddress } from './whatsapp-address.js'

const BSUID = 'IE.13491208655302741918'
const PARENT = 'IE.ENT.11815799212886844830'

describe('isBsuid', () => {
  it('recognises a BSUID and a parent BSUID', () => {
    expect(isBsuid(BSUID)).toBe(true)
    expect(isBsuid(PARENT)).toBe(true)
  })
  it('never mistakes a phone number for one', () => {
    for (const phone of ['353870000001', '+353870000001', '0870000001', '+1 650 555 1234']) {
      expect(isBsuid(phone)).toBe(false)
    }
  })
  it('is false for empty and non-string values', () => {
    for (const v of [null, undefined, '', '   ', 42, {}, 'IE.']) expect(isBsuid(v)).toBe(false)
  })
})

describe('recipientFields', () => {
  it('addresses a phone number with `to`', () => {
    expect(recipientFields('353870000001')).toEqual({ to: '353870000001' })
  })
  it('addresses a BSUID with `recipient` and never `to`', () => {
    expect(recipientFields(BSUID)).toEqual({ recipient: BSUID })
  })
})

describe('inboundSender', () => {
  it('reads a classic phone-only message', () => {
    const sender = inboundSender(
      { from: '353870000001', id: 'wamid.1' },
      [{ wa_id: '353870000001', profile: { name: 'Aoife' } }],
    )
    expect(sender).toEqual({ phone: '353870000001', bsuid: null, name: 'Aoife', address: '353870000001' })
  })

  it('reads a message that carries both a phone and a BSUID, and replies to the phone', () => {
    const sender = inboundSender(
      { from: '353870000001', from_user_id: BSUID },
      [{ wa_id: '353870000001', user_id: BSUID, profile: { name: 'Aoife' } }],
    )
    expect(sender).toEqual({ phone: '353870000001', bsuid: BSUID, name: 'Aoife', address: '353870000001' })
  })

  it('reads a phone-less message: no `from`, no `wa_id`', () => {
    const sender = inboundSender(
      { from_user_id: BSUID, from_parent_user_id: PARENT, id: 'wamid.2', type: 'text' },
      [{ profile: { name: 'Aoife', username: 'aoife.fit' }, user_id: BSUID, parent_user_id: PARENT }],
    )
    expect(sender).toEqual({ phone: null, bsuid: BSUID, name: 'Aoife', address: BSUID })
  })

  it('takes the BSUID from contacts[] when the message carries none', () => {
    const sender = inboundSender({ from: '353870000001' }, [{ wa_id: '353870000001', user_id: BSUID }])
    expect(sender.bsuid).toBe(BSUID)
  })

  it('never guesses a sender from a contacts[] that names several people', () => {
    const sender = inboundSender({ id: 'wamid.4' }, [{ user_id: BSUID }, { user_id: 'IE.999' }])
    expect(sender.address).toBe(null)
    expect(inboundSender({ id: 'wamid.5' }, [{ user_id: BSUID }]).address).toBe(BSUID)
  })

  it('answers nulls, never throws, for a message with no sender at all', () => {
    expect(inboundSender({ id: 'wamid.3' }, undefined)).toEqual({ phone: null, bsuid: null, name: null, address: null })
    expect(inboundSender(undefined, null)).toEqual({ phone: null, bsuid: null, name: null, address: null })
  })
})

describe('conversationAddress', () => {
  it('prefers the contact number, then the thread number, then the thread BSUID', () => {
    expect(conversationAddress({ wa_phone: '353870000002', wa_bsuid: BSUID }, { wa_phone: '353870000001' })).toBe('353870000001')
    expect(conversationAddress({ wa_phone: '353870000002', wa_bsuid: BSUID }, null)).toBe('353870000002')
    expect(conversationAddress({ wa_phone: null, wa_bsuid: BSUID }, { wa_phone: null })).toBe(BSUID)
    expect(conversationAddress({ wa_phone: null, wa_bsuid: null })).toBe(null)
  })
})
