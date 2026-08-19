import { describe, it, expect } from 'vitest'
import { diffContacts, applyDeletionGuard, GUARD_FLOOR, GUARD_FRACTION } from './reconcile'

const desired = (entries) => new Map(entries.map(([k, name, contactId = 'u1']) => [k, { name, contactId }]))
const existing = (entries) => new Map(entries.map(([k, name, zoomId]) => [k, { name, zoomId }]))

describe('diffContacts', () => {
  it('creates numbers Zoom does not have', () => {
    const d = diffContacts(desired([['+353871111111', 'Aoife Ryan']]), existing([]))
    expect(d.creates).toEqual([{ e164: '+353871111111', name: 'Aoife Ryan', contactId: 'u1' }])
    expect(d.updates).toEqual([])
    expect(d.deletes).toEqual([])
  })

  it('updates when the name differs', () => {
    const d = diffContacts(
      desired([['+353871111111', 'Aoife Byrne', 'u2']]),
      existing([['+353871111111', 'Aoife Ryan', 'z1']]),
    )
    expect(d.updates).toEqual([{ e164: '+353871111111', name: 'Aoife Byrne', contactId: 'u2', zoomId: 'z1' }])
    expect(d.creates).toEqual([])
  })

  it('does nothing when the name matches', () => {
    const d = diffContacts(
      desired([['+353871111111', 'Aoife Ryan']]),
      existing([['+353871111111', 'Aoife Ryan', 'z1']]),
    )
    expect(d.creates).toEqual([]); expect(d.updates).toEqual([]); expect(d.deletes).toEqual([])
  })

  it('deletes numbers no longer in the CRM', () => {
    const d = diffContacts(desired([]), existing([['+353871111111', 'Aoife Ryan', 'z1']]))
    expect(d.deletes).toEqual([{ e164: '+353871111111', zoomId: 'z1' }])
  })

  // A name that only differs by surrounding whitespace or Unicode
  // normalisation form (NFD vs NFC) must not read as "changed" — desired
  // names are recomputed fresh from the CRM every run, so if the comparison
  // is byte-literal and either side round-trips through anything that
  // re-encodes whitespace or accents (Zoom's own storage, a legacy import),
  // the mismatch never resolves and every nightly run re-sends the same
  // pointless update forever.
  it('does not update when names differ only by surrounding whitespace', () => {
    const d = diffContacts(
      desired([['+353871111111', '  Aoife Ryan  ', 'u2']]),
      existing([['+353871111111', 'Aoife Ryan', 'z1']]),
    )
    expect(d.updates).toEqual([])
  })

  it('does not update when names differ only by unicode normalisation form', () => {
    const nfc = 'Áine Ní Bhraonáin'.normalize('NFC')
    const nfd = 'Áine Ní Bhraonáin'.normalize('NFD')
    expect(nfc).not.toBe(nfd) // sanity: the fixture actually exercises two distinct encodings
    const d = diffContacts(
      desired([['+353871111111', nfd, 'u2']]),
      existing([['+353871111111', nfc, 'z1']]),
    )
    expect(d.updates).toEqual([])
  })
})

/**
 * ZOOMSYNC.4 — the trap. Filtering an unusable number out of the desired state
 * is not a neutral act: this diff reads "in Zoom, not in desired" as a delete,
 * so a naive filter deletes live directory entries for the numbers Zoom
 * happened to accept before anything checked them. The deletion guard does not
 * save you — at 6,330 owned entries its threshold is ~317, and the live
 * population of such numbers is ~2.
 */
