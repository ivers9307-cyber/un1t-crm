import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
const dbState = { tables: {} }
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from(table) {
      const filters = []
      let orderBy = null
      const q = {
        select: () => q,
        eq: (c, v) => { filters.push([c, v]); return q },
        in: (c, v) => { filters.push([c, v]); return q },
        order: (c) => { orderBy = c; return q },
        range: () => q,
        then: (res, rej) => {
          const t = dbState.tables[table]
          let data = t.data || []
          for (const [c, v] of filters) {
            if (['enabled', 'archived'].includes(c)) data = data.filter((r) => r[c] === v)
          }
          if (orderBy) data = [...data].sort((a, b) => a[orderBy] - b[orderBy])
          return Promise.resolve({ data: t.error ? null : data, error: t.error || null }).then(res, rej)
        },
      }
      return q
    },
  }),
}))

import { GET } from './route'
import { getCurrentUser } from '@/lib/auth'

const props = { params: { id: 'loc1' } }
const req = () => new Request('http://x/api/locations/loc1/stages')
const userWith = (role, locs = ['loc1']) => ({
  id: 'u', role, profileRole: role, isMaster: false,
  activeLocation: { id: locs[0] }, locations: locs.map((id) => ({ id })),
  rolesByLocation: Object.fromEntries(locs.map((id) => [id, role])),
})
const board = (o) => ({ id: 'b1', key: 'main', name: 'Main', display_order: 1, enabled: true, ...o })
const stage = (o) => ({ id: 's', pipeline_id: 'b1', slug: 'x', name: 'X', color: '#fff', stage_role: 'custom', role_config: null, is_dormant: false, display_order: 1, archived: false, ...o })

beforeEach(() => {
  dbState.tables = {
    pipelines: { data: [board()] },
    pipeline_stages: { data: [stage()] },
  }
})

describe('GET /api/locations/[id]/stages', () => {
  it('401Unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(req(), props)).status).toBe(401)
  })

  it('404OtherStudio', async () => {
    getCurrentUser.mockResolvedValue(userWith('owner', ['other']))
    expect((await GET(req(), props)).status).toBe(404)
  })

  it('200AnyMember', async () => {
    getCurrentUser.mockResolvedValue(userWith('staff'))
    const res = await GET(req(), props)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.stages).toEqual([
      { slug: 'x', name: 'X', color: '#fff', stage_role: 'custom', role_config: null, is_dormant: false, display_order: 1, board_key: 'main', board_name: 'Main' },
    ])
  })

  it('503OnReadError', async () => {
    getCurrentUser.mockResolvedValue(userWith('staff'))
    dbState.tables.pipeline_stages = { error: { message: 'boom' } }
    expect((await GET(req(), props)).status).toBe(503)
  })

  it('excludesDisabledBoardsAndArchivedStages', async () => {
    getCurrentUser.mockResolvedValue(userWith('staff'))
    dbState.tables = {
      pipelines: { data: [board({ id: 'b2', key: 'late', name: 'Late', display_order: 2 }), board(), board({ id: 'b3', key: 'off', enabled: false })] },
      pipeline_stages: { data: [
        stage({ slug: 'b2s', pipeline_id: 'b2', display_order: 1 }),
        stage({ slug: 'b1second', display_order: 2 }),
        stage({ slug: 'b1first', display_order: 1 }),
        stage({ slug: 'gone', archived: true }),
        stage({ slug: 'offstage', pipeline_id: 'b3' }),
      ] },
    }
    const body = await (await GET(req(), props)).json()
    expect(body.data.stages.map((s) => s.slug)).toEqual(['b1first', 'b1second', 'b2s'])
  })
})
