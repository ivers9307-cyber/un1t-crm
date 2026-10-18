import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { PURPOSES, resolvePurposeTemplate } from './whatsapp-purpose-templates'
import { logWarn, logError } from '@/lib/log'

const STILL = 'a0000000-0000-4000-8000-000000000001'
const HATCH = 'a0000000-0000-4000-8000-000000000002'

// A tiny supabase-js-shaped fake over in-memory tables: eq filters, order,
// limit, maybeSingle. Enough for the two reads the helper makes.
function fakeDb(tables, { fail, failOn } = {}) {
  return {
    from(table) {
      let rows = [...(tables[table] || [])]
      const filters = {}
      const broken = () => fail === table || (failOn && failOn(table, filters))
      const q = {
        select() { return q },
        eq(col, val) { filters[col] = val; rows = rows.filter((r) => r[col] === val); return q },
        order(col, { ascending = true } = {}) { rows.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (ascending ? 1 : -1)); return q },
        limit(n) { rows = rows.slice(0, n); return q },
        maybeSingle() { return Promise.resolve(broken() ? { data: null, error: { message: 'boom' } } : { data: rows[0] || null, error: null }) },
        then(res, rej) { return Promise.resolve(broken() ? { data: null, error: { message: 'boom' } } : { data: rows, error: null }).then(res, rej) },
      }
      return q
    },
  }
}

const tpl = (id, loc, name, extra = {}) => ({
  id, location_id: loc, name, language: 'en', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi' }],
  status: 'APPROVED', business_account_id: 'WABA-1', header_media_url: null, created_at: '2026-10-01T00:00:00Z', ...extra,
})
const loc = (id, whatsapp_purpose_templates) => ({ id, settings: whatsapp_purpose_templates ? { other: 1, whatsapp_purpose_templates } : { other: 1 } })

beforeEach(() => vi.clearAllMocks())

describe('PURPOSES', () => {
  it('names the four fixed purposes with today\'s template names', () => {
    expect(PURPOSES).toEqual({
      class_confirmed: { fallbackName: 'booking_class_confirmed_', categories: ['UTILITY'] },
      consult_confirmed: { fallbackName: 'booking_consult_confirmed', categories: ['UTILITY'] },
      event_waitlist_offer: { fallbackName: 'event_waitlist_offer', categories: ['UTILITY'] },
      meta_ad_welcome: { fallbackName: 'meta_ad_whatsapp_lead', categories: ['MARKETING', 'UTILITY'] },
    })
  })
})

