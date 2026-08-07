// EMAIL-INBOUND-SHIM.1 — the wire contract between the Edge Function and the
// Vercel route.
//
// WHAT THIS FILE IS FOR
// The Deno function cannot import src/lib, so its writer half is hand-mirrored
// in TypeScript. These tests pin the JS side of the contract exactly — and,
// crucially, run the WRITER into the READER, so the pair can never drift from
// itself. The .ts mirror is pinned separately, by reading it off disk, in
// email-attachment-staging.contract.test.js.
//
// THE SECURITY PROPERTY UNDER TEST is that a `storage_path` written into a row
// is never a string an unauthenticated stranger's payload got to choose. The
// reader re-derives the shape it expects from ids WE hold — Postmark's
// MessageID off the payload and the attachment's array position — so a marker
// cannot name another message's object, a canonically-keyed `<location_id>/…`
// object, or anything up a `../`. Every "refuses" test below is that property.

import { describe, it, expect } from 'vitest'
import {
  STAGED_MARKER_KEY,
  STAGED_MARKER_VERSION,
  STAGED_PREFIX,
  failedAttachment,
  readStagedMarker,
  stagedAttachment,
  stagedAttachmentPath,
  stagedPathMatches,
  stagedPathsIn,
  strippedAttachment,
} from './email-attachment-staging'

const MID = 'a1b2c3d4-0000-4000-8000-000000000001'

const inbound = (overrides = {}) => ({
  Name: 'invoice.pdf',
  ContentType: 'application/pdf',
  Content: 'YWJjZA==',
  ContentLength: 4,
  ...overrides,
})

describe('stagedAttachmentPath — the key the shim can actually compute', () => {
  it('keys on Postmark’s MessageID and the array index', () => {
    expect(stagedAttachmentPath({ postmarkMessageId: MID, index: 0, extension: 'pdf' }))
      .toBe(`inbound/${MID}/0.pdf`)
    expect(stagedAttachmentPath({ postmarkMessageId: MID, index: 7, extension: 'jpg' }))
      .toBe(`inbound/${MID}/7.jpg`)
  })

  it('is DETERMINISTIC — the same payload gives the same key on every retry', () => {
    // The whole reason a Postmark retry cannot leave a second copy: it
    // overwrites this exact key rather than minting a new one.
    const first = stagedAttachmentPath({ postmarkMessageId: MID, index: 2, extension: 'png' })
    const second = stagedAttachmentPath({ postmarkMessageId: MID, index: 2, extension: 'png' })
    expect(first).toBe(second)
  })

  it('never collides with the canonical <location_id>/… half of the bucket', () => {
    // A location id is a uuid, so it can never be the literal `inbound`.
    expect(stagedAttachmentPath({ postmarkMessageId: MID, index: 0, extension: 'pdf' }))
      .toMatch(new RegExp(`^${STAGED_PREFIX}/`))
    expect(STAGED_PREFIX).not.toMatch(/^[0-9a-f]{8}-/)
  })

  it('falls back to .bin rather than letting an odd extension into the key', () => {
    expect(stagedAttachmentPath({ postmarkMessageId: MID, index: 0, extension: '../x' }))
      .toBe(`inbound/${MID}/0.bin`)
    expect(stagedAttachmentPath({ postmarkMessageId: MID, index: 0, extension: '' }))
      .toBe(`inbound/${MID}/0.bin`)
  })

  it('THROWS on an id that is not a bare path segment', () => {
    // Postmark's MessageID is a uuid, but nothing about the payload is ours.
    for (const bad of ['../../etc', 'a/b', '', null, undefined, 'x'.repeat(65), 'a b']) {
      expect(() => stagedAttachmentPath({ postmarkMessageId: bad, index: 0, extension: 'pdf' }))
        .toThrow(/safe path segment/)
    }
  })

  it('THROWS on an index that is not a small non-negative integer', () => {
    for (const bad of [-1, 1.5, 10000, '0', null, NaN]) {
      expect(() => stagedAttachmentPath({ postmarkMessageId: MID, index: bad, extension: 'pdf' }))
        .toThrow(/non-negative integer/)
    }
  })
})

