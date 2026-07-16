// src/lib/whatsapp-coexistence.test.js
import { describe, it, expect } from 'vitest'
import { normalizeWaPhone, parseEchoMessages, parseSyncContacts, parseHistoryMessages } from './whatsapp-coexistence.js'

describe('normalizeWaPhone', () => {
  it('yields both + and no-+ forms, stripping non-digits', () => {
    expect(normalizeWaPhone('+353 87 314 7675')).toEqual({ withPlus: '+353873147675', without: '353873147675' })
    expect(normalizeWaPhone('353873147675')).toEqual({ withPlus: '+353873147675', without: '353873147675' })
  })
  it('returns null for empty', () => {
    expect(normalizeWaPhone('')).toBeNull()
    expect(normalizeWaPhone(null)).toBeNull()
  })
})

describe('parseEchoMessages', () => {
  it('maps smb_message_echoes into outbound message descriptors', () => {
    const value = { metadata: { phone_number_id: '999' }, message_echoes: [
      { id: 'wamid.ECHO1', from: '353111', to: '353222', type: 'text', text: { body: 'sent from phone' }, timestamp: '1700000000' },
    ] }
    expect(parseEchoMessages(value)).toEqual([
      { waMessageId: 'wamid.ECHO1', peerPhone: '353222', direction: 'outbound', messageType: 'text', body: 'sent from phone', tsSeconds: 1700000000 },
    ])
  })
  it('returns [] when no echoes', () => {
    expect(parseEchoMessages({})).toEqual([])
  })
})

describe('parseSyncContacts', () => {
  it('extracts phone + name from smb_app_state_sync contact upserts', () => {
    const value = { state_sync: [
      { type: 'contact', action: 'add', contact: { full_name: 'Jane Doe', phone_number: '+353861234567' } },
      { type: 'contact', action: 'remove', contact: { phone_number: '+353860000000' } },
    ] }
    expect(parseSyncContacts(value)).toEqual([{ phone: '+353861234567', name: 'Jane Doe' }])
  })
  it('ignores non-contact / non-upsert entries', () => {
    expect(parseSyncContacts({ state_sync: [{ type: 'settings' }] })).toEqual([])
  })
})

describe('parseHistoryMessages', () => {
  it('flattens history threads into message descriptors with direction', () => {
    const value = { history: [ { threads: [
      { messages: [
        { id: 'wamid.H1', from: '353222', to: '353111', type: 'text', text: { body: 'old inbound' }, timestamp: '1699000000' },
        { id: 'wamid.H2', from: '353111', to: '353222', type: 'text', text: { body: 'old outbound' }, timestamp: '1699000100' },
      ] },
    ] } ], metadata: { phone_number_id: '999' } }
    const out = parseHistoryMessages(value, '353111')
    expect(out).toEqual([
      { waMessageId: 'wamid.H1', peerPhone: '353222', direction: 'inbound', messageType: 'text', body: 'old inbound', tsSeconds: 1699000000 },
      { waMessageId: 'wamid.H2', peerPhone: '353222', direction: 'outbound', messageType: 'text', body: 'old outbound', tsSeconds: 1699000100 },
    ])
  })
})