describe('resolvePurposeTemplate', () => {
  it('setting wins over fallback name', async () => {
    const db = fakeDb({
      locations: [loc(HATCH, { class_confirmed: 'T-HATCH' })],
      whatsapp_templates: [tpl('T-HATCH', HATCH, 'hatch_class_ok'), tpl('T-OLD', HATCH, 'booking_class_confirmed_')],
    })
    const r = await resolvePurposeTemplate(db, HATCH, 'class_confirmed')
    expect(r).toEqual({
      id: 'T-HATCH', name: 'hatch_class_ok', language: 'en', category: 'UTILITY',
      components: [{ type: 'BODY', text: 'Hi' }], business_account_id: 'WABA-1', header_media_url: null,
    })
  })

  it('fallback name keeps Stillorgan unchanged with no setting', async () => {
    const db = fakeDb({
      locations: [loc(STILL)],
      whatsapp_templates: [
        tpl('T-OLDER', STILL, 'booking_class_confirmed_', { created_at: '2026-01-01T00:00:00Z' }),
        tpl('T-NEWER', STILL, 'booking_class_confirmed_', { language: 'ga', created_at: '2026-09-01T00:00:00Z' }),
        tpl('T-PEND', STILL, 'booking_class_confirmed_', { status: 'PENDING', created_at: '2026-10-05T00:00:00Z' }),
        tpl('T-OTHERSTUDIO', HATCH, 'booking_class_confirmed_', { created_at: '2026-10-06T00:00:00Z' }),
      ],
    })
    const r = await resolvePurposeTemplate(db, STILL, 'class_confirmed')
    expect(r.id).toBe('T-NEWER')
  })

  it('a setting that is not APPROVED falls back to the default name', async () => {
    const db = fakeDb({
      locations: [loc(STILL, { consult_confirmed: 'T-PAUSED' })],
      whatsapp_templates: [tpl('T-PAUSED', STILL, 'custom', { status: 'PAUSED' }), tpl('T-DEF', STILL, 'booking_consult_confirmed')],
    })
    expect((await resolvePurposeTemplate(db, STILL, 'consult_confirmed')).id).toBe('T-DEF')
  })

  it('template from another studio is ignored', async () => {
    const db = fakeDb({
      locations: [loc(HATCH, { class_confirmed: 'T-STILL' })],
      whatsapp_templates: [tpl('T-STILL', STILL, 'booking_class_confirmed_')],
    })
    expect(await resolvePurposeTemplate(db, HATCH, 'class_confirmed')).toBeNull()
    expect(logWarn).toHaveBeenCalledWith('wa-purpose-templates', 'template not at studio', expect.objectContaining({ purpose: 'class_confirmed', locationId: HATCH, templateId: 'T-STILL' }))
  })

  it('template from another studio is ignored in favour of the studio\'s own default name', async () => {
    const db = fakeDb({
      locations: [loc(HATCH, { class_confirmed: 'T-STILL' })],
      whatsapp_templates: [tpl('T-STILL', STILL, 'x'), tpl('T-OWN', HATCH, 'booking_class_confirmed_')],
    })
    expect((await resolvePurposeTemplate(db, HATCH, 'class_confirmed')).id).toBe('T-OWN')
  })

  it('no template → null (sender skips as today)', async () => {
    const db = fakeDb({ locations: [loc(HATCH)], whatsapp_templates: [tpl('T1', STILL, 'event_waitlist_offer')] })
    expect(await resolvePurposeTemplate(db, HATCH, 'event_waitlist_offer')).toBeNull()
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('a campaign can name its own fallback for the ad welcome', async () => {
    const db = fakeDb({ locations: [loc(STILL)], whatsapp_templates: [tpl('T-C', STILL, 'campaign_x')] })
    expect((await resolvePurposeTemplate(db, STILL, 'meta_ad_welcome', { fallbackName: 'campaign_x' })).id).toBe('T-C')
    expect(await resolvePurposeTemplate(db, STILL, 'meta_ad_welcome')).toBeNull()
  })

  it('a failed settings read still resolves the default-named template, and logs it', async () => {
    const db = fakeDb(
      { locations: [loc(STILL, { class_confirmed: 'T-PICK' })], whatsapp_templates: [tpl('T-DEF', STILL, 'booking_class_confirmed_')] },
      { failOn: (table) => table === 'locations' },
    )
    expect((await resolvePurposeTemplate(db, STILL, 'class_confirmed')).id).toBe('T-DEF')
    expect(logError).toHaveBeenCalledWith('wa-purpose-templates', expect.stringContaining('settings unreadable'), expect.objectContaining({ purpose: 'class_confirmed', locationId: STILL }))
  })

  it('a failed read of the chosen template still resolves the default-named template, and logs it', async () => {
    const db = fakeDb(
      { locations: [loc(STILL, { class_confirmed: 'T-PICK' })], whatsapp_templates: [tpl('T-PICK', STILL, 'custom'), tpl('T-DEF', STILL, 'booking_class_confirmed_')] },
      { failOn: (table, f) => table === 'whatsapp_templates' && f.id === 'T-PICK' },
    )
    expect((await resolvePurposeTemplate(db, STILL, 'class_confirmed')).id).toBe('T-DEF')
    expect(logError).toHaveBeenCalledWith('wa-purpose-templates', expect.stringContaining('chosen template unreadable'), expect.objectContaining({ templateId: 'T-PICK' }))
  })

  it('a pick that is not APPROVED is logged with its status before falling back', async () => {
    const db = fakeDb({
      locations: [loc(STILL, { class_confirmed: 'T-PAUSED' })],
      whatsapp_templates: [tpl('T-PAUSED', STILL, 'custom', { status: 'PAUSED' }), tpl('T-DEF', STILL, 'booking_class_confirmed_')],
    })
    expect((await resolvePurposeTemplate(db, STILL, 'class_confirmed')).id).toBe('T-DEF')
    expect(logWarn).toHaveBeenCalledWith('wa-purpose-templates', expect.stringContaining('not approved'), expect.objectContaining({ templateId: 'T-PAUSED', status: 'PAUSED' }))
  })

  it('a failed read of the default-named template still throws (today\'s semantics)', async () => {
    const db = fakeDb({ locations: [loc(STILL)] }, { failOn: (table) => table === 'whatsapp_templates' })
    await expect(resolvePurposeTemplate(db, STILL, 'class_confirmed')).rejects.toThrow(/studio's templates/)
  })

  it('an unknown purpose throws', async () => {
    await expect(resolvePurposeTemplate(fakeDb({}), STILL, 'nope')).rejects.toThrow(/Unknown/)
  })
})
