// MAILFIX-SIGTRUTH.1 — the read side of "what you see is what sends".
//
// THE PROPERTY THIS FILE EXISTS FOR: resolveSignatureHint answers exactly
// what the send routes append, per sending location — the rich signature
// resolved through the studio context when the raw value is enabled AND
// renderable, else the plain column, else nothing — and answers NULL for a
// location it has no context for, never the person's unresolved values. Its
// cases are copied from the reply route's own decision
// (richSignatureFromProfile gate → renderRichSignature(effectiveRichSignature
// (…)) → plain fallback), so a drift between hint and send is a red test, not
// a support call.
//
// withEffectiveText is the same function run server-side per entry — the
// mobile contract — so its cases are the resolver's, seen through the wire.

import { describe, it, expect } from 'vitest'
import {
  PER_STUDIO_MAILBOX_CEILING,
  eligibleSignatureLocations,
  loadSignatureContexts,
  signatureStudiosToOffer,
  signatureContextFor,
  resolveSignatureHint,
  withEffectiveText,
} from './signature-context'

// A caller shaped the way getCurrentUser shapes one: per-location role via
// assignmentsByLocation, locations rows with names. Owner holds email_inbox
// by code default; staff does not.
function queueWorker(over = {}) {
  return {
    id: 'profile-me',
    role: 'owner',
    locations: [
      { id: 'loc-still', name: 'UN1T Stillorgan' },
      { id: 'loc-hatch', name: 'UN1T Hatch Street' },
    ],
    assignmentsByLocation: {
      'loc-still': { role: 'owner', permissions: {} },
      'loc-hatch': { role: 'owner', permissions: {} },
    },
    ...over,
  }
}

const BUCKET_PHOTO = 'https://iyvtbjjxdggiadzwwvdj.supabase.co/storage/v1/object/public/branding/signatures/u/p.jpg'

const RICH = { enabled: true, name: 'Alex Example', title: 'Head Coach', phone: '087 111 2222', note: 'typed note', links: [] }

const CONTEXTS = [
  {
    location_id: 'loc-still',
    location_name: 'UN1T Stillorgan',
    studio_signature: { phone: '01 555 0001', links: [{ label: 'Book Stillorgan', url: 'https://un1t.ie/stillorgan' }] },
    has_mailbox: true,
  },
  // Permitted, but no mailbox — an orphan-ticket studio. Still resolves.
  { location_id: 'loc-hatch', location_name: 'UN1T Hatch Street', studio_signature: null, has_mailbox: false },
]

describe('eligibleSignatureLocations', () => {
  it('keeps only locations where the caller holds email_inbox', () => {
    const user = queueWorker({
      assignmentsByLocation: {
        'loc-still': { role: 'owner', permissions: {} },
        // Explicit per-user OFF at Hatch — tier 2 wins over the role default.
        'loc-hatch': { role: 'owner', permissions: { email_inbox: false } },
      },
    })
    expect(eligibleSignatureLocations(user)).toEqual([{ id: 'loc-still', name: 'UN1T Stillorgan' }])
  })

  it('answers [] for a null / location-less user rather than throwing', () => {
    expect(eligibleSignatureLocations(null)).toEqual([])
    expect(eligibleSignatureLocations({ id: 'x' })).toEqual([])
  })
})

