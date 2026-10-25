// ORGCONTACTS.4 (spec §2.5) — lead source per studio: a website form stamps
// the contact-wide last_lead_source only when the form's studio is the
// contact's primary; at a sibling studio the preferences trigger's lead_form
// contact_studios row is the record. First touch (lead_source, stamp-if-null)
// is unchanged. Fictional ids only.
import { describe, it, expect, vi } from 'vitest'
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
import { logWarn } from '@/lib/log'
import { stampLeadSource } from './lead-source-stamp.js'

function fakeDb({ contact, failPatch = null }) {
  const updates = []
  return {
    updates,
    from(table) {
      const st = { table, filters: [], patch: null }
      const b = {
        select() { return b },
        eq(c, v) { st.filters.push(['eq', c, v]); return b },
        is(c, v) { st.filters.push(['is', c, v]); return b },
        update(patch) { st.patch = patch; return b },
        async maybeSingle() { return { data: contact, error: null } },
        then(res, rej) {
          if (st.patch) updates.push({ table, patch: st.patch, filters: st.filters })
          const failed = st.patch && failPatch && Object.keys(st.patch).includes(failPatch)
          return Promise.resolve(failed ? { data: null, error: { code: '42501', message: 'boom' } } : { data: null, error: null }).then(res, rej)
        },
      }
      return b
    },
  }
}

const C = 'c-1'
describe('stampLeadSource', () => {
  it("the primary studio's form stamps first touch (if null) and last touch", async () => {
    const db = fakeDb({ contact: { id: C, location_id: 'loc-hatch' } })
    const r = await stampLeadSource(db, { contactId: C, locationId: 'loc-hatch', leadSource: 'website_lead' })
    expect(r).toEqual({ primary: true, lastTouch: true, failed: [] })
    expect(db.updates).toEqual([
      { table: 'contacts', patch: { lead_source: 'website_lead' }, filters: [['eq', 'id', C], ['is', 'lead_source', null]] },
      { table: 'contacts', patch: { last_lead_source: 'website_lead', last_lead_source_at: expect.any(String) }, filters: [['eq', 'id', C]] },
    ])
  })

  it("a sibling studio's form does not overwrite last_lead_source (first touch still stamp-if-null)", async () => {
    const db = fakeDb({ contact: { id: C, location_id: 'loc-stillorgan' } })
    const r = await stampLeadSource(db, { contactId: C, locationId: 'loc-hatch', leadSource: 'website_lead' })
    expect(r).toEqual({ primary: false, lastTouch: false, failed: [] })
    expect(db.updates).toEqual([
      { table: 'contacts', patch: { lead_source: 'website_lead' }, filters: [['eq', 'id', C], ['is', 'lead_source', null]] },
    ])
  })

  it('an unreadable contact stamps first touch only (never guesses the primary)', async () => {
    const db = fakeDb({ contact: null })
    const r = await stampLeadSource(db, { contactId: C, locationId: 'loc-hatch', leadSource: 'website_lead' })
    expect(r).toEqual({ primary: false, lastTouch: false, failed: [] })
    expect(db.updates.map((u) => u.patch)).toEqual([{ lead_source: 'website_lead' }])
  })

  // M3 (final review): a failed write used to resolve silently (a supabase
  // builder resolves { error }, it never throws), so the form reported a stamp
  // it never made. The result names the write that failed and it is logged.
  it('a failed last-touch write is lastTouch:false with the failure named and logged; nothing throws', async () => {
    const db = fakeDb({ contact: { id: C, location_id: 'loc-hatch' }, failPatch: 'last_lead_source' })
    const r = await stampLeadSource(db, { contactId: C, locationId: 'loc-hatch', leadSource: 'website_lead' })
    expect(r).toEqual({ primary: true, lastTouch: false, failed: ['last_touch'] })
    expect(logWarn).toHaveBeenCalledWith('lead-source-stamp', expect.stringMatching(/last touch/i), expect.objectContaining({ contactId: C, code: '42501' }))
  })
  it('a failed first-touch write is named, logged, and the last touch still goes ahead', async () => {
    const db = fakeDb({ contact: { id: C, location_id: 'loc-hatch' }, failPatch: 'lead_source' })
    const r = await stampLeadSource(db, { contactId: C, locationId: 'loc-hatch', leadSource: 'website_lead' })
    expect(r).toEqual({ primary: true, lastTouch: true, failed: ['first_touch'] })
    expect(db.updates).toHaveLength(2)
  })
})
