// WAORGNUMBER.2 — planTemplateSync is pure; fictional ids only.
import { describe, it, expect } from 'vitest'
import { planTemplateSync } from './whatsapp-template-sync.js'

const STILL = 'a0000000-0000-0000-0000-000000000001'
const HATCH = 'a0000000-0000-0000-0000-000000000002'
const WABA = '100000000000001'

const meta = (id, name, extra = {}) => ({ id, name, language: 'en', category: 'UTILITY', status: 'APPROVED', components: [{ type: 'BODY', text: 'hi' }], ...extra })
const row = (id, location_id, name, meta_template_id, extra = {}) => ({ id, location_id, name, language: 'en', meta_template_id, business_account_id: WABA, ...extra })
const plan = (o) => planTemplateSync({ studioId: STILL, isHomeStudio: true, wabaId: WABA, rowsOnWaba: [], metaTemplates: [], ...o })

describe('planTemplateSync', () => {
  it("updates the studio's own rows", () => {
    const r = plan({ metaTemplates: [meta('m1', 'welcome', { status: 'PAUSED', rejected_reason: 'X' })], rowsOnWaba: [row('r1', STILL, 'welcome', 'm1')] })
    expect(r.inserts).toEqual([])
    expect(r.skipped).toEqual([])
    expect(r.updates).toEqual([{
      id: 'r1',
      row: { meta_template_id: 'm1', name: 'welcome', language: 'en', category: 'UTILITY', components: [{ type: 'BODY', text: 'hi' }], status: 'PAUSED', rejection_reason: 'X', location_id: STILL, business_account_id: WABA },
    }])
  })

  it('skips a template another studio owns', () => {
    const r = plan({ studioId: HATCH, isHomeStudio: false, metaTemplates: [meta('m1', 'welcome')], rowsOnWaba: [row('r1', STILL, 'welcome', 'm1')] })
    expect(r.updates).toEqual([])
    expect(r.inserts).toEqual([])
    expect(r.skipped).toEqual([{ name: 'welcome', language: 'en', ownerLocationId: STILL, reason: 'other_studio' }])
  })

  it('skips another studio even when the home studio syncs (the owner is not S)', () => {
    const r = plan({ studioId: STILL, isHomeStudio: true, metaTemplates: [meta('m1', 'hatch_offer')], rowsOnWaba: [row('r1', HATCH, 'hatch_offer', 'm1')] })
    expect(r.skipped).toEqual([{ name: 'hatch_offer', language: 'en', ownerLocationId: HATCH, reason: 'other_studio' }])
    expect(r.inserts).toEqual([])
  })

  it('adopts an unowned template only at the home studio', () => {
    const r = plan({ metaTemplates: [meta('m9', 'made_in_meta_ui')] })
    expect(r.updates).toEqual([])
    expect(r.skipped).toEqual([])
    expect(r.inserts).toEqual([{ meta_template_id: 'm9', name: 'made_in_meta_ui', language: 'en', category: 'UTILITY', components: [{ type: 'BODY', text: 'hi' }], status: 'APPROVED', rejection_reason: null, location_id: STILL, business_account_id: WABA }])
  })

  it('does not adopt at a non-home studio', () => {
    const r = plan({ studioId: HATCH, isHomeStudio: false, metaTemplates: [meta('m9', 'made_in_meta_ui')] })
    expect(r.inserts).toEqual([])
    expect(r.updates).toEqual([])
    expect(r.skipped).toEqual([{ name: 'made_in_meta_ui', language: 'en', ownerLocationId: null, reason: 'unowned_not_home' }])
  })

  it('matches by meta id before name', () => {
    // r_name shares the NAME but belongs to Hatch; r_id carries the meta id and is Stillorgan's.
    const r = plan({
      metaTemplates: [meta('m1', 'welcome')],
      rowsOnWaba: [row('r_name', HATCH, 'welcome', null), row('r_id', STILL, 'old_name', 'm1')],
    })
    expect(r.updates.map((u) => u.id)).toEqual(['r_id'])
    expect(r.skipped).toEqual([])
  })

  it('falls back to (name, language) for a row with no meta id, and treats languages as distinct', () => {
    const r = plan({
      metaTemplates: [meta('m1', 'welcome'), meta('m2', 'welcome', { language: 'ga' })],
      rowsOnWaba: [row('r1', STILL, 'welcome', null)],
    })
    expect(r.updates.map((u) => u.id)).toEqual(['r1'])
    expect(r.inserts.map((i) => i.language)).toEqual(['ga'])
  })

  it('does not mutate its inputs and handles empty lists', () => {
    const rows = [row('r1', STILL, 'welcome', 'm1')]
    const snapshot = JSON.stringify(rows)
    plan({ metaTemplates: [meta('m1', 'welcome')], rowsOnWaba: rows })
    expect(JSON.stringify(rows)).toBe(snapshot)
    expect(planTemplateSync({ studioId: STILL, isHomeStudio: true, wabaId: WABA, metaTemplates: [], rowsOnWaba: [] })).toEqual({ updates: [], inserts: [], skipped: [] })
  })
})
