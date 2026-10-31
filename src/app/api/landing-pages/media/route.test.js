// MEDIALIB.1 — GET /api/landing-pages/media: the media library is scoped
// exactly like the Pages list. A caller sees the files of the pages
// canViewPage admits (their `pages/<id>/` folders and the legacy folders of
// those pages' studios) and nothing else: a user without the landing_page
// permission at a page sees none of its files, a coach sees nothing at all,
// a video carries the poster the page's blocks pair with it, and a failed
// folder read is a 503, never a shorter list.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { GET } = await import('./route.js')
const {
  fakeDb, STILL_MANAGER, STILL_COACH, ORG_ADMIN, MASTER, STILL, HATCH, ELSEWHERE, PAGE,
} = await import('../../../../../tests/helpers/landing-pages-fixtures.js')

const PUBLIC = 'https://cdn.example/storage/v1/object/public/branding'
const url = (path) => `${PUBLIC}/${path}`

// One object per folder the fixtures could reach, so a leak is one URL.
const obj = (name, created_at, size = 1000, mimetype = null) => ({ id: `id-${name}`, name, created_at, metadata: { size, mimetype } })
function folders() {
  return {
    [`pages/${PAGE.stillorgan}`]: [obj('s-hero.mp4', '2026-10-20T10:00:00Z'), obj('s-hero.jpg', '2026-10-20T09:00:00Z')],
    [`pages/${PAGE.trial}`]: [obj('t-coach.mp4', '2026-10-25T10:00:00Z'), obj('t-poster.jpg', '2026-10-25T09:59:00Z'), { id: null, name: 'sub' }],
    [`pages/${PAGE.fiftyplus}`]: [obj('f-clip.webm', '2026-10-28T10:00:00Z')],
    [`pages/${PAGE.corp}`]: [obj('c-hatch.mp4', '2026-10-29T10:00:00Z'), obj('c-hatch.png', '2026-10-29T10:01:00Z')],
    [`pages/${PAGE.hatch}`]: [obj('h-studio.mp4', '2026-10-18T10:00:00Z')],
    [`pages/${PAGE.other}`]: [obj('autos.mp4', '2026-10-30T10:00:00Z')],
    [`landing-page/${STILL}`]: [obj('legacy-still.mp4', '2026-09-01T10:00:00Z'), obj('chooser.jpg', '2026-09-02T10:00:00Z')],
    [`landing-page/${HATCH}`]: [obj('legacy-hatch.mov', '2026-09-03T10:00:00Z')],
    [`landing-page/${ELSEWHERE}`]: [obj('legacy-autos.mp4', '2026-09-04T10:00:00Z')],
  }
}

function withStorage(db, { folders: f = folders(), failPrefix = null } = {}) {
  const listed = []
  db.storage = {
    from(bucket) {
      if (bucket !== 'branding') throw new Error(`unexpected bucket ${bucket}`)
      return {
        list: async (prefix) => {
          listed.push(prefix)
          if (failPrefix && prefix === failPrefix) return { data: null, error: { message: 'boom' } }
          return { data: f[prefix] || [], error: null }
        },
        getPublicUrl: (path) => ({ data: { publicUrl: url(path) } }),
      }
    },
  }
  db.listed = listed
  return db
}

const get = (qs = '') => GET(new Request(`http://localhost/api/landing-pages/media${qs}`))
const urlsOf = (body) => body.data.items.map((i) => i.url)

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = withStorage(fakeDb())
  // The trial page's coach clip has its poster next to it in the blocks.
  db.state.landing_pages.find((p) => p.id === PAGE.trial).blocks.push({
    id: 'cf', type: 'campaign_funnel', video_url: url(`pages/${PAGE.trial}/t-coach.mp4`), poster_url: url(`pages/${PAGE.trial}/t-poster.jpg`),
  })
  createServerClient.mockReturnValue(db)
})

