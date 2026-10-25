// ORGCONTACTS.5 (final review I4) — GET /api/mobile/contacts/search: the phone
// directory's search, served from public.studio_contacts (mig 765) at the
// active studio on the service role. Decision 2 widened "the studio's
// contacts" to every relationship, which put the crossover count past the
// 100-id cap the phone's id.in() URL could carry (≥102 at Stillorgan, ~230 at
// Hatch Street on 25 Oct 2026), so a named person could simply be missing from
// the phone directory. The route has no cap to hit: one equality filter.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/permissions', async (orig) => ({ ...(await orig()), hasMobilePermission: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))

import { getCurrentUser } from '@/lib/auth'
import { hasMobilePermission } from '@/lib/permissions'
import { GET, MOBILE_CONTACT_SEARCH_COLUMNS, MOBILE_CONTACT_SEARCH_MAX } from './route.js'

const HATCH = { id: 'loc-hatch', name: 'Hatch Street' }
const user = (over = {}) => ({ id: 'u1', role: 'staff', locations: [HATCH], activeLocation: HATCH, ...over })
const ROWS = [{ id: 'c-1', name: 'Ann Example', phone: '+353871234567' }]

function viewDb(rows = ROWS, { error = null } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      const call = { table, select: null, filters: [], or: [], order: [], limit: null }
      calls.push(call)
      const b = {
        select(c) { call.select = c; return b },
        eq(c, v) { call.filters.push(['eq', c, v]); return b },
        or(s) { call.or.push(s); return b },
        order(c, o) { call.order.push([c, o]); return b },
        limit(n) { call.limit = n; return b },
        then(res, rej) { return Promise.resolve(error ? { data: null, error } : { data: rows, error: null }).then(res, rej) },
      }
      return b
    },
  }
}
const req = (qs = '') => new Request(`http://localhost/api/mobile/contacts/search${qs}`)

beforeEach(() => {
  vi.clearAllMocks()
  db = viewDb()
  getCurrentUser.mockResolvedValue(user())
  hasMobilePermission.mockReturnValue(true)
})

describe('GET /api/mobile/contacts/search', () => {
  it('401 signed out, 400 with no active studio, 403 without the mobile contacts permission; nothing read', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(req())).status).toBe(401)
    getCurrentUser.mockResolvedValue(user({ activeLocation: null }))
    expect((await GET(req())).status).toBe(400)
    getCurrentUser.mockResolvedValue(user())
    hasMobilePermission.mockReturnValue(false)
    expect((await GET(req())).status).toBe(403)
    expect(hasMobilePermission).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'contacts')
    expect(db.calls).toEqual([])
  })

  it('no term: the studio\'s primary rows off the view, newest first, 40 by default, the phone\'s columns', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { contacts: ROWS } })
    const [call] = db.calls
    expect(call.table).toBe('studio_contacts')
    expect(call.select).toBe(MOBILE_CONTACT_SEARCH_COLUMNS)
    expect(call.filters).toEqual(expect.arrayContaining([['eq', 'studio_location_id', 'loc-hatch'], ['eq', 'is_primary_contact', true]]))
    expect(call.or).toEqual([])
    expect(call.order).toEqual([['created_at', { ascending: false }]])
    expect(call.limit).toBe(40)
    for (const col of ['id', 'name', 'first_name', 'last_name', 'email', 'phone', 'wa_phone', 'pipeline_stage_slug', 'studio_stage_slug', 'lead_source', 'tags', 'created_at', 'location_id', 'studio_is_crossover']) {
      expect(MOBILE_CONTACT_SEARCH_COLUMNS.split(',').map((s) => s.trim())).toContain(col)
    }
  })

  it('a term: one or() per token over name / email / first / last name, digits over phone and wa_phone too, name order, control characters stripped', async () => {
    await GET(req('?q=' + encodeURIComponent('ann 0871,%(x)')))
    const [call] = db.calls
    expect(call.or).toHaveLength(2)
    expect(call.or[0]).toBe('name.ilike.%ann%,email.ilike.%ann%,first_name.ilike.%ann%,last_name.ilike.%ann%')
    expect(call.or[1]).toBe('name.ilike.%0871x%,email.ilike.%0871x%,first_name.ilike.%0871x%,last_name.ilike.%0871x%,phone.ilike.%0871%,wa_phone.ilike.%0871%')
    expect(call.order).toEqual([['name', { ascending: true }]])
  })

  it('limit is honoured up to the cap; a bad limit is the default', async () => {
    await GET(req('?limit=12'))
    expect(db.calls[0].limit).toBe(12)
    await GET(req('?limit=9999'))
    expect(db.calls[1].limit).toBe(MOBILE_CONTACT_SEARCH_MAX)
    await GET(req('?limit=abc'))
    expect(db.calls[2].limit).toBe(40)
  })

  it('a failed read is a 500 with no Postgres text, so the phone falls back to its own read', async () => {
    db = viewDb([], { error: { code: '42501', message: 'permission denied for view studio_contacts' } })
    const res = await GET(req('?q=ann'))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(JSON.stringify(body)).not.toMatch(/permission denied/)
  })
})