describe('diffContacts — protected keys (the delete trap)', () => {
  it('(a) never enqueues anything for an unusable number Zoom never created', () => {
    // The common case: the number is out of `desired` (buildDesiredContacts
    // dropped it) and was never in Zoom, so the run is a no-op for it.
    const d = diffContacts(desired([]), existing([]), new Set(['+87654567890']))
    expect(d.creates).toEqual([]); expect(d.updates).toEqual([]); expect(d.deletes).toEqual([])
    expect(d.withheld).toEqual({ creates: 0, updates: 0, deletes: [] })
  })

  it('(b) LEAVES an unusable number that is already in Zoom alone — no delete', () => {
    const d = diffContacts(
      desired([]),
      existing([['+4407502871075', 'Aoife Ryan', 'z1']]),
      new Set(['+4407502871075']),
    )
    expect(d.deletes).toEqual([])
    expect(d.withheld.deletes).toEqual(['+4407502871075'])
  })

  it('still deletes an entry that is simply gone from the CRM', () => {
    // The distinction that makes the withholding safe: protected means "the CRM
    // still produces this number and it is unusable", NOT "unknown".
    const d = diffContacts(
      desired([]),
      existing([['+353871111111', 'Aoife Ryan', 'z1'], ['+4407502871075', 'Ben Ó Sé', 'z2']]),
      new Set(['+4407502871075']),
    )
    expect(d.deletes).toEqual([{ e164: '+353871111111', zoomId: 'z1' }])
    expect(d.withheld.deletes).toEqual(['+4407502871075'])
  })

  it('self-clears: once the number is fixed in the CRM the stale entry deletes normally', () => {
    // Next run, the contact carries +353871111111 instead. The old key is no
    // longer produced, so it is no longer protected, so the ordinary delete
    // path removes it — with the guard watching.
    const d = diffContacts(
      desired([['+353871111111', 'Aoife Ryan']]),
      existing([['+4407502871075', 'Aoife Ryan', 'z1']]),
      new Set(),
    )
    expect(d.creates).toEqual([{ e164: '+353871111111', name: 'Aoife Ryan', contactId: 'u1' }])
    expect(d.deletes).toEqual([{ e164: '+4407502871075', zoomId: 'z1' }])
  })

  it('does not re-enqueue a create for a PARKED number that is still in desired', () => {
    // A parked number passed validation but Zoom refused it anyway. It stays in
    // `desired` (nothing is wrong with it by our rules), so only the park stops
    // the nightly re-enqueue.
    const d = diffContacts(desired([['+299123456', 'Aoife Ryan']]), existing([]), new Set(['+299123456']))
    expect(d.creates).toEqual([])
    expect(d.withheld.creates).toBe(1)
  })

  it('does not re-enqueue an update for a parked number', () => {
    const d = diffContacts(
      desired([['+299123456', 'Aoife Byrne', 'u2']]),
      existing([['+299123456', 'Aoife Ryan', 'z1']]),
      new Set(['+299123456']),
    )
    expect(d.updates).toEqual([])
    expect(d.withheld.updates).toBe(1)
  })

  it('protects nothing when no set is passed — the caller owns that truth', () => {
    const d = diffContacts(desired([]), existing([['+87654567890', 'Aoife Ryan', 'z1']]))
    expect(d.deletes).toEqual([{ e164: '+87654567890', zoomId: 'z1' }])
  })
})

describe('applyDeletionGuard', () => {
  const del = (n) => Array.from({ length: n }, (_, i) => ({ e164: `+35387000000${i}`, zoomId: `z${i}` }))

  it('allows a small delete batch on a large directory', () => {
    const g = applyDeletionGuard(del(10), 6330)
    expect(g.tripped).toBe(false)
    expect(g.deletes).toHaveLength(10)
  })

  it('allows deletes up to the floor even on a tiny directory', () => {
    const g = applyDeletionGuard(del(GUARD_FLOOR), 50)
    expect(g.tripped).toBe(false)
  })

  it('trips and suppresses every delete when the batch is too big', () => {
    const g = applyDeletionGuard(del(400), 6330)
    expect(g.tripped).toBe(true)
    expect(g.deletes).toEqual([])
    expect(g.threshold).toBe(Math.max(GUARD_FLOOR, Math.ceil(6330 * GUARD_FRACTION)))
    expect(g.attempted).toBe(400)
  })

  it('does not trip exactly at the threshold', () => {
    const threshold = Math.max(GUARD_FLOOR, Math.ceil(6330 * GUARD_FRACTION))
    expect(applyDeletionGuard(del(threshold), 6330).tripped).toBe(false)
    expect(applyDeletionGuard(del(threshold + 1), 6330).tripped).toBe(true)
  })

  // The disaster case: desired-state query returns nothing.
  it('trips when the desired set is empty against a full directory', () => {
    const g = applyDeletionGuard(del(6330), 6330)
    expect(g.tripped).toBe(true)
    expect(g.deletes).toEqual([])
  })
})