describe('loadSignatureContexts', () => {
  // A per-table db whose builders RECORD their filters — `.eq`/`.in`/`.limit`
  // are what scope the read, so a mock that discards them cannot prove the
  // read is scoped. `.limit()` settles the chain. `result` may be a
  // PostgREST-shaped { data, error } or an Error to THROW from .from().
  const OK = (data) => ({ data, error: null })
  const ERR = { data: null, error: { message: 'boom' } }
  const THROWN = new Error('network down')
  function chain(result, log) {
    const call = { select: null, eq: [], in: [], limit: null }
    const b = {}
    b.select = (cols) => { call.select = cols; return b }
    b.eq = (col, val) => { call.eq.push([col, val]); return b }
    b.in = (col, vals) => { call.in.push([col, vals]); return b }
    b.limit = (n) => { call.limit = n; log.push(call); return Promise.resolve(result) }
    return b
  }
  function dbWith({ mailboxes, cards }) {
    const log = { email_mailboxes: [], company_settings: [] }
    return {
      log,
      from: (table) => {
        const r = table === 'email_mailboxes' ? mailboxes : cards
        if (r instanceof Error) throw r
        return chain(r, log[table])
      },
    }
  }
  const BOTH_BOXES = OK([{ location_id: 'loc-still' }, { location_id: 'loc-hatch' }])
  const STILL_CARD = OK([{ location_id: 'loc-still', email_signature: { phone: '01 555 0001' } }])
  const IDS = ['loc-still', 'loc-hatch']

  it('shapes one wire entry per PERMITTED location, card attached where one exists, has_mailbox per studio', async () => {
    const db = dbWith({ mailboxes: BOTH_BOXES, cards: STILL_CARD })
    expect(await loadSignatureContexts(db, queueWorker())).toEqual([
      { location_id: 'loc-still', location_name: 'UN1T Stillorgan', studio_signature: { phone: '01 555 0001' }, has_mailbox: true },
      { location_id: 'loc-hatch', location_name: 'UN1T Hatch Street', studio_signature: null, has_mailbox: true },
    ])
  })

  it('a permitted studio with NO active mailbox stays in the list, flagged has_mailbox:false', async () => {
    // A master account's user.locations is estate-wide: the flag is what
    // keeps the editor from offering a chip per entity — but the entry
    // itself stays, because a send at that studio still resolves it.
    const db = dbWith({ mailboxes: OK([{ location_id: 'loc-still' }]), cards: STILL_CARD })
    expect(await loadSignatureContexts(db, queueWorker())).toEqual([
      { location_id: 'loc-still', location_name: 'UN1T Stillorgan', studio_signature: { phone: '01 555 0001' }, has_mailbox: true },
      { location_id: 'loc-hatch', location_name: 'UN1T Hatch Street', studio_signature: null, has_mailbox: false },
    ])
  })

  it('scopes BOTH reads to the permitted ids, active mailboxes only, bounded in rows', async () => {
    const db = dbWith({ mailboxes: BOTH_BOXES, cards: STILL_CARD })
    await loadSignatureContexts(db, queueWorker())
    const [mailboxRead] = db.log.email_mailboxes
    expect(mailboxRead.select).toBe('location_id')
    expect(mailboxRead.eq).toEqual([['active', true]])
    expect(mailboxRead.in).toEqual([['location_id', IDS]])
    // studios × the per-studio ceiling, never past PostgREST's 1,000 cap.
    expect(mailboxRead.limit).toBe(Math.min(1000, IDS.length * PER_STUDIO_MAILBOX_CEILING))
    expect(mailboxRead.limit).toBe(400)
    const [cardRead] = db.log.company_settings
    expect(cardRead.select).toBe('location_id, email_signature')
    expect(cardRead.eq).toEqual([])
    expect(cardRead.in).toEqual([['location_id', IDS]])
    expect(cardRead.limit).toBe(50)
  })

  it('51 mailbox rows across two studios keep both flagged — well inside the 400-row bound', async () => {
    const rows = [
      ...Array.from({ length: 50 }, () => ({ location_id: 'loc-still' })),
      { location_id: 'loc-hatch' },
    ]
    const db = dbWith({ mailboxes: OK(rows), cards: STILL_CARD })
    const out = await loadSignatureContexts(db, queueWorker())
    expect(out.map((c) => c.has_mailbox)).toEqual([true, true])
  })

  it('a FULL page is a blip: the read may be truncated, so every studio is offered (has_mailbox:true)', async () => {
    // 400 rows, all Stillorgan's — Hatch's could be the ones cut off, so the
    // honest answer for Hatch is "unknown", and unknown means offer.
    const full = Array.from({ length: 400 }, () => ({ location_id: 'loc-still' }))
    const db = dbWith({ mailboxes: OK(full), cards: STILL_CARD })
    expect((await loadSignatureContexts(db, queueWorker())).map((c) => c.has_mailbox)).toEqual([true, true])
    // One short of full is a complete answer — Hatch genuinely has none.
    const nearlyFull = Array.from({ length: 399 }, () => ({ location_id: 'loc-still' }))
    const db2 = dbWith({ mailboxes: OK(nearlyFull), cards: STILL_CARD })
    expect((await loadSignatureContexts(db2, queueWorker())).map((c) => c.has_mailbox)).toEqual([true, false])
  })

  it('a blipped MAILBOX read leaves every studio offered — never hides studios on a blip', async () => {
    for (const mailboxes of [ERR, THROWN]) {
      const db = dbWith({ mailboxes, cards: STILL_CARD })
      expect(await loadSignatureContexts(db, queueWorker())).toEqual([
        { location_id: 'loc-still', location_name: 'UN1T Stillorgan', studio_signature: { phone: '01 555 0001' }, has_mailbox: true },
        { location_id: 'loc-hatch', location_name: 'UN1T Hatch Street', studio_signature: null, has_mailbox: true },
      ])
    }
  })

  it('a FULL card page is unknown too — no cards attached rather than some, entries survive', async () => {
    // 50 rows (the bound) — one of them Stillorgan's. Attaching it while a
    // cut-off studio's card is silently missing would show one studio
    // resolved and another not; unknown means none, the same shape as a blip.
    const full = [
      { location_id: 'loc-still', email_signature: { phone: '01 555 0001' } },
      ...Array.from({ length: 49 }, (_, i) => ({ location_id: `loc-other-${i}`, email_signature: null })),
    ]
    const db = dbWith({ mailboxes: BOTH_BOXES, cards: OK(full) })
    expect((await loadSignatureContexts(db, queueWorker())).map((c) => c.studio_signature)).toEqual([null, null])
    // One short of full is a complete answer — the card attaches.
    const db2 = dbWith({ mailboxes: BOTH_BOXES, cards: OK(full.slice(0, 49)) })
    expect((await loadSignatureContexts(db2, queueWorker()))[0].studio_signature).toEqual({ phone: '01 555 0001' })
  })

  it('a blipped CARD read degrades to null cards — entries survive, nothing throws', async () => {
    for (const cards of [ERR, THROWN]) {
      const db = dbWith({ mailboxes: BOTH_BOXES, cards })
      expect(await loadSignatureContexts(db, queueWorker())).toEqual([
        { location_id: 'loc-still', location_name: 'UN1T Stillorgan', studio_signature: null, has_mailbox: true },
        { location_id: 'loc-hatch', location_name: 'UN1T Hatch Street', studio_signature: null, has_mailbox: true },
      ])
    }
  })

  it('both reads blipped: the permission-only list, null cards, all offered — the GET still has something to show', async () => {
    const db = dbWith({ mailboxes: THROWN, cards: THROWN })
    expect(await loadSignatureContexts(db, queueWorker())).toEqual([
      { location_id: 'loc-still', location_name: 'UN1T Stillorgan', studio_signature: null, has_mailbox: true },
      { location_id: 'loc-hatch', location_name: 'UN1T Hatch Street', studio_signature: null, has_mailbox: true },
    ])
  })

  it('makes NO query at all for a caller with no eligible locations', async () => {
    let queried = false
    const db = { from: () => { queried = true; throw new Error('should not run') } }
    expect(await loadSignatureContexts(db, { id: 'x', locations: [] })).toEqual([])
    expect(queried).toBe(false)
  })
})

