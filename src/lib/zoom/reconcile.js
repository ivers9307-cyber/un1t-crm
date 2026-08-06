// ZOOMSYNC.1 — the diff and the deletion guard.

export const GUARD_FLOOR = 20
export const GUARD_FRACTION = 0.05

/**
 * Comparison-only equality, NOT what gets sent to Zoom. Desired names are
 * recomputed fresh from the CRM every run; if either side round-trips
 * through something that re-encodes whitespace or composes accented
 * characters differently (Zoom's own storage, a legacy import, a copy-paste
 * source using NFD), a byte-literal compare never converges — the same
 * entry reads as "changed" on every single run, forever, generating
 * pointless writes indefinitely. Trim + Unicode-normalise before comparing
 * so only an actual content difference triggers an update; the raw
 * want.name (not this normalised form) is still what gets written.
 */
function namesEqual(a, b) {
  const norm = (s) => (typeof s === 'string' ? s.normalize('NFC').trim() : '')
  return norm(a) === norm(b)
}

/**
 * Pure. desired: Map<e164, {name, contactId}>; existing: Map<e164, {name, zoomId}>.
 * `existing` must ALREADY be filtered to CRM-owned entries — listOwnedContacts
 * does that, and it is what keeps hand-added contacts out of `deletes`.
 */
export function diffContacts(desired, existing) {
  const creates = []
  const updates = []
  const deletes = []

  for (const [e164, want] of desired) {
    const have = existing.get(e164)
    if (!have) {
      creates.push({ e164, name: want.name, contactId: want.contactId })
    } else if (!namesEqual(have.name, want.name)) {
      updates.push({ e164, name: want.name, contactId: want.contactId, zoomId: have.zoomId })
    }
  }

  for (const [e164, have] of existing) {
    if (!desired.has(e164)) deletes.push({ e164, zoomId: have.zoomId })
  }

  return { creates, updates, deletes }
}

/**
 * A broken desired-state query (renamed column, dropped lead_source, a Supabase
 * blip returning zero rows) yields an empty desired set, which the diff reads as
 * "delete everything". Deletes are the only irreversible direction, so an
 * oversized batch suppresses ALL of them and fails the run loudly. Creates and
 * updates still apply — they are safe.
 */
export function applyDeletionGuard(deletes, ownedExistingCount) {
  const threshold = Math.max(GUARD_FLOOR, Math.ceil(ownedExistingCount * GUARD_FRACTION))
  if (deletes.length > threshold) {
    return {
      tripped: true,
      deletes: [],
      threshold,
      attempted: deletes.length,
      sample: deletes.slice(0, 10).map((d) => d.e164),
    }
  }
  return { tripped: false, deletes, threshold, attempted: deletes.length }
}
