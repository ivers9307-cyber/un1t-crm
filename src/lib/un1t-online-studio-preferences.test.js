import { describe, it, expect } from 'vitest'
import { ensureStudioPreferences, initialChannels } from './un1t-online-studio-preferences.js'

const HATCH = 'loc-hatch'
const NOW = '2026-10-17T09:00:00.000Z'

// Minimal recording fake: select/in/eq, upsert (ignoreDuplicates) and insert.
function makeDb(seed = {}, { fail = {} } = {}) {
  const tables = {}
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }))
  const log = []
  const rowsOf = (t) => (tables[t] ||= [])
  function builder(table) {
    const s = { op: 'select', filters: [], payload: null, options: null }
    const run = () => {
      log.push({ table, op: s.op, payload: s.payload, options: s.options })
      if (fail[`${table}:${s.op}`]) return { data: null, error: { code: 'XX', message: `${table} ${s.op} boom` } }
      const rows = rowsOf(table)
      if (s.op === 'select') {
        const out = rows.filter((r) => s.filters.every(([k, c, v]) => (k === 'eq' ? r[c] === v : v.includes(r[c]))))
        return { data: out.map((r) => ({ ...r })), error: null }
      }
      const list = Array.isArray(s.payload) ? s.payload : [s.payload]
      if (s.op === 'insert') {
        rows.push(...list.map((r) => ({ ...r })))
        return { data: list, error: null }
      }
      const created = []
      for (const r of list) {
        if (rows.some((x) => x.contact_id === r.contact_id && x.location_id === r.location_id)) continue
        rows.push({ ...r })
        created.push({ ...r })
      }
      return { data: created, error: null }
    }
    const api = {
      select() { return api },
      insert(p) { s.op = 'insert'; s.payload = p; return api },
      upsert(p, o) { s.op = 'upsert'; s.payload = p; s.options = o; return api },
      eq(c, v) { s.filters.push(['eq', c, v]); return api },
      in(c, v) { s.filters.push(['in', c, v]); return api },
      then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject) },
    }
    return api
  }
  return { db: { from: (t) => builder(t) }, tables, log }
}

const call = (db, contactIds) => ensureStudioPreferences(db, { locationId: HATCH, contactIds, nowIso: NOW })

describe('initialChannels', () => {
  it('defaults every channel ON', () => {
    expect(initialChannels()).toEqual({ email_marketing: true, sms_marketing: true, whatsapp_marketing: true })
  })
  it('keeps a globally withdrawn channel OFF, and treats null as on (mig 488)', () => {
    expect(initialChannels({ prefs: { email_marketing: false, sms_marketing: null, whatsapp_marketing: true } })).toEqual({
      email_marketing: false, sms_marketing: true, whatsapp_marketing: true,
    })
  })
  it("email_status 'unsubscribed' switches email off", () => {
    expect(initialChannels({ emailStatus: 'unsubscribed' }).email_marketing).toBe(false)
  })
})

