// MEMBERWRITESWEEP.1f — the TV admin's shared gate and validators.
//
// The gate is the TV upload routes' (src/lib/tv-upload-gate.js), judged at
// the TV's / template's own studio: the web OR the mobile tv_displays
// permission there, after membership (404 for a studio the caller does not
// belong to, so ids are not enumerable). The validators are DECISION 4: a
// push is stored only if the public cast page can render it safely.

import { describe, it, expect, vi } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  headers: async () => ({ get: () => null }),
}))

import {
  authoriseTvLocation, tvAdminAnywhereGate, validateTvPush, isTemplateBaseImagePath,
  loadTvDisplayForUser, loadTvTemplateForUser, mergeTvContent,
} from './tv-admin.js'
import {
  OWNER_A, STAFF_A, WEB_ONLY_A, MOBILE_ONLY_A, NEITHER_A, TV_AT_A_ONLY, LOC_A, LOC_B, TV_ID, TEMPLATE_ID,
  makeFakeDb, display, template,
} from './tv-admin.test-helpers.js'

const statusOf = (res) => (res ? res.status : null)

describe('authoriseTvLocation (tv_displays, web OR mobile, at the studio)', () => {
  it('the web key alone is enough', () => {
    expect(authoriseTvLocation(WEB_ONLY_A, LOC_A)).toBeNull()
  })
  it('the mobile toggle alone is enough', () => {
    expect(authoriseTvLocation(MOBILE_ONLY_A, LOC_A)).toBeNull()
  })
  it('an owner by role default passes', () => {
    expect(authoriseTvLocation(OWNER_A, LOC_A)).toBeNull()
  })
  it('neither key: 403 with the upload routes\' words', async () => {
    const res = authoriseTvLocation(NEITHER_A, LOC_A)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Not authorised for TV displays' })
  })
  it('plain staff (role default off, web and phone): 403', () => {
    expect(statusOf(authoriseTvLocation(STAFF_A, LOC_A))).toBe(403)
  })
  it('a studio the caller does not belong to: 404, not 403', async () => {
    const res = authoriseTvLocation(OWNER_A, LOC_B)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ success: false, error: 'Not found' })
  })
  it('judged at the target, not the active studio: tv_displays at A does not open B', () => {
    expect(statusOf(authoriseTvLocation(TV_AT_A_ONLY, LOC_B))).toBe(403)
  })
  it('no session: 401; no studio: 400', () => {
    expect(statusOf(authoriseTvLocation(null, LOC_A))).toBe(401)
    expect(statusOf(authoriseTvLocation(OWNER_A, null))).toBe(400)
    expect(statusOf(authoriseTvLocation(OWNER_A, 'not-a-uuid'))).toBe(400)
  })
})

describe('tvAdminAnywhereGate (the coarse pre-check)', () => {
  it('401 signed out, 403 without the key anywhere, null with it somewhere', () => {
    expect(statusOf(tvAdminAnywhereGate(null))).toBe(401)
    expect(statusOf(tvAdminAnywhereGate(STAFF_A))).toBe(403)
    expect(statusOf(tvAdminAnywhereGate(NEITHER_A))).toBe(403)
    expect(tvAdminAnywhereGate(MOBILE_ONLY_A)).toBeNull()
    expect(tvAdminAnywhereGate(TV_AT_A_ONLY)).toBeNull()
  })
})

describe('validateTvPush (DECISION 4)', () => {
  const lookup = (map) => vi.fn(async (id) => map[id] ?? null)
  const ctx = (extra = {}) => ({ locationId: LOC_A, templateLocationOf: lookup({ [TEMPLATE_ID]: LOC_A }), ...extra })

  it('accepts an https URL and an http URL', async () => {
    expect(await validateTvPush({ source_type: 'url', source_ref: 'https://example.invalid/x.png' }, ctx()))
      .toEqual({ ok: true, value: { source_type: 'url', source_ref: 'https://example.invalid/x.png', label: null, template_values: null } })
    expect((await validateTvPush({ source_type: 'url', source_ref: 'http://example.invalid/x' }, ctx())).ok).toBe(true)
  })

  it.each([
    ['javascript:alert(1)'],
    ['data:text/html,x'],
    ['ftp://example.invalid/x'],
    ['file:///etc/passwd'],
    ['not a url'],
    ['//example.invalid/x'],
  ])('refuses the URL %s', async (ref) => {
    const r = await validateTvPush({ source_type: 'url', source_ref: ref }, ctx())
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/http/)
  })

  it('accepts a photo in this studio\'s folder (a push image or a template base image)', async () => {
    expect((await validateTvPush({ source_type: 'storage', source_ref: `${LOC_A}/1c000000-0000-4000-8000-000000000003.jpg` }, ctx())).ok).toBe(true)
    expect((await validateTvPush({ source_type: 'storage', source_ref: `${LOC_A}/templates/x.png` }, ctx())).ok).toBe(true)
  })

  it.each([
    [`${LOC_B}/1c000000-0000-4000-8000-000000000003.jpg`],
    [`${LOC_A}/../${LOC_B}/x.jpg`],
    [`${LOC_A}/`],
    ['x.jpg'],
    [`/${LOC_A}/x.jpg`],
  ])('refuses the storage path %s', async (ref) => {
    const r = await validateTvPush({ source_type: 'storage', source_ref: ref }, ctx())
    expect(r.ok).toBe(false)
  })

  it('accepts a template of this studio with its zone values, and keeps the values', async () => {
    const values = { z1: { text: 'Hi' } }
    const c = ctx()
    const r = await validateTvPush({ source_type: 'template', source_ref: TEMPLATE_ID, label: 'Board', template_values: values }, c)
    expect(r).toEqual({ ok: true, value: { source_type: 'template', source_ref: TEMPLATE_ID, label: 'Board', template_values: values } })
    expect(c.templateLocationOf).toHaveBeenCalledWith(TEMPLATE_ID)
  })

  it('refuses a template at another studio, an unknown template, and a non-uuid ref', async () => {
    expect((await validateTvPush({ source_type: 'template', source_ref: TEMPLATE_ID, template_values: {} },
      ctx({ templateLocationOf: lookup({ [TEMPLATE_ID]: LOC_B }) }))).ok).toBe(false)
    expect((await validateTvPush({ source_type: 'template', source_ref: TEMPLATE_ID, template_values: {} },
      ctx({ templateLocationOf: lookup({}) }))).ok).toBe(false)
    const c = ctx()
    expect((await validateTvPush({ source_type: 'template', source_ref: 'nope', template_values: {} }, c)).ok).toBe(false)
    expect(c.templateLocationOf).not.toHaveBeenCalled()
  })

  it.each([[null], ['text'], [[1, 2]], [42]])('refuses template_values %j (must be an object)', async (values) => {
    const r = await validateTvPush({ source_type: 'template', source_ref: TEMPLATE_ID, template_values: values }, ctx())
    expect(r.ok).toBe(false)
  })

  it('template_values is dropped (null) for a non-template push, so a previous board never lingers', async () => {
    const r = await validateTvPush({ source_type: 'url', source_ref: 'https://example.invalid/x', template_values: { z1: 'x' } }, ctx())
    expect(r.value.template_values).toBeNull()
  })

  it('refuses a source type a client may not push (generated is the Hyrox runner\'s, service role)', async () => {
    expect((await validateTvPush({ source_type: 'generated', source_ref: 'x' }, ctx())).ok).toBe(false)
  })
})