describe('signatureStudiosToOffer — the editor’s chips', () => {
  it('offers only studios with a mailbox', () => {
    expect(signatureStudiosToOffer(CONTEXTS)).toEqual([CONTEXTS[0]])
  })

  it('falls back to every permitted studio when none has a mailbox — the preview must still resolve for a real one', () => {
    const none = CONTEXTS.map((c) => ({ ...c, has_mailbox: false }))
    expect(signatureStudiosToOffer(none)).toEqual(none)
  })

  it('[] for a non-array', () => {
    expect(signatureStudiosToOffer(null)).toEqual([])
  })
})

describe('signatureContextFor', () => {
  it('shapes a wire row into effectiveRichSignature ctx', () => {
    expect(signatureContextFor(CONTEXTS, 'loc-still')).toEqual({
      locationName: 'UN1T Stillorgan',
      locationSignature: CONTEXTS[0].studio_signature,
    })
  })

  it('null for an unknown or missing location', () => {
    expect(signatureContextFor(CONTEXTS, 'loc-elsewhere')).toBeNull()
    expect(signatureContextFor(CONTEXTS, null)).toBeNull()
    expect(signatureContextFor(null, 'loc-still')).toBeNull()
  })
})

describe('resolveSignatureHint — mirrors the send byte for byte', () => {
  it('rich enabled + plain EMPTY still answers the rich text — the case the old hint hid', () => {
    const hint = resolveSignatureHint(
      { email_signature: '', email_signature_rich: RICH, signature_contexts: CONTEXTS },
      'loc-still'
    )
    expect(hint).not.toBeNull()
    expect(hint.rich).toBe(true)
    // Studio-resolved: the note line IS the studio name, the studio phone and
    // links replace the person's own.
    expect(hint.text).toContain('UN1T Stillorgan')
    expect(hint.text).toContain('01 555 0001')
    expect(hint.text).toContain('Book Stillorgan: https://un1t.ie/stillorgan')
    expect(hint.text).not.toContain('typed note')
    expect(hint.text).not.toContain('087 111 2222')
  })

  it('a PERMITTED, mailbox-less studio still resolves — its name on the line, never the stored note', () => {
    // An orphan ticket at Hatch sends with Hatch's studio line; so must the hint.
    const hint = resolveSignatureHint(
      { email_signature: '', email_signature_rich: RICH, signature_contexts: CONTEXTS },
      'loc-hatch'
    )
    expect(hint.text).toContain('UN1T Hatch Street')
    expect(hint.text).toContain('087 111 2222') // person's fallback — Hatch defines none
    expect(hint.text).not.toContain('01 555 0001')
    expect(hint.text).not.toContain('typed note')
  })

  it('a location with NO context (not permitted) → null, never personRich verbatim', () => {
    // The send WILL resolve a studio there; a preview of the raw values would
    // be of an email that never exists — and the plain column would be a
    // different lie, since the rich block is what goes out.
    expect(
      resolveSignatureHint(
        { email_signature: 'Plain Sarah', email_signature_rich: RICH, signature_contexts: CONTEXTS },
        'loc-elsewhere'
      )
    ).toBeNull()
    expect(
      resolveSignatureHint({ email_signature: '', email_signature_rich: RICH, signature_contexts: CONTEXTS }, null)
    ).toBeNull()
    expect(
      resolveSignatureHint({ email_signature: '', email_signature_rich: RICH, signature_contexts: [] }, 'loc-still')
    ).toBeNull()
  })

  it('the plain column does not depend on a studio — it shows for any location, or none', () => {
    const prefs = { email_signature: 'Plain Sarah', email_signature_rich: { ...RICH, enabled: false }, signature_contexts: CONTEXTS }
    expect(resolveSignatureHint(prefs, 'loc-elsewhere')).toEqual({ text: 'Plain Sarah', rich: false, hasPhoto: false, hasLinks: false })
    expect(resolveSignatureHint(prefs, null)).toEqual({ text: 'Plain Sarah', rich: false, hasPhoto: false, hasLinks: false })
  })

  it('rich enabled but EMPTY falls through to the plain column — the send’s own gate on the RAW value', () => {
    const hint = resolveSignatureHint(
      {
        email_signature: 'Plain Sarah',
        email_signature_rich: { enabled: true, name: '', title: '', phone: '', note: '', photo_url: null, links: [] },
        signature_contexts: CONTEXTS,
      },
      'loc-still'
    )
    expect(hint).toEqual({ text: 'Plain Sarah', rich: false, hasPhoto: false, hasLinks: false })
  })

  it('nothing anywhere hides the hint entirely', () => {
    for (const plain of ['', '   \n ', null, undefined]) {
      expect(
        resolveSignatureHint(
          { email_signature: plain, email_signature_rich: null, signature_contexts: CONTEXTS },
          'loc-still'
        )
      ).toBeNull()
    }
    expect(resolveSignatureHint(null, 'loc-still')).toBeNull()
  })

  it('a PHOTO-ONLY signature with nothing on the studio line answers text "" with rich:true — an HTML-only block', () => {
    // No text part at send: appendSignature('') appends nothing, no "-- ";
    // only the HTML block rides. The hint must know to draw no separator.
    const photoOnly = { enabled: true, name: '', title: '', phone: '', note: '', photo_url: BUCKET_PHOTO, links: [] }
    const nameless = [{ location_id: 'loc-x', location_name: null, studio_signature: null, has_mailbox: true }]
    expect(
      resolveSignatureHint({ email_signature: '', email_signature_rich: photoOnly, signature_contexts: nameless }, 'loc-x')
    ).toEqual({ text: '', rich: true, hasPhoto: true, hasLinks: false })
    // With a named studio the studio line IS the text part.
    expect(
      resolveSignatureHint({ email_signature: '', email_signature_rich: photoOnly, signature_contexts: CONTEXTS }, 'loc-hatch').text
    ).toBe('UN1T Hatch Street')
  })

  it('hasPhoto only for a photo the renderer would actually embed (branding-bucket allow-list)', () => {
    const prefs = (photo_url) => ({
      email_signature: '',
      email_signature_rich: { ...RICH, photo_url },
      signature_contexts: CONTEXTS,
    })
    expect(resolveSignatureHint(prefs(BUCKET_PHOTO), 'loc-still').hasPhoto).toBe(true)
    expect(resolveSignatureHint(prefs('https://evil.example/x.jpg'), 'loc-still').hasPhoto).toBe(false)
    expect(resolveSignatureHint(prefs(null), 'loc-still').hasPhoto).toBe(false)
  })

  it('hasLinks follows the EFFECTIVE list — the studio’s card at Stillorgan, the person’s (empty) own at Hatch', () => {
    const prefs = { email_signature: '', email_signature_rich: { ...RICH, photo_url: BUCKET_PHOTO }, signature_contexts: CONTEXTS }
    // Stillorgan's card defines a link → links ride along.
    expect(resolveSignatureHint(prefs, 'loc-still')).toMatchObject({ hasPhoto: true, hasLinks: true })
    // Hatch defines none and the person typed none → a photo-only send, and
    // the hint must not promise links it does not carry.
    expect(resolveSignatureHint(prefs, 'loc-hatch')).toMatchObject({ hasPhoto: true, hasLinks: false })
    // A person's own link stands where the studio card is silent.
    const own = { ...prefs, email_signature_rich: { ...RICH, links: [{ label: 'IG', url: 'https://instagram.com/x' }] } }
    expect(resolveSignatureHint(own, 'loc-hatch').hasLinks).toBe(true)
    // A url-less row is not a link.
    const blank = { ...prefs, email_signature_rich: { ...RICH, links: [{ label: 'IG', url: '' }] } }
    expect(resolveSignatureHint(blank, 'loc-hatch').hasLinks).toBe(false)
  })
})

