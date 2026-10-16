// WASTUDIOPICK.1 — ad, reply and tap signals. Fictional ids only.
import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../log', () => ({ logWarn: vi.fn() }))
import { adSignal, replySignal, tapSignal } from './signals.js'
import { logWarn } from '../log'

// Chainable thenable fake: tables = { name: rows[] }, fault = { table, error }.
function makeDb(tables, fault) {
  return {
    from: (table) => {
      const filters = []
      let max = Infinity
      const run = () => (fault && fault.table === table
        ? { data: null, error: fault.error }
        : { data: (tables[table] || []).filter((r) => filters.every((f) => f(r))).slice(0, max), error: null })
      const b = {
        select: () => b,
        eq: (c, v) => { filters.push((r) => r[c] === v); return b },
        in: (c, vs) => { filters.push((r) => vs.includes(r[c])); return b },
        limit: (n) => { max = n; return b },
        then: (res, rej) => Promise.resolve(run()).then(res, rej),
      }
      return b
    },
  }
}

beforeEach(() => { logWarn.mockClear() })

describe('adSignal', () => {
  it('one studio → it; two studios or none → null; non-ad referral → null', async () => {
    const db = makeDb({ ad_entities: [{ level: 'ad', external_id: 'AD1', location_id: 'a2' }, { level: 'ad', external_id: 'AD2', location_id: 'a1' }, { level: 'ad', external_id: 'AD2', location_id: 'a2' }] })
    expect(await adSignal(db, { source_type: 'ad', source_id: 'AD1' }, ['a1', 'a2'])).toBe('a2')
    expect(await adSignal(db, { source_type: 'ad', source_id: 'AD2' }, ['a1', 'a2'])).toBeNull()
    expect(await adSignal(db, { source_type: 'ad', source_id: 'AD9' }, ['a1', 'a2'])).toBeNull()
    expect(await adSignal(db, { source_type: 'post', source_id: 'AD1' }, ['a1', 'a2'])).toBeNull()
    expect(await adSignal(db, null, ['a1', 'a2'])).toBeNull()
  })
  it('only counts studios in the list, and only level=ad rows', async () => {
    const db = makeDb({ ad_entities: [{ level: 'ad', external_id: 'AD2', location_id: 'a1' }, { level: 'ad', external_id: 'AD2', location_id: 'a2' }, { level: 'campaign', external_id: 'AD3', location_id: 'a1' }] })
    expect(await adSignal(db, { source_type: 'ad', source_id: 'AD2' }, ['a1'])).toBe('a1')
    expect(await adSignal(db, { source_type: 'ad', source_id: 'AD3' }, ['a1', 'a2'])).toBeNull()
  })
})

describe('replySignal', () => {
  it('the replied-to message’s studio when listed', async () => {
    const db = makeDb({ whatsapp_messages: [{ wa_message_id: 'wamid.X', location_id: 'a2' }] })
    expect(await replySignal(db, 'wamid.X', ['a1', 'a2'])).toBe('a2')
    expect(await replySignal(db, 'wamid.X', ['a1'])).toBeNull()
    expect(await replySignal(db, null, ['a1', 'a2'])).toBeNull()
  })
})

describe('tapSignal', () => {
  it('only studio:<listed id> (Review Focus 1)', () => {
    const tap = (id) => ({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: 'x' } } })
    expect(tapSignal(tap('studio:a2'), ['a1', 'a2'])).toBe('a2')
    expect(tapSignal(tap('studio:a9'), ['a1', 'a2'])).toBeNull()
    expect(tapSignal(tap('opt_0'), ['a1', 'a2'])).toBeNull()
    expect(tapSignal({ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'studio:a1' } } }, ['a1', 'a2'])).toBe('a1')
    expect(tapSignal({ type: 'text', text: { body: 'studio:a1' } }, ['a1', 'a2'])).toBeNull()
  })
})

describe('failed reads', () => {
  it('a failed read is null, logged', async () => {
    const adDb = makeDb({}, { table: 'ad_entities', error: { message: 'boom' } })
    expect(await adSignal(adDb, { source_type: 'ad', source_id: 'AD1' }, ['a1', 'a2'])).toBeNull()
    expect(logWarn).toHaveBeenCalledTimes(1)
    expect(logWarn.mock.calls[0][0]).toBe('wa-studio-pick')
    const msgDb = makeDb({}, { table: 'whatsapp_messages', error: { message: 'boom' } })
    expect(await replySignal(msgDb, 'wamid.X', ['a1', 'a2'])).toBeNull()
    expect(logWarn).toHaveBeenCalledTimes(2)
  })
})