describe('ensureStudioPreferences', () => {
  it('returns {created:0} and touches nothing for no ids', async () => {
    const { db, log } = makeDb()
    expect(await call(db, [])).toEqual({ created: 0 })
    expect(log).toHaveLength(0)
  })

  it('inserts with ignoreDuplicates on contact_id,location_id and logs one opt_in per channel', async () => {
    const { db, tables, log } = makeDb()
    expect(await call(db, ['c1', 'c1', 'c2'])).toEqual({ created: 2 })
    const up = log.find((e) => e.op === 'upsert')
    expect(up.options).toEqual({ onConflict: 'contact_id,location_id', ignoreDuplicates: true })
    expect(tables.contact_location_preferences).toHaveLength(2)
    expect(tables.contact_location_preferences[0]).toMatchObject({
      location_id: HATCH, source: 'un1t_online_sync', subscribed_at: NOW, unsubscribed_at: null,
    })
    expect(tables.consent_log).toHaveLength(6)
    expect(tables.consent_log[0]).toMatchObject({ action: 'opt_in', source: 'un1t_online_sync', location_id: HATCH })
  })

  it('does not re-subscribe a channel the contact withdrew globally, and does not log it', async () => {
    const { db, tables } = makeDb({
      contact_preferences: [{ contact_id: 'c1', email_marketing: false, sms_marketing: true, whatsapp_marketing: true }],
      contacts: [{ id: 'c2', email_status: 'unsubscribed' }],
    })
    expect(await call(db, ['c1', 'c2'])).toEqual({ created: 2 })
    const byId = Object.fromEntries(tables.contact_location_preferences.map((r) => [r.contact_id, r]))
    expect(byId.c1).toMatchObject({ email_marketing: false, sms_marketing: true, unsubscribed_at: null })
    expect(byId.c2.email_marketing).toBe(false)
    const channels = (id) => tables.consent_log.filter((l) => l.contact_id === id).map((l) => l.channel).sort()
    expect(channels('c1')).toEqual(['sms_marketing', 'whatsapp_marketing'])
    expect(channels('c2')).toEqual(['sms_marketing', 'whatsapp_marketing'])
  })

  it('skips contacts that already have a row (no write, no log)', async () => {
    const existing = { contact_id: 'c1', location_id: HATCH, email_marketing: false, sms_marketing: false, whatsapp_marketing: false, source: 'x' }
    const { db, tables, log } = makeDb({ contact_location_preferences: [{ ...existing }] })
    expect(await call(db, ['c1'])).toEqual({ created: 0 })
    expect(tables.contact_location_preferences).toEqual([existing])
    expect(log.some((e) => e.op !== 'select')).toBe(false)
  })

  it('writes in chunks of at most 200', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `c${i}`)
    const { db, log } = makeDb()
    expect(await call(db, ids)).toEqual({ created: 450 })
    expect(log.filter((e) => e.op === 'upsert').map((e) => e.payload.length)).toEqual([200, 200, 50])
  })

  it('a failed evidence read creates nothing', async () => {
    const { db, log } = makeDb({}, { fail: { 'contact_preferences:select': true } })
    expect(await call(db, ['c1'])).toEqual({ created: 0, error: { code: 'XX', message: 'contact_preferences select boom' } })
    expect(log.some((e) => e.op !== 'select')).toBe(false)
  })

  it('a failed upsert reports the error and logs no consent', async () => {
    const { db, tables } = makeDb({}, { fail: { 'contact_location_preferences:upsert': true } })
    const r = await call(db, ['c1'])
    expect(r).toEqual({ created: 0, error: { code: 'XX', message: 'contact_location_preferences upsert boom' } })
    expect(tables.consent_log || []).toHaveLength(0)
  })

  it('a failed consent_log insert is reported with the rows already created', async () => {
    const { db } = makeDb({}, { fail: { 'consent_log:insert': true } })
    expect(await call(db, ['c1'])).toEqual({ created: 1, error: { code: 'XX', message: 'consent_log insert boom' } })
  })

  it('never throws', async () => {
    const db = { from: () => { throw new Error('kaboom') } }
    expect(await call(db, ['c1'])).toEqual({ created: 0, error: { code: null, message: 'kaboom' } })
  })
})

// GLOFOXSIBLING.1 — the Glofox sync links a sibling studio's contact the same
// way; the origin names the consent source, and an unknown origin writes nothing.
describe('ensureStudioPreferences origin', () => {
  it("origin 'glofox' writes source glofox_sync on the row and the consent log", async () => {
    const { db, tables } = makeDb({ contacts: [{ id: 'c1', email_status: null }] })
    const out = await ensureStudioPreferences(db, { locationId: HATCH, contactIds: ['c1'], nowIso: NOW, origin: 'glofox' })
    expect(out).toEqual({ created: 1 })
    expect(tables.contact_location_preferences[0].source).toBe('glofox_sync')
    expect(tables.consent_log.every((r) => r.source === 'glofox_sync')).toBe(true)
  })

  it('the default origin is still un1t_online_sync', async () => {
    const { db, tables } = makeDb({ contacts: [{ id: 'c1', email_status: null }] })
    await call(db, ['c1'])
    expect(tables.contact_location_preferences[0].source).toBe('un1t_online_sync')
  })

  it('an unknown origin writes nothing and says why', async () => {
    const { db, log } = makeDb({ contacts: [{ id: 'c1', email_status: null }] })
    const out = await ensureStudioPreferences(db, { locationId: HATCH, contactIds: ['c1'], origin: 'mystery' })
    expect(out.created).toBe(0)
    expect(out.error.message).toMatch(/unknown origin/)
    expect(log).toEqual([])
  })
})
