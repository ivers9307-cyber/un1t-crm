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
  it('a member or credit member whose membership can book (state active, or unset) at THIS studio; an active contact_memberships row here too', async () => {
    const { db } = makeDb({
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
      contact_memberships: [
        { id: 'm1', location_id: STILL, contact_id: 'c-cm', status: 'active' },
        { id: 'm2', location_id: STILL, contact_id: 'c-cm-ended', status: 'ended' },
        { id: 'm3', location_id: 'loc-hatch', contact_id: 'c-cm-hatch', status: 'active' },
      ],
    })
    const out = await fetchGlofoxActiveMemberContactIds(db, STILL)
    expect(out.success).toBe(true)
    expect(out.data.contactIds.sort()).toEqual(['c-cm', 'c-credit', 'c-member', 'c-null-state'])
  })

  it('pages past 1,000 members (the select cap)', async () => {
    const many = Array.from({ length: 1500 }, (_, i) => contact(`c-${String(i).padStart(4, '0')}`, 'member'))
    const { db, log } = makeDb({ contacts: many, contact_memberships: [] })
    const out = await fetchGlofoxActiveMemberContactIds(db, STILL)
    expect(out.data.contactIds).toHaveLength(1500)
    expect(log.filter((q) => q.table === 'contacts').map((q) => q.range)).toEqual([[0, 999], [1000, 1999]])
  })

  it('a failed read is success:false, never an empty list', async () => {
    for (const table of ['contacts', 'contact_memberships']) {
      const { db } = makeDb({ contacts: [contact('c', 'member')] }, { fail: [table] })
      const out = await fetchGlofoxActiveMemberContactIds(db, STILL)
      expect(out).toEqual({ success: false, error: `${table} boom` })
    }
  })

  it('no location is success:false', async () => {
    const { db } = makeDb()
    expect(await fetchGlofoxActiveMemberContactIds(db, null)).toEqual({ success: false, error: 'No location' })
  })
})
