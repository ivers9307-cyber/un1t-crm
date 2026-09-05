// src/lib/whatsapp-coexistence.test.js
import { describe, it, expect } from 'vitest'
import { normalizeWaPhone, parseEchoMessages, parseSyncContacts, parseHistoryMessages, nextHistorySyncState, effectiveHistorySyncStatus, parseAccountUpdateEvent, nextCoexistenceLinkState, COEX_LINK_EVENTS } from './whatsapp-coexistence.js'

describe('normalizeWaPhone', () => {
  it('yields both + and no-+ forms, stripping non-digits', () => {
    expect(normalizeWaPhone('+353 87 000 0000')).toEqual({ withPlus: '+353870000000', without: '353870000000' })
    expect(normalizeWaPhone('353870000000')).toEqual({ withPlus: '+353870000000', without: '353870000000' })
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

describe('nextHistorySyncState', () => {
  const NOW = '2026-07-16T12:00:00.000Z'
  it('preserves started_at and marks importing while progress < 100', () => {
    const cur = { status: 'pending', started_at: '2026-07-16T10:00:00.000Z' }
    const val = { history: [{ metadata: { progress: '40' } }] }
    expect(nextHistorySyncState(cur, val, NOW)).toEqual({
      status: 'importing', progress: 40, started_at: '2026-07-16T10:00:00.000Z', updated_at: NOW,
    })
  })
  it('marks imported when progress reaches 100 (takes the max across chunks)', () => {
    const cur = { status: 'importing', started_at: '2026-07-16T10:00:00.000Z', progress: 40 }
    const val = { history: [{ metadata: { progress: 80 } }, { metadata: { progress: 100 } }] }
    expect(nextHistorySyncState(cur, val, NOW)).toEqual({
      status: 'imported', progress: 100, started_at: '2026-07-16T10:00:00.000Z', updated_at: NOW,
    })
  })
  it('marks declined when a history item carries a non-empty errors array', () => {
    const cur = { status: 'pending', started_at: '2026-07-16T10:00:00.000Z' }
    const val = { history: [{ errors: [{ code: 100, title: 'declined' }] }] }
    const out = nextHistorySyncState(cur, val, NOW)
    expect(out.status).toBe('declined')
    expect(out.started_at).toBe('2026-07-16T10:00:00.000Z')
    expect(out.updated_at).toBe(NOW)
  })
  it('uses now as started_at when there was no prior state', () => {
    expect(nextHistorySyncState(null, { history: [{ metadata: { progress: 10 } }] }, NOW).started_at).toBe(NOW)
  })
})

describe('effectiveHistorySyncStatus', () => {
  const start = '2026-07-16T00:00:00.000Z'
  const within = Date.parse('2026-07-16T10:00:00.000Z')      // 10h later
  const past = Date.parse('2026-07-17T06:00:00.000Z')        // 30h later
  it('returns the status unchanged when not pending/importing', () => {
    expect(effectiveHistorySyncStatus('imported', start, past)).toBe('imported')
    expect(effectiveHistorySyncStatus('declined', start, past)).toBe('declined')
  })
  it('keeps pending/importing within 24h', () => {
    expect(effectiveHistorySyncStatus('importing', start, within)).toBe('importing')
  })
  it('flips pending/importing to expired past 24h', () => {
    expect(effectiveHistorySyncStatus('importing', start, past)).toBe('expired')
    expect(effectiveHistorySyncStatus('pending', start, past)).toBe('expired')
  })
  it('is null-safe', () => {
    expect(effectiveHistorySyncStatus(null, start, past)).toBeNull()
    expect(effectiveHistorySyncStatus('importing', null, past)).toBe('importing')
  })
})

describe('parseAccountUpdateEvent', () => {
  it('returns the event name uppercased', () => {
    expect(parseAccountUpdateEvent({ event: 'ACCOUNT_OFFBOARDED' })).toBe('ACCOUNT_OFFBOARDED')
    expect(parseAccountUpdateEvent({ event: 'account_reconnected' })).toBe('ACCOUNT_RECONNECTED')
  })
  it('returns null when absent or not a string', () => {
    expect(parseAccountUpdateEvent({})).toBeNull()
    expect(parseAccountUpdateEvent(null)).toBeNull()
    expect(parseAccountUpdateEvent({ event: 42 })).toBeNull()
  })
})

describe('nextCoexistenceLinkState', () => {
  const NOW = '2026-07-31T10:00:00.000Z'

  it('OFFBOARDED marks the link down and stamps offboarded_at', () => {
    const next = nextCoexistenceLinkState(null, COEX_LINK_EVENTS.OFFBOARDED, NOW)
    expect(next).toEqual({
      status: 'offboarded', event: 'ACCOUNT_OFFBOARDED',
      offboarded_at: NOW, reconnected_at: null, updated_at: NOW,
    })
  })

  it('keeps the FIRST offboarded_at when Meta resends OFFBOARDED', () => {
    const first = nextCoexistenceLinkState(null, COEX_LINK_EVENTS.OFFBOARDED, NOW)
    const later = nextCoexistenceLinkState(first, COEX_LINK_EVENTS.OFFBOARDED, '2026-07-31T10:30:00.000Z')
    expect(later.offboarded_at).toBe(NOW)                       // outage clock not reset
    expect(later.updated_at).toBe('2026-07-31T10:30:00.000Z')   // but freshness moves
  })

  it('RECONNECTED clears the outage and stamps reconnected_at', () => {
    const down = nextCoexistenceLinkState(null, COEX_LINK_EVENTS.OFFBOARDED, NOW)
    const up = nextCoexistenceLinkState(down, COEX_LINK_EVENTS.RECONNECTED, '2026-07-31T10:05:00.000Z')
    expect(up.status).toBe('connected')
    expect(up.offboarded_at).toBeNull()
    expect(up.reconnected_at).toBe('2026-07-31T10:05:00.000Z')
  })

  // account_update is a SHARED webhook field: review / violation / restriction
  // / partner events ride it too. None may touch the coexistence link state —
  // a violation event must not read as "the phone was reinstalled", and must
  // not clear a real outage either.
  it('leaves state untouched for unrelated account_update events', () => {
    const down = nextCoexistenceLinkState(null, COEX_LINK_EVENTS.OFFBOARDED, NOW)
    for (const ev of ['ACCOUNT_VIOLATION', 'ACCOUNT_RESTRICTION', 'PARTNER_ADDED', 'ACCOUNT_UPDATE', null]) {
      expect(nextCoexistenceLinkState(down, ev, '2026-08-01T00:00:00.000Z')).toBe(down)
    }
    expect(nextCoexistenceLinkState(null, 'ACCOUNT_VIOLATION', NOW)).toBeNull()
  })
})