describe('withEffectiveText — the server-rendered half (the mobile contract)', () => {
  it('adds the resolved text per entry — studio phone/links applied — plus the rich/photo/links flags', () => {
    const out = withEffectiveText(CONTEXTS, { email_signature: '', email_signature_rich: RICH })
    expect(out).toHaveLength(2)
    // Inputs survive untouched alongside the rendered answer.
    expect(out[0]).toMatchObject(CONTEXTS[0])
    expect(out[0].rich).toBe(true)
    expect(out[0].has_photo).toBe(false)
    expect(out[0].has_links).toBe(true) // Stillorgan's card link
    // THE LITERAL: name / title · studio / studio phone / studio link — and
    // no trace of the typed note or the person's own phone.
    expect(out[0].effective_text).toBe(
      'Alex Example\nHead Coach · UN1T Stillorgan\n01 555 0001\nBook Stillorgan: https://un1t.ie/stillorgan'
    )
    expect(out[1]).toMatchObject({ ...CONTEXTS[1], rich: true, has_photo: false, has_links: false })
    expect(out[1].effective_text).toBe('Alex Example\nHead Coach · UN1T Hatch Street\n087 111 2222')
  })

  it('a photo-only signature at a nameless studio: effective_text "" with rich:true — mobile shows the label, no text', () => {
    const photoOnly = { enabled: true, name: '', title: '', phone: '', note: '', photo_url: BUCKET_PHOTO, links: [] }
    const nameless = [{ location_id: 'loc-x', location_name: null, studio_signature: null, has_mailbox: true }]
    expect(withEffectiveText(nameless, { email_signature: '', email_signature_rich: photoOnly })[0]).toMatchObject({
      effective_text: '', rich: true, has_photo: true, has_links: false,
    })
  })

  it('null text and false flags when NOTHING would append', () => {
    const out = withEffectiveText(CONTEXTS, { email_signature: '', email_signature_rich: null })
    for (const entry of out) {
      expect(entry).toMatchObject({ effective_text: null, rich: false, has_photo: false, has_links: false })
    }
  })

  it('the plain column when the rich signature is off — same text at every studio', () => {
    const out = withEffectiveText(CONTEXTS, { email_signature: 'Plain Sarah', email_signature_rich: { ...RICH, enabled: false } })
    for (const entry of out) {
      expect(entry).toMatchObject({ effective_text: 'Plain Sarah', rich: false, has_photo: false, has_links: false })
    }
  })

  it('never throws on a null profile or a non-array context', () => {
    expect(withEffectiveText(CONTEXTS, null).map((e) => e.effective_text)).toEqual([null, null])
    expect(withEffectiveText(null, { email_signature: 'x' })).toEqual([])
  })
})
