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
      data: {
        landing_preference: 'studio',
        email_signature: 'Sarah',
        email_signature_rich: null,
        // MAILFIX-SIGTRUTH.1 — a caller with no queue anywhere carries an
        // empty context, not an error and not a missing key.
        active_location_id: null,
        signature_contexts: [],
      },
    })
    expect(db.selects[0].filters).toEqual([['id', ME.id]])
  })

  it('reports an unset signature as an empty string', async () => {
    setupDb({ permissions: {}, email_signature: null })
    const body = await (await GET()).json()
    expect(body.data).toEqual({
      landing_preference: 'auto',
      email_signature: '',
      email_signature_rich: null,
      active_location_id: null,
      signature_contexts: [],
    })
  })
})

// ── MAILFIX-SIGTRUTH.1 — the signature context rides the GET ──────────────
describe('GET /api/me/preferences — signature_contexts', () => {
  // A caller who works a queue at one studio, shaped the way getCurrentUser
  // shapes one (per-location role via assignmentsByLocation; owner holds
  // email_inbox by code default).
  const QUEUE_WORKER = {
    ...ME,
    role: 'owner',
    locations: [{ id: 'loc-still', name: 'UN1T Stillorgan' }],
    assignmentsByLocation: { 'loc-still': { role: 'owner', permissions: {} } },
    activeLocation: { id: 'loc-still' },
  }

  const RICH = {
    enabled: true, name: 'Dean Nolan', title: 'Head Coach', phone: '087 111 2222', note: '', photo_url: null,
    links: [],
  }
  const STILL_CARD = { phone: '01 555 0001', links: [{ label: 'Book', url: 'https://un1t.ie/book' }] }

  // The profiles read keeps the flat builder; the two estate tables answer
  // the batched chains the loader issues (select → [eq] → in → limit).
  function answerEstate(db, { mailboxes, cards }) {
    const flatFrom = db.from
    db.from = (table) => {
      if (table !== 'company_settings' && table !== 'email_mailboxes') return flatFrom(table)
      const r = table === 'email_mailboxes' ? mailboxes : cards
      if (r instanceof Error) throw r
      const c = {}
      c.select = () => c
      c.eq = () => c
      c.in = () => c
      c.limit = () => Promise.resolve({ data: r, error: null })
      return c
    }
  }

  it('carries one entry per eligible location — inputs for the web, RENDERED text/flags for mobile', async () => {
    getCurrentUser.mockResolvedValue(QUEUE_WORKER)
    setupDb({ permissions: {}, email_signature: '', email_signature_rich: RICH })
    answerEstate(db, {
      mailboxes: [{ location_id: 'loc-still' }],
      cards: [{ location_id: 'loc-still', email_signature: STILL_CARD }],
    })
    const body = await (await GET()).json()
    expect(body.success).toBe(true)
    expect(body.data.active_location_id).toBe('loc-still')
    expect(body.data.signature_contexts).toHaveLength(1)
    const [entry] = body.data.signature_contexts
    // Inputs, verbatim — plus the editor's has_mailbox flag.
    expect(entry).toMatchObject({ location_id: 'loc-still', location_name: 'UN1T Stillorgan', studio_signature: STILL_CARD, has_mailbox: true })
    // Rendered: the studio's phone and link applied over the person's own,
    // the studio name on the detail line — what mobile shows verbatim.
    expect(entry.rich).toBe(true)
    expect(entry.has_photo).toBe(false)
    expect(entry.has_links).toBe(true)
    expect(entry.effective_text).toContain('Dean Nolan')
    expect(entry.effective_text).toContain('UN1T Stillorgan')
    expect(entry.effective_text).toContain('01 555 0001')
    expect(entry.effective_text).toContain('Book: https://un1t.ie/book')
    expect(entry.effective_text).not.toContain('087 111 2222')
  })

  it('effective_text is null (flags false) when nothing would append', async () => {
    getCurrentUser.mockResolvedValue(QUEUE_WORKER)
    setupDb({ permissions: {}, email_signature: null, email_signature_rich: null })
    answerEstate(db, { mailboxes: [{ location_id: 'loc-still' }], cards: [] })
    const body = await (await GET()).json()
    expect(body.data.signature_contexts).toEqual([
      {
        location_id: 'loc-still', location_name: 'UN1T Stillorgan', studio_signature: null, has_mailbox: true,
        effective_text: null, rich: false, has_photo: false, has_links: false,
      },
    ])
  })

  it('a permitted studio with no mailbox is still an entry — has_mailbox:false, still rendered', async () => {
    getCurrentUser.mockResolvedValue(QUEUE_WORKER)
    setupDb({ permissions: {}, email_signature: '', email_signature_rich: RICH })
    answerEstate(db, { mailboxes: [], cards: [] })
    const body = await (await GET()).json()
    const [entry] = body.data.signature_contexts
    expect(entry.has_mailbox).toBe(false)
    // An orphan ticket at this studio sends with its studio line — so the
    // rendered text carries it too.
    expect(entry.effective_text).toBe('Dean Nolan\nHead Coach · UN1T Stillorgan\n087 111 2222')
  })

  it('degrades gracefully on a blipped context read — 200, preferences intact, entry kept with null card', async () => {
    getCurrentUser.mockResolvedValue(QUEUE_WORKER)
    setupDb()
    answerEstate(db, { mailboxes: new Error('connection blip'), cards: new Error('connection blip') })
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    // The plain preferences half survives whole…
    expect(body.data.email_signature).toBe('Sarah')
    // …and the context entry survives with its card degraded to null and the
    // studio still OFFERED (unknown mailbox state → offer, never hide). The
    // studio line still resolves off user.locations; the rendered half still
    // answers: the plain column appends.
    expect(body.data.signature_contexts).toEqual([
      {
        location_id: 'loc-still', location_name: 'UN1T Stillorgan', studio_signature: null, has_mailbox: true,
        effective_text: 'Sarah', rich: false, has_photo: false, has_links: false,
      },
    ])
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
