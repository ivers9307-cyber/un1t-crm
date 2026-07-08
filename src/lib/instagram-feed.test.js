import { describe, it, expect } from 'vitest'
import { normalizeIgMedia, fetchIgMedia, fetchIgUsername, syncLocationIgFeed } from './instagram-feed.js'

describe('normalizeIgMedia', () => {
  const img = { id: '1', media_type: 'IMAGE', media_url: 'https://cdn/i1.jpg', permalink: 'https://instagram.com/p/1', caption: 'hello', timestamp: '2026-07-01T10:00:00Z' }
  const reel = { id: '2', media_type: 'VIDEO', media_product_type: 'REELS', thumbnail_url: 'https://cdn/t2.jpg', media_url: 'https://cdn/v2.mp4', permalink: 'https://instagram.com/reel/2', timestamp: '2026-07-02T10:00:00Z' }

  it('maps an image post to a row (image_url from media_url)', () => {
    const [row] = normalizeIgMedia([img])
    expect(row).toMatchObject({ ig_media_id: '1', media_type: 'IMAGE', is_reel: false, permalink: 'https://instagram.com/p/1', image_url: 'https://cdn/i1.jpg', posted_at: '2026-07-01T10:00:00Z' })
  })

  it('detects a reel and uses thumbnail_url for video image_url', () => {
    const [row] = normalizeIgMedia([reel])
    expect(row.is_reel).toBe(true)
    expect(row.image_url).toBe('https://cdn/t2.jpg')
  })

  it('truncates long captions to <=140 chars with an ellipsis', () => {
    const [row] = normalizeIgMedia([{ ...img, caption: 'x'.repeat(200) }])
    expect(row.caption.length).toBeLessThanOrEqual(140)
    expect(row.caption.endsWith('…')).toBe(true)
  })

  it('drops items with no id/permalink or no usable image', () => {
    expect(normalizeIgMedia([{ id: '3', permalink: 'https://instagram.com/p/3', media_type: 'IMAGE' }])).toHaveLength(0) // no media_url
    expect(normalizeIgMedia([{ media_type: 'IMAGE', media_url: 'x' }])).toHaveLength(0) // no id/permalink
    expect(normalizeIgMedia(null)).toEqual([])
  })
})

describe('fetchIgMedia', () => {
  const conn = { external_account_id: 'ig123', access_token: 'tok' }
  it('calls the media edge with fields+token and normalizes the result', async () => {
    const calls = []
    const fetchImpl = async (url) => { calls.push(url); return { ok: true, json: async () => ({ data: [{ id: '1', media_type: 'IMAGE', media_url: 'https://cdn/i.jpg', permalink: 'https://instagram.com/p/1' }] }) } }
    const rows = await fetchIgMedia(conn, { fetchImpl, limit: 5 })
    expect(calls[0]).toContain('/ig123/media')
    expect(calls[0]).toContain('access_token=tok')
    expect(rows).toHaveLength(1)
  })
  it('throws on a Graph error (so the caller keeps last-good)', async () => {
    const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'bad scope' } }) })
    await expect(fetchIgMedia(conn, { fetchImpl })).rejects.toThrow(/bad scope/)
  })
  it('throws when the connection lacks id/token', async () => {
    await expect(fetchIgMedia({}, {})).rejects.toThrow(/external_account_id/)
  })
})

describe('fetchIgUsername', () => {
  it('returns the account username, or null on error', async () => {
    const ok = async () => ({ ok: true, json: async () => ({ username: 'un1tstillorgan' }) })
    expect(await fetchIgUsername({ external_account_id: 'ig123', access_token: 'tok' }, { fetchImpl: ok })).toBe('un1tstillorgan')
    const bad = async () => ({ ok: false, status: 400, json: async () => ({}) })
    expect(await fetchIgUsername({ external_account_id: 'ig123', access_token: 'tok' }, { fetchImpl: bad })).toBeNull()
  })
})

