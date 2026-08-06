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