describe('stagedPathMatches — what the route is willing to believe', () => {
  const at = (index) => ({ postmarkMessageId: MID, index })

  it('accepts the key the shim would have written', () => {
    expect(stagedPathMatches(`inbound/${MID}/0.pdf`, at(0))).toBe(true)
    expect(stagedPathMatches(`inbound/${MID}/12.bin`, at(12))).toBe(true)
  })

  it('accepts a DIFFERENT extension for the same object', () => {
    // Deliberate: the mime→extension mapping is duplicated across two runtimes
    // and the extension addresses nothing. Pinning the character would turn a
    // harmless drift into rehost_failed for a file sitting correctly in the
    // bucket.
    expect(stagedPathMatches(`inbound/${MID}/0.jpeg`, at(0))).toBe(true)
  })

  it('refuses another MESSAGE’s object', () => {
    expect(stagedPathMatches(`inbound/b1b2c3d4-0000-4000-8000-000000000002/0.pdf`, at(0)))
      .toBe(false)
  })

  it('refuses another INDEX’s object', () => {
    expect(stagedPathMatches(`inbound/${MID}/1.pdf`, at(0))).toBe(false)
    // Not a prefix match either — `1` must not satisfy index 11.
    expect(stagedPathMatches(`inbound/${MID}/1.pdf`, at(11))).toBe(false)
  })

  it('refuses a canonically-keyed object', () => {
    // The inline path's own keys are <location_id>/<message_id>/<index>.<ext>.
    // A marker must never be able to name one — that is another studio's file.
    expect(stagedPathMatches(
      'a0000000-0000-4000-8000-000000000001/c0000000-0000-4000-8000-000000000003/0.pdf',
      at(0),
    )).toBe(false)
  })

  it('refuses traversal, absolute paths and extra segments', () => {
    for (const bad of [
      `inbound/${MID}/../../0.pdf`,
      `/inbound/${MID}/0.pdf`,
      `inbound/${MID}/sub/0.pdf`,
      `inbound/${MID}/0`,
      `inbound/${MID}/.pdf`,
      `Inbound/${MID}/0.pdf`,
      '',
      null,
      undefined,
      42,
    ]) {
      expect(stagedPathMatches(bad, at(0))).toBe(false)
    }
  })

  it('refuses everything when the message id itself is unusable', () => {
    // Fail-safe: no id to derive from means no marker is believed, rather than
    // any marker being believed.
    expect(stagedPathMatches('inbound/x/0.pdf', { postmarkMessageId: null, index: 0 })).toBe(false)
    expect(stagedPathMatches(`inbound/${MID}/0.pdf`, { postmarkMessageId: undefined, index: 0 }))
      .toBe(false)
  })
})

describe('the writer — what the shim puts on the wire', () => {
  it('empties Content and keeps every field a dead-letter triage needs', () => {
    const out = stagedAttachment(inbound(), { path: `inbound/${MID}/0.pdf`, sizeBytes: 4 })
    expect(out.Content).toBe('')
    expect(out.Name).toBe('invoice.pdf')
    expect(out.ContentType).toBe('application/pdf')
    expect(out.ContentLength).toBe(4)
    expect(out[STAGED_MARKER_KEY]).toEqual({
      v: STAGED_MARKER_VERSION, path: `inbound/${MID}/0.pdf`, bytes: 4,
    })
  })

  it('marks a file it could not move, rather than dropping it', () => {
    // The governing rule: the message is forwarded anyway and the route
    // records a row an operator can act on.
    expect(failedAttachment(inbound(), { reason: 'too_large' })[STAGED_MARKER_KEY])
      .toEqual({ v: STAGED_MARKER_VERSION, error: 'too_large' })
    expect(failedAttachment(inbound(), { reason: 'upload_failed' })[STAGED_MARKER_KEY])
      .toEqual({ v: STAGED_MARKER_VERSION, error: 'upload_failed' })
  })

  it('normalises an unknown failure reason instead of inventing vocabulary', () => {
    // skipped_reason is a DB CHECK (mig 496). A value outside it would 23514
    // and lose the record of the file entirely.
    expect(failedAttachment(inbound(), { reason: 'banana' })[STAGED_MARKER_KEY].error)
      .toBe('upload_failed')
  })

  it('strips Content with NO marker past the per-message cap', () => {
    // The route's own `too_many` branch fires on the array position before it
    // consults a marker, and records the row from ContentLength.
    const out = strippedAttachment(inbound())
    expect(out.Content).toBe('')
    expect(out[STAGED_MARKER_KEY]).toBeUndefined()
    expect(out.ContentLength).toBe(4)
  })

  it('does not mutate the attachment it was given', () => {
    const original = inbound()
    stagedAttachment(original, { path: `inbound/${MID}/0.pdf`, sizeBytes: 4 })
    expect(original.Content).toBe('YWJjZA==')
  })
})

describe('the reader — round-tripping the writer', () => {
  it('reads back exactly what the writer wrote', () => {
    const path = stagedAttachmentPath({ postmarkMessageId: MID, index: 3, extension: 'pdf' })
    const wire = stagedAttachment(inbound(), { path, sizeBytes: 900 })
    expect(readStagedMarker(wire, { postmarkMessageId: MID, index: 3 }))
      .toEqual({ kind: 'staged', path, sizeBytes: 900 })
  })

  it('maps each writer failure to the skipped_reason the route records', () => {
    const tooLarge = failedAttachment(inbound(), { reason: 'too_large' })
    expect(readStagedMarker(tooLarge, { postmarkMessageId: MID, index: 0 }))
      .toEqual({ kind: 'skip', reason: 'too_large' })

    const failed = failedAttachment(inbound(), { reason: 'upload_failed' })
    expect(readStagedMarker(failed, { postmarkMessageId: MID, index: 0 }))
      .toEqual({ kind: 'skip', reason: 'rehost_failed' })
  })

  it('reads a stripped attachment as INLINE, so the too_many branch is unchanged', () => {
    expect(readStagedMarker(strippedAttachment(inbound()), { postmarkMessageId: MID, index: 0 }))
      .toEqual({ kind: 'inline' })
  })
})

