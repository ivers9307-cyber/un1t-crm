// UN1TWELCOME.5 — the welcome sweep. A small recording supabase mock models
// un1t_clients with real filtering (welcome_checked_at IS NULL, ordering,
// range), so the offset arithmetic is exercised, not assumed.
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

import { sweepUn1tWelcomes } from './un1t-online-welcome.js'

const NOW = new Date('2026-10-29T12:00:00Z')
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString()
const H = 3_600_000
const M = 60_000

function makeDb({ sequences = 1, seqError = null, clients = [], contacts = {}, stampErrorFor = new Set() } = {}) {
  const log = { clientReads: 0, updates: [], ranges: [], orders: [], isNull: [] }
  const db = {
    log,
    from(table) {
      if (table === 'email_sequences') {
        return { select: () => ({ eq: () => ({ eq: () => ({ eq: async () => ({ count: sequences, error: seqError }) }) }) }) }
      }
      if (table === 'contacts') {
        return { select: () => ({ in: async (_c, ids) => ({ data: ids.filter((i) => i in contacts).map((i) => ({ id: i, email: contacts[i] })), error: null }) }) }
      }
      if (table === 'un1t_clients') {
        return {
          select() {
            log.clientReads++
            const q = { from: 0, to: Infinity }
            const chain = {
              eq: () => chain,
              is: (col) => { log.isNull.push(col); return chain },
              order: (col) => { log.orders.push(col); return chain },
              range: (a, b) => { q.from = a; q.to = b; log.ranges.push([a, b]); return chain },
              then: (res) => {
                const rows = clients.filter((c) => !c.welcome_checked_at)
                  .sort((x, y) => (x.first_seen_at < y.first_seen_at ? -1 : x.first_seen_at > y.first_seen_at ? 1 : x.id < y.id ? -1 : 1))
                  .slice(q.from, q.to + 1)
                return Promise.resolve({ data: rows, error: null }).then(res)
              },
            }
            return chain
          },
          update(patch) {
            return {
              eq: (_c, id) => ({
                is: async () => {
                  if (stampErrorFor.has(id)) return { error: { code: 'X' } }
                  log.updates.push(id)
                  const row = clients.find((c) => c.id === id)
                  if (row) Object.assign(row, patch)
                  return { error: null }
                },
              }),
            }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return db
}

const client = (id, o = {}) => ({ id, un1t_user_id: `u-${id}`, contact_id: `c-${id}`, first_seen_at: ago(2 * H), account_email_sent_at: null, crm_written_at: null, welcome_checked_at: null, ...o })
const run = (db, trigger = vi.fn(async () => ({ ok: true, enrolled: 1 }))) => sweepUn1tWelcomes(db, 'loc', { now: () => NOW, trigger }).then((r) => ({ r, trigger }))

describe('sweepUn1tWelcomes', () => {
  it('skips with no active sequence and reads or stamps nothing', async () => {
    const db = makeDb({ sequences: 0, clients: [client('a')] })
    const { r, trigger } = await run(db)
    expect(r).toMatchObject({ ok: true, skipped_no_sequence: true, checked: 0 })
    expect(db.log.clientReads).toBe(0)
    expect(db.log.updates).toEqual([])
    expect(trigger).not.toHaveBeenCalled()
  })

  it('a failed sequence read is ok:false', async () => {
    const { r } = await run(makeDb({ seqError: { code: 'X' } }))
    expect(r.ok).toBe(false)
  })

  it('filters welcome_checked_at IS NULL and orders by first_seen_at', async () => {
    const db = makeDb({ clients: [client('a')], contacts: { 'c-a': 'a@x.ie' } })
    await run(db)
    expect(db.log.isNull).toContain('welcome_checked_at')
    expect(db.log.orders).toEqual(['first_seen_at', 'id'])
  })

  it('no contact: 1 h old waits unstamped, 49 h old is stamped no_contact', async () => {
    const db = makeDb({ clients: [client('young', { contact_id: null, first_seen_at: ago(H) }), client('old', { contact_id: null, first_seen_at: ago(49 * H) })] })
    const { r, trigger } = await run(db)
    expect(r).toMatchObject({ waiting: 1, no_contact: 1 })
    expect(db.log.updates).toEqual(['old'])
    expect(trigger).not.toHaveBeenCalled()
  })

  it('a blank email is stamped no_email and never enrolled', async () => {
    const db = makeDb({ clients: [client('a')], contacts: { 'c-a': '' } })
    const { r, trigger } = await run(db)
    expect(r.no_email).toBe(1)
    expect(db.log.updates).toEqual(['a'])
    expect(trigger).not.toHaveBeenCalled()
  })

  it('passes crmMade from account_email_sent_at', async () => {
    const db = makeDb({
      clients: [client('crm', { account_email_sent_at: ago(H) }), client('self')],
      contacts: { 'c-crm': 'a@x.ie', 'c-self': 'b@x.ie' },
    })
    const { r, trigger } = await run(db)
    const byUser = Object.fromEntries(trigger.mock.calls.map((c) => [c[1].un1tUserId, c[1].crmMade]))
    expect(byUser).toEqual({ 'u-crm': true, 'u-self': false })
    expect(r).toMatchObject({ enrolled: 2, crm_made: 1 })
  })

  it('a CRM row with no account email waits 30 minutes, then is enrolled with crmMade false', async () => {
    const db = makeDb({
      clients: [client('young', { crm_written_at: ago(5 * M), first_seen_at: ago(5 * M) }), client('stale', { crm_written_at: ago(31 * M), first_seen_at: ago(31 * M) })],
      contacts: { 'c-young': 'a@x.ie', 'c-stale': 'b@x.ie' },
    })
    const { r, trigger } = await run(db)
    expect(r.waiting).toBe(1)
    expect(db.log.updates).toEqual(['stale'])
    expect(trigger).toHaveBeenCalledTimes(1)
    expect(trigger.mock.calls[0][1]).toMatchObject({ un1tUserId: 'u-stale', crmMade: false })
  })

  it('a refused enrolment on a young row is not stamped, so it is retried; failed counts it', async () => {
    const db = makeDb({ clients: [client('a', { first_seen_at: ago(2 * H) })], contacts: { 'c-a': 'a@x.ie' } })
    const { r } = await run(db, vi.fn(async () => ({ ok: false, reason: 'db text' })))
    expect(r).toMatchObject({ ok: true, failed: 1, enrolled: 0 })
    expect(db.log.updates).toEqual([])
  })

  it('a refused enrolment on a 48 h old row is stamped and given up on', async () => {
    const db = makeDb({ clients: [client('a', { first_seen_at: ago(49 * H) })], contacts: { 'c-a': 'a@x.ie' } })
    const { r } = await run(db, vi.fn(async () => ({ ok: false, reason: 'db text' })))
    expect(r).toMatchObject({ ok: true, failed: 1 })
    expect(db.log.updates).toEqual(['a'])
  })

  it('logs a short code, never the trigger reason', async () => {
    const { logError } = await import('@/lib/log')
    const db = makeDb({ clients: [client('a')], contacts: { 'c-a': 'a@x.ie' } })
    await run(db, vi.fn(async () => ({ ok: false, reason: 'secret db text' })))
    expect(JSON.stringify(logError.mock.calls)).not.toContain('secret db text')
    expect(logError).toHaveBeenCalledWith('un1t-welcome', 'enrol refused', { locationId: 'loc', code: 'trigger_failed' })
  })

  it('a stamp error is ok:false and the next row is still processed', async () => {
    const db = makeDb({
      clients: [client('a', { first_seen_at: ago(3 * H) }), client('b')],
      contacts: { 'c-a': 'a@x.ie', 'c-b': 'b@x.ie' },
      stampErrorFor: new Set(['a']),
    })
    const { r, trigger } = await run(db)
    expect(r.ok).toBe(false)
    expect(trigger).toHaveBeenCalledTimes(2)
    expect(db.log.updates).toEqual(['b'])
  })

  const dueRows = (n, o = {}) => Array.from({ length: n }, (_, i) => client(`d${String(i).padStart(3, '0')}`, { first_seen_at: ago(20 * H - i * 1000), ...o }))
  const contactsFor = (rows) => Object.fromEntries(rows.filter((d) => d.contact_id).map((d) => [d.contact_id, `${d.id}@x.ie`]))
  const waitingRows = (n) => Array.from({ length: n }, (_, i) => client(`w${String(i).padStart(3, '0')}`, { contact_id: null, first_seen_at: ago(47 * H - i * 1000) }))
  const calledIds = (trigger) => trigger.mock.calls.map((c) => c[1].un1tUserId)

  it('3 waiting rows AHEAD of 500 due rows: every due row is enrolled exactly once', async () => {
    const due = dueRows(500)
    const db = makeDb({ clients: [...waitingRows(3), ...due], contacts: contactsFor(due) })
    const { r, trigger } = await run(db)
    const ids = calledIds(trigger)
    expect(ids).toHaveLength(500)
    expect(new Set(ids).size).toBe(500)
    expect(r).toMatchObject({ enrolled: 500, waiting: 3 })
  })

  it('one failed stamp in page 0 of 501 rows: no row skipped, none processed twice', async () => {
    const due = dueRows(501)
    const db = makeDb({ clients: due, contacts: contactsFor(due), stampErrorFor: new Set(['d000']) })
    const { r, trigger } = await run(db)
    const ids = calledIds(trigger)
    expect(ids).toHaveLength(501)
    expect(new Set(ids).size).toBe(501)
    expect(r.ok).toBe(false)
  })

  it('501 waiting rows ahead of 10 due rows: the due rows are still enrolled inside the page cap', async () => {
    const due = dueRows(10)
    const db = makeDb({ clients: [...waitingRows(501), ...due], contacts: contactsFor(due) })
    const { r, trigger } = await run(db)
    expect(calledIds(trigger)).toHaveLength(10)
    expect(r).toMatchObject({ enrolled: 10, waiting: 501 })
  })
})