describe('isTemplateBaseImagePath', () => {
  it('a base image must sit under <studio>/templates/', () => {
    expect(isTemplateBaseImagePath(`${LOC_A}/templates/1c000000-0000-4000-8000-000000000003.png`, LOC_A)).toBe(true)
    expect(isTemplateBaseImagePath(`${LOC_B}/templates/x.png`, LOC_A)).toBe(false)
    expect(isTemplateBaseImagePath(`${LOC_A}/x.png`, LOC_A)).toBe(false)
    expect(isTemplateBaseImagePath(`${LOC_A}/templates/../../${LOC_B}/x.png`, LOC_A)).toBe(false)
    expect(isTemplateBaseImagePath(`${LOC_A}/templates/`, LOC_A)).toBe(false)
    expect(isTemplateBaseImagePath(null, LOC_A)).toBe(false)
  })
})

describe('loadTvDisplayForUser / loadTvTemplateForUser', () => {
  it('a TV at the caller\'s studio loads; the read is by id', async () => {
    const db = makeFakeDb(() => ({ data: display(), error: null }))
    const { display: d, response } = await loadTvDisplayForUser(db, OWNER_A, TV_ID, 'id, location_id')
    expect(response).toBeUndefined()
    expect(d.id).toBe(TV_ID)
    expect(db.calls[0]).toMatchObject({ table: 'tv_displays', filters: [['eq', 'id', TV_ID]] })
  })
  it('another studio\'s TV is 404, an unknown one 404, a bad id 404 without a read', async () => {
    const other = makeFakeDb(() => ({ data: display({ location_id: LOC_B }), error: null }))
    expect((await loadTvDisplayForUser(other, OWNER_A, TV_ID, 'id, location_id')).response.status).toBe(404)
    const none = makeFakeDb(() => ({ data: null, error: null }))
    expect((await loadTvDisplayForUser(none, OWNER_A, TV_ID, 'id, location_id')).response.status).toBe(404)
    const bad = makeFakeDb()
    expect((await loadTvDisplayForUser(bad, OWNER_A, 'x', 'id, location_id')).response.status).toBe(404)
    expect(bad.calls).toEqual([])
  })
  it('a read error is a 500 that says so, never a 404', async () => {
    const db = makeFakeDb(() => ({ data: null, error: { message: 'boom' } }))
    const { response } = await loadTvDisplayForUser(db, OWNER_A, TV_ID, 'id, location_id')
    expect(response.status).toBe(500)
  })
  it('the coarse gate runs before any read', async () => {
    const db = makeFakeDb()
    expect((await loadTvTemplateForUser(db, STAFF_A, TEMPLATE_ID, 'id, location_id')).response.status).toBe(403)
    expect((await loadTvTemplateForUser(db, null, TEMPLATE_ID, 'id, location_id')).response.status).toBe(401)
    expect(db.calls).toEqual([])
  })
  it('a template at the caller\'s studio loads from tv_templates', async () => {
    const db = makeFakeDb(() => ({ data: template(), error: null }))
    const { template: t } = await loadTvTemplateForUser(db, MOBILE_ONLY_A, TEMPLATE_ID, 'id, location_id')
    expect(t.id).toBe(TEMPLATE_ID)
    expect(db.calls[0].table).toBe('tv_templates')
  })
})

describe('mergeTvContent', () => {
  it('attaches each TV\'s content row, or null for an idle TV', () => {
    const rows = mergeTvContent([display(), display({ id: 'b' })], [{ tv_display_id: TV_ID, source_type: 'url' }])
    expect(rows[0].content).toEqual({ tv_display_id: TV_ID, source_type: 'url' })
    expect(rows[1].content).toBeNull()
  })
})
