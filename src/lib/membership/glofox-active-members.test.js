// PIPEEXCL.1 — the Glofox studio's active members, as contact ids.
import { describe, it, expect } from 'vitest'
import { fetchGlofoxActiveMemberContactIds } from './glofox-active-members'

const STILL = 'loc-still'

function makeDb(seed = {}, { fail = [] } = {}) {
  const log = []
  const builder = (table) => {
    const s = { filters: [], range: null, cols: null }
    const run = () => {
      log.push({ table, cols: s.cols, filters: s.filters, range: s.range })
      if (fail.includes(table)) return { data: null, error: { message: `${table} boom` } }
      let rows = (seed[table] || []).filter((r) => s.filters.every(([k, c, v]) => (k === 'eq' ? r[c] === v : v.includes(r[c]))))
      if (s.range) rows = rows.slice(s.range[0], s.range[1] + 1)
      return { data: rows, error: null }
    }
    const api = {
      select(cols) { s.cols = cols; return api },
      eq(c, v) { s.filters.push(['eq', c, v]); return api },
      in(c, v) { s.filters.push(['in', c, v]); return api },
      order() { return api },
      range(a, b) { s.range = [a, b]; return api },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej) },
    }
    return api
  }
  return { db: { from: (t) => builder(t) }, log }
}

const contact = (id, status, state = 'active', location_id = STILL) => ({ id, location_id, glofox_membership_status: status, glofox_membership_state: state })

describe('fetchGlofoxActiveMemberContactIds', () => {
  it('a member or credit member whose membership can book (state active, or unset) at THIS studio; an ACTIVE member contact_studios row here too (ORGCONTACTS.2)', async () => {
    const { db, log } = makeDb({
      contacts: [
        contact('c-member', 'member'),
        contact('c-credit', 'credit_member'),
        contact('c-null-state', 'member', null),
        contact('c-paused', 'member', 'paused'),
        contact('c-lapsed', 'ex_member'),
        contact('c-trial', 'trial'),
        contact('c-lead', 'lead'),
        contact('c-classpass', 'classpass_payg'),
        contact('c-elsewhere', 'member', 'active', 'loc-hatch'),
      ],
      contact_studios: [
        { location_id: STILL, contact_id: 'c-cs', kind: 'member', status: 'active' },
        { location_id: STILL, contact_id: 'c-cs-ended', kind: 'member', status: 'ended' },
        { location_id: STILL, contact_id: 'c-cs-client', kind: 'client', status: 'active' },
        { location_id: 'loc-hatch', contact_id: 'c-cs-hatch', kind: 'member', status: 'active' },
      ],
    })
    const out = await fetchGlofoxActiveMemberContactIds(db, STILL)
    expect(out.success).toBe(true)
    expect(out.data.contactIds.sort()).toEqual(['c-credit', 'c-cs', 'c-member', 'c-null-state'])
    const rel = log.find((q) => q.table === 'contact_studios')
    expect(rel.filters).toEqual(expect.arrayContaining([['eq', 'location_id', STILL], ['in', 'kind', ['member']], ['eq', 'status', 'active']]))
    expect(log.some((q) => q.table === 'contact_memberships')).toBe(false)
  })

  it('pages past 1,000 members (the select cap)', async () => {
    const many = Array.from({ length: 1500 }, (_, i) => contact(`c-${String(i).padStart(4, '0')}`, 'member'))
    const { db, log } = makeDb({ contacts: many, contact_studios: [] })
    const out = await fetchGlofoxActiveMemberContactIds(db, STILL)
    expect(out.data.contactIds).toHaveLength(1500)
    expect(log.filter((q) => q.table === 'contacts').map((q) => q.range)).toEqual([[0, 999], [1000, 1999]])
  })

  it('a failed read is success:false, never an empty list', async () => {
    for (const table of ['contacts', 'contact_studios']) {
      const { db } = makeDb({ contacts: [contact('c', 'member')] }, { fail: [table] })
      const out = await fetchGlofoxActiveMemberContactIds(db, STILL)
      expect(out.success).toBe(false)
      expect(out.error).toMatch(new RegExp(`${table} boom`))
    }
  })

  it('no location is success:false', async () => {
    const { db } = makeDb()
    expect(await fetchGlofoxActiveMemberContactIds(db, null)).toEqual({ success: false, error: 'No location' })
  })
})

// PIPEEXCL.3 — a membership that is only a pack of classes (Glofox type
// num_classes or payg) is named separately, so the other-studio rule can count
// it only while the person still trains there. An unused credit never expires.
describe('fetchGlofoxActiveMemberContactIds — pack-only members (PIPEEXCL.3)', () => {
  const typed = (id, type, status = 'member', state = null, location_id = STILL) => ({ ...contact(id, status, state, location_id), glofox_membership_type: type })

  it('names the members whose live membership is a class pack or pay as you go; a time membership is not one', async () => {
    const { db } = makeDb({
      contacts: [
        typed('c-pack', 'num_classes'),
        typed('c-payg', 'payg', 'credit_member'),
        typed('c-time', 'time'),
        typed('c-untyped', null),
        typed('c-paused-pack', 'num_classes', 'member', 'paused'),
      ],
      contact_studios: [],
    })
    const out = await fetchGlofoxActiveMemberContactIds(db, STILL)
    expect(out.success).toBe(true)
    expect(out.data.contactIds.sort()).toEqual(['c-pack', 'c-payg', 'c-time', 'c-untyped'])
    expect(out.data.packOnlyContactIds.sort()).toEqual(['c-pack', 'c-payg'])
  })

  it('reads the Glofox columns of a member known only through contact_studios (a sibling studio\'s contact), by id', async () => {
    const { db, log } = makeDb({
      contacts: [
        typed('c-sib-pack', 'num_classes', 'member', null, 'loc-hatch'),
        typed('c-sib-time', 'time', 'member', 'active', 'loc-hatch'),
      ],
      contact_studios: [
        { location_id: STILL, contact_id: 'c-sib-pack', kind: 'member', status: 'active' },
        { location_id: STILL, contact_id: 'c-sib-time', kind: 'member', status: 'active' },
        { location_id: STILL, contact_id: 'c-sib-gone', kind: 'member', status: 'active' },
      ],
    })
    const out = await fetchGlofoxActiveMemberContactIds(db, STILL)
    expect(out.data.contactIds.sort()).toEqual(['c-sib-gone', 'c-sib-pack', 'c-sib-time'])
    expect(out.data.packOnlyContactIds).toEqual(['c-sib-pack'])
    const byId = log.filter((q) => q.table === 'contacts' && q.filters.some(([k, c]) => k === 'in' && c === 'id'))
    expect(byId).toHaveLength(1)
    expect(byId[0].filters.find(([, c]) => c === 'id')[2].sort()).toEqual(['c-sib-gone', 'c-sib-pack', 'c-sib-time'])
  })

  it('a failed by-id read is success:false, never "no packs"', async () => {
    let calls = 0
    const { db: inner } = makeDb({ contacts: [], contact_studios: [{ location_id: STILL, contact_id: 'c-sib', kind: 'member', status: 'active' }] })
    const db = { from: (t) => {
      if (t === 'contacts' && ++calls === 2) return makeDb({}, { fail: ['contacts'] }).db.from(t)
      return inner.from(t)
    } }
    const out = await fetchGlofoxActiveMemberContactIds(db, STILL)
    expect(out.success).toBe(false)
    expect(out.error).toMatch(/contacts boom/)
  })
})
