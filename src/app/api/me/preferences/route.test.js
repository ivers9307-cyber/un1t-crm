// EMAIL-TICKET.5 — the self-service preference route, now carrying the email
// signature.
//
// THE PROPERTY THIS FILE EXISTS FOR
// The write is scoped to getCurrentUser().id and to nothing else. This route
// runs on the service-role client, so RLS does nothing — the .eq('id', …) IS
// the gate. A signature is what a person's replies go out signed as, so a
// body-supplied id would let anyone put words in a colleague's mouth. Every
// test therefore sends one, and asserts it is ignored.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

import { GET, PATCH } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'

const ME = { id: 'profile-me', email: 'me@un1tdublin.com' }
const COLLEAGUE = 'profile-someone-else'

let db
function setupDb(profile = { permissions: { landing_preference: 'studio' }, email_signature: 'Sarah' }) {
  db = { updates: [], selects: [] }
  db.from = () => {
    const b = { _filters: [], _op: 'select', _payload: null }
    b.select = () => b
    b.update = (p) => { b._op = 'update'; b._payload = p; return b }
    b.eq = (col, val) => { b._filters.push([col, val]); return b }
    const settle = () => {
      if (b._op === 'update') {
        db.updates.push({ payload: b._payload, filters: b._filters })
        return { data: null, error: null }
      }
      db.selects.push({ filters: b._filters })
      return { data: profile, error: null }
    }
    b.single = () => Promise.resolve(settle())
    b.maybeSingle = () => Promise.resolve(settle())
    b.then = (res, rej) => Promise.resolve(settle()).then(res, rej)
    return b
  }
  createServerClient.mockImplementation(() => db)
  return db
}

function patch(body) {
  return PATCH(new Request('http://x/api/me/preferences', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(ME)
  setupDb()
})

describe('PATCH /api/me/preferences — scoping', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await patch({ email_signature: 'x' })).status).toBe(401)
  })

  it('writes ONLY the caller’s own row, whatever id the body claims', async () => {
    const res = await patch({ id: COLLEAGUE, email_signature: 'Not mine' })
    // `.strict()` on the schema means an unknown `id` is a 400, so the attempt
    // never even reaches the database.
    expect(res.status).toBe(400)
    expect(db.updates).toHaveLength(0)
  })

  it('scopes the update to getCurrentUser().id', async () => {
    await patch({ email_signature: 'Sarah\nUN1T Stillorgan' })
    expect(db.updates).toHaveLength(1)
    expect(db.updates[0].filters).toEqual([['id', ME.id]])
  })
})

describe('PATCH /api/me/preferences — email_signature', () => {
  it('stores the trimmed signature', async () => {
    const res = await patch({ email_signature: '  Sarah\r\nUN1T  ' })
    expect(res.status).toBe(200)
    expect(db.updates[0].payload).toEqual({ email_signature: 'Sarah\nUN1T' })
  })

  it('stores NULL, not "", when it is cleared', async () => {
    // One representation of "no signature" everywhere.
    for (const value of ['', '   \n  ', null]) {
      setupDb()
      await patch({ email_signature: value })
      // Clearing the PLAIN signature writes only that key — the route never
      // touches email_signature_rich unless the caller sent it.
      expect(db.updates[0].payload).toEqual({ email_signature: null })
    }
  })

  it('does not touch the permissions blob when only the signature changed', async () => {
    await patch({ email_signature: 'Sarah' })
    // No read-modify-write of the JSONB, so a signature edit can't clobber an
    // admin-set permission key as a side effect.
    expect(db.selects).toHaveLength(0)
    expect(db.updates[0].payload.permissions).toBeUndefined()
  })

  it('rejects a signature past the mig 493 CHECK length', async () => {
    const res = await patch({ email_signature: 'x'.repeat(2001) })
    expect(res.status).toBe(400)
    expect(db.updates).toHaveLength(0)
  })

  it('still merges the permissions blob for landing_preference', async () => {
    await patch({ landing_preference: 'personal' })
    expect(db.updates[0].payload.permissions).toEqual({ landing_preference: 'personal' })
  })

  it('400s on an empty body rather than writing nothing', async () => {
    expect((await patch({})).status).toBe(400)
    expect(db.updates).toHaveLength(0)
  })
})

describe('GET /api/me/preferences', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET()).status).toBe(401)
  })

  it('returns the caller’s own signature, read from their own row', async () => {
    const res = await GET()
    const body = await res.json()
    expect(body).toEqual({
      success: true,
      data: { landing_preference: 'studio', email_signature: 'Sarah', email_signature_rich: null },
    })
    expect(db.selects[0].filters).toEqual([['id', ME.id]])
  })

  it('reports an unset signature as an empty string', async () => {
    setupDb({ permissions: {}, email_signature: null })
    const body = await (await GET()).json()
    expect(body.data).toEqual({ landing_preference: 'auto', email_signature: '', email_signature_rich: null })
  })
})

// ── MAIL-SIG.1 audit #3 — the rich schema's refusals, as tests not comments ──
describe('PATCH email_signature_rich — the write-side gates', () => {
  const GOOD = {
    enabled: true, name: 'X', links: [],
    photo_url: 'https://iyvtbjjxdggiadzwwvdj.supabase.co/storage/v1/object/public/branding/signatures/u/p.jpg',
  }

  it('accepts the shape and writes ONLY that column', async () => {
    setupDb()
    const res = await patch({ email_signature_rich: GOOD })
    expect(res.status).toBe(200)
    // zod's .default('') fills the optional strings — the WRITTEN row is the
    // parsed shape, which is exactly what the renderer expects to read back.
    expect(db.updates[0].payload).toEqual({
      email_signature_rich: { ...GOOD, title: '', phone: '', note: '' },
    })
  })

  it('400s a foreign photo_url — including a dot-segment escape', async () => {
    for (const url of [
      'https://evil.example/x.jpg',
      'https://iyvtbjjxdggiadzwwvdj.supabase.co/storage/v1/object/public/branding/../other/x.jpg',
    ]) {
      setupDb()
      const res = await patch({ email_signature_rich: { ...GOOD, photo_url: url } })
      expect(res.status).toBe(400)
    }
  })

  it('400s unknown keys (strict), a sixth link, and a javascript: link', async () => {
    setupDb()
    expect((await patch({ email_signature_rich: { ...GOOD, sneaky: 1 } })).status).toBe(400)
    setupDb()
    const six = Array.from({ length: 6 }, (_, i) => ({ label: `L${i}`, url: `https://x.ie/${i}` }))
    expect((await patch({ email_signature_rich: { ...GOOD, links: six } })).status).toBe(400)
    setupDb()
    expect((await patch({ email_signature_rich: { ...GOOD, links: [{ label: 'x', url: 'javascript:alert(1)' }] } })).status).toBe(400)
  })
})