describe('GET /api/landing-pages/media', () => {
  it('401 without a session, 400 on a kind that is neither video nor image', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get('?kind=video')).status).toBe(401)
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    expect((await get('?kind=audio')).status).toBe(400)
    expect(db.listed).toEqual([])
  })

  it('a Stillorgan manager sees the files of stillorgan, trial and 50plus and the Stillorgan legacy folder; never corp, the Hatch page, Hatch legacy or another organisation', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    const res = await get('?kind=video')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    const urls = urlsOf(body)
    expect(urls).toEqual([
      url(`pages/${PAGE.fiftyplus}/f-clip.webm`),
      url(`pages/${PAGE.trial}/t-coach.mp4`),
      url(`pages/${PAGE.stillorgan}/s-hero.mp4`),
      url(`landing-page/${STILL}/legacy-still.mp4`),
    ])
    // The folders of pages outside the view are never even listed.
    expect(db.listed).not.toContain(`pages/${PAGE.corp}`)
    expect(db.listed).not.toContain(`pages/${PAGE.hatch}`)
    expect(db.listed).not.toContain(`pages/${PAGE.other}`)
    expect(db.listed).not.toContain(`landing-page/${HATCH}`)
    expect(db.listed).not.toContain(`landing-page/${ELSEWHERE}`)
    // Kind filter: no image among videos; a sub-folder entry is not a file.
    expect(body.data.items.every((i) => i.kind === 'video')).toBe(true)
    expect(JSON.stringify(body)).not.toContain('/sub')
  })

  it('each item names its page, size, created time, and a video its poster when the page\'s blocks pair one', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    const { data } = await (await get('?kind=video')).json()
    const coach = data.items.find((i) => i.name === 't-coach.mp4')
    expect(coach).toMatchObject({
      kind: 'video', page_id: PAGE.trial, page_title: '14 Day Reset', size: 1000,
      created_at: '2026-10-25T10:00:00Z', poster_url: url(`pages/${PAGE.trial}/t-poster.jpg`),
    })
    const hero = data.items.find((i) => i.name === 's-hero.mp4')
    expect(hero.poster_url).toBeNull()
    // A legacy file reads as the studio's own page.
    const legacy = data.items.find((i) => i.name === 'legacy-still.mp4')
    expect(legacy).toMatchObject({ page_id: PAGE.stillorgan, page_title: 'UN1T Stillorgan', location_id: STILL })
  })

  it('kind=image lists images only; no kind lists both', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    const images = urlsOf(await (await get('?kind=image')).json())
    expect(images).toEqual([
      url(`pages/${PAGE.trial}/t-poster.jpg`),
      url(`pages/${PAGE.stillorgan}/s-hero.jpg`),
      url(`landing-page/${STILL}/chooser.jpg`),
    ])
    const all = await (await get()).json()
    expect(all.data.items).toHaveLength(7)
  })

  it('a coach without landing_page sees nothing and no folder is listed', async () => {
    getCurrentUser.mockResolvedValue(STILL_COACH)
    const res = await get('?kind=video')
    expect(res.status).toBe(200)
    expect((await res.json()).data.items).toEqual([])
    expect(db.listed).toEqual([])
  })

  it('an org admin sees every folder of the organisation (corp, Hatch legacy included), a master every organisation', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    const admin = urlsOf(await (await get('?kind=video')).json())
    expect(admin).toContain(url(`pages/${PAGE.corp}/c-hatch.mp4`))
    expect(admin).toContain(url(`landing-page/${HATCH}/legacy-hatch.mov`))
    expect(admin).not.toContain(url(`pages/${PAGE.other}/autos.mp4`))

    getCurrentUser.mockResolvedValue(MASTER)
    const master = urlsOf(await (await get('?kind=video')).json())
    expect(master).toContain(url(`pages/${PAGE.other}/autos.mp4`))
    expect(master).toContain(url(`landing-page/${ELSEWHERE}/legacy-autos.mp4`))
  })

  it('a failed folder read is a 503, never a shorter list; so is a failed pages read', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    createServerClient.mockReturnValue(withStorage(fakeDb(), { failPrefix: `pages/${PAGE.trial}` }))
    expect((await get('?kind=video')).status).toBe(503)
    createServerClient.mockReturnValue(withStorage(fakeDb({ failures: { 'landing_pages.select': { message: 'boom' } } })))
    expect((await get('?kind=video')).status).toBe(503)
  })
})