function fakeDb(existingIds = []) {
  const ops = { upserts: [], deletedIn: null, uploads: [] }
  const db = {
    from: (table) => ({
      upsert: async (row, opts) => { ops.upserts.push({ table, row, opts }); return { error: null } },
      select: () => ({ eq: async () => ({ data: existingIds.map((id) => ({ ig_media_id: id })) }) }),
      delete: () => ({ eq: () => ({ in: async (_c, ids) => { ops.deletedIn = ids; return { error: null } } }) }),
    }),
    storage: { from: () => ({ upload: async (path) => { ops.uploads.push(path); return { error: null } } }) },
  }
  return { db, ops }
}

describe('syncLocationIgFeed', () => {
  const conn = { location_id: 'loc1', external_account_id: 'ig1', access_token: 'tok' }
  const mediaResp = { ok: true, json: async () => ({ data: [
    { id: 'A', media_type: 'IMAGE', media_url: 'https://cdn/a.jpg', permalink: 'https://instagram.com/p/A', timestamp: '2026-07-01T00:00:00Z' },
    { id: 'B', media_type: 'VIDEO', media_product_type: 'REELS', thumbnail_url: 'https://cdn/b.jpg', permalink: 'https://instagram.com/reel/B', timestamp: '2026-07-02T00:00:00Z' },
  ] }) }
  // fetchImpl: media edge → mediaResp; username → username; image bytes → ok arrayBuffer
  const fetchImpl = async (url) => {
    if (url.includes('/media')) return mediaResp
    if (url.includes('fields=username')) return { ok: true, json: async () => ({ username: 'un1t' }) }
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }
  }

  it('re-hosts thumbnails, upserts each post, prunes stale rows', async () => {
    const { db, ops } = fakeDb(['A', 'B', 'OLD'])
    const r = await syncLocationIgFeed({ db, connection: conn, fetchImpl })
    expect(r.synced).toBe(2)
    expect(ops.uploads).toEqual(['loc1/A.jpg', 'loc1/B.jpg'])
    expect(ops.upserts.map((u) => u.row.ig_media_id).sort()).toEqual(['A', 'B'])
    expect(ops.upserts.find((u) => u.row.ig_media_id === 'B').row.is_reel).toBe(true)
    expect(ops.upserts[0].row.ig_username).toBe('un1t')
    expect(ops.deletedIn).toEqual(['OLD']) // stale pruned; A/B kept
  })

  it('does NOT prune when Graph returns zero posts (keep last-good)', async () => {
    const { db, ops } = fakeDb(['A'])
    const emptyFetch = async (url) => url.includes('/media')
      ? { ok: true, json: async () => ({ data: [] }) }
      : { ok: true, json: async () => ({ username: 'un1t' }) }
    const r = await syncLocationIgFeed({ db, connection: conn, fetchImpl: emptyFetch })
    expect(r.synced).toBe(0)
    expect(ops.deletedIn).toBeNull()
    expect(ops.upserts).toHaveLength(0)
  })

  it('skips a post whose image re-host fails but keeps the others', async () => {
    const { db, ops } = fakeDb([])
    const failB = async (url) => {
      if (url.includes('/media')) return mediaResp
      if (url.includes('fields=username')) return { ok: true, json: async () => ({ username: 'un1t' }) }
      if (url.includes('b.jpg')) return { ok: false, status: 500 } // B's image fails
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }
    }
    const r = await syncLocationIgFeed({ db, connection: conn, fetchImpl: failB })
    expect(r.synced).toBe(1)
    expect(ops.upserts.map((u) => u.row.ig_media_id)).toEqual(['A'])
  })

  it('does NOT wipe the last-good cache when EVERY re-host fails (keep-last-good)', async () => {
    // Graph returns A+B fine, but every image re-host blips this run. The
    // existing A/B rows must survive — prune keys on the ids IG returned, not
    // on what re-hosted successfully.
    const { db, ops } = fakeDb(['A', 'B'])
    const allImagesFail = async (url) => {
      if (url.includes('/media')) return mediaResp
      if (url.includes('fields=username')) return { ok: true, json: async () => ({ username: 'un1t' }) }
      return { ok: false, status: 503 } // every image fetch fails
    }
    const r = await syncLocationIgFeed({ db, connection: conn, fetchImpl: allImagesFail })
    expect(r.synced).toBe(0)
    expect(ops.upserts).toHaveLength(0)
    expect(ops.deletedIn).toBeNull() // A/B preserved — nothing pruned
  })
})