describe('the reader — the ORIGINAL shape still reads as inline', () => {
  it('treats Postmark’s untouched attachment as inline', () => {
    // The fallback if the shim is bypassed, mis-deployed or rolled back.
    expect(readStagedMarker(inbound(), { postmarkMessageId: MID, index: 0 }))
      .toEqual({ kind: 'inline' })
  })

  it('treats anything with no marker as inline, however odd', () => {
    for (const att of [{}, { Content: '' }, null, undefined, 'nonsense', 42]) {
      expect(readStagedMarker(att, { postmarkMessageId: MID, index: 0 }).kind).toBe('inline')
    }
  })
})

describe('the reader — a marker it cannot trust is rehost_failed, NEVER inline', () => {
  const bad = (marker) => readStagedMarker(
    { ...inbound(), Content: '', [STAGED_MARKER_KEY]: marker },
    { postmarkMessageId: MID, index: 0 },
  )

  // Falling back to `inline` would decode the empty string the shim left
  // behind, produce no row at all (size_bytes > 0 is a CHECK) and lose every
  // trace that a file arrived. rehost_failed is the honest answer.
  it('refuses a path pointing anywhere else', () => {
    expect(bad({ v: 1, path: `inbound/${MID}/9.pdf`, bytes: 10 }))
      .toEqual({ kind: 'skip', reason: 'rehost_failed' })
    expect(bad({ v: 1, path: '../../secrets/key.pem', bytes: 10 }))
      .toEqual({ kind: 'skip', reason: 'rehost_failed' })
  })

  it('refuses a size that is not a plain positive integer', () => {
    for (const bytes of ['900', 0, -1, 1.5, null, undefined, NaN, Infinity]) {
      expect(bad({ v: 1, path: `inbound/${MID}/0.pdf`, bytes }))
        .toEqual({ kind: 'skip', reason: 'rehost_failed' })
    }
  })

  it('refuses a marker that is not an object', () => {
    for (const marker of ['staged', 42, true, [`inbound/${MID}/0.pdf`]]) {
      expect(bad(marker)).toEqual({ kind: 'skip', reason: 'rehost_failed' })
    }
  })

  it('refuses an unknown error code rather than guessing', () => {
    expect(bad({ v: 1, error: 'something_new' })).toEqual({ kind: 'skip', reason: 'rehost_failed' })
  })

  it('refuses every marker when the route has no Postmark MessageID to check against', () => {
    // Fail-safe, not fail-open: with nothing to re-derive from, no path is
    // believed and nothing is deleted.
    expect(readStagedMarker(
      { [STAGED_MARKER_KEY]: { v: 1, path: `inbound/${MID}/0.pdf`, bytes: 10 } },
      { postmarkMessageId: null, index: 0 },
    )).toEqual({ kind: 'skip', reason: 'rehost_failed' })
  })
})

describe('stagedPathsIn — the input to "throw these away"', () => {
  const wire = (index, mid = MID) => stagedAttachment(inbound(), {
    path: stagedAttachmentPath({ postmarkMessageId: mid, index, extension: 'pdf' }),
    sizeBytes: 10,
  })

  it('returns every valid staged path, in order', () => {
    expect(stagedPathsIn([wire(0), wire(1)], { postmarkMessageId: MID }))
      .toEqual([`inbound/${MID}/0.pdf`, `inbound/${MID}/1.pdf`])
  })

  it('returns nothing for the inline shape', () => {
    expect(stagedPathsIn([inbound(), inbound()], { postmarkMessageId: MID })).toEqual([])
  })

  it('DROPS a path that does not validate — a delete must never take a free string', () => {
    // Without this, a remove() driven off a webhook payload would be a
    // delete-anything primitive.
    const forged = { ...inbound(), Content: '', [STAGED_MARKER_KEY]: { v: 1, path: 'a0000000-0000-4000-8000-000000000001/x/0.pdf', bytes: 10 } }
    expect(stagedPathsIn([forged], { postmarkMessageId: MID })).toEqual([])
  })

  it('drops a path staged under a DIFFERENT message id', () => {
    expect(stagedPathsIn([wire(0, 'b1b2c3d4-0000-4000-8000-000000000002')], { postmarkMessageId: MID }))
      .toEqual([])
  })

  it('survives anything that is not an array of attachments', () => {
    for (const input of [null, undefined, 'nope', 42, {}]) {
      expect(stagedPathsIn(input, { postmarkMessageId: MID })).toEqual([])
    }
    expect(stagedPathsIn([null, undefined, 7], { postmarkMessageId: MID })).toEqual([])
  })
})
