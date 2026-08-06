// ZOOMSYNC.1 — the diff and the deletion guard.

import { zoomConfigured } from './client'
import { listOwnedContacts } from './external-contacts'
import { buildDesiredContacts } from './desired-contacts'
import {
  publishQueuePush, ensureQueue,
  ZOOM_CONTACTS_WORKER_PATH, ZOOM_CONTACTS_QUEUE_NAME, ZOOM_CONTACTS_QUEUE_PARALLELISM,
} from '@/lib/qstash'

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

/**
 * QStash 400s on colons in Upstash-Deduplication-Id (undocumented; bit us
 * 2026-07-17). Dashes and digits only.
 */
function dedupId(op, e164) {
  return `zoom-contact-${op}-${e164.replace(/\D/g, '')}`
}

/**
 * Builds the diff and enqueues one QStash job per write. Performs no Zoom
 * writes itself — the worker route does those, one per delivery.
 *
 * @param {object} opts
 * @param {object} [opts.db] — Supabase server client
 * @param {boolean} [opts.dry] — compute and return the diff, enqueue nothing
 * @param {number} [opts.limit] — enqueue at most N jobs (creates first)
 * @param {boolean} [opts.force] — bypass the deletion guard for this run
 */
export async function runZoomContactSync({ db, dry = false, limit = null, force = false } = {}) {
  if (!zoomConfigured()) return { skipped: 'unconfigured' }

  const desiredRes = await buildDesiredContacts(db)
  if (!desiredRes.ok) return { ok: false, error: desiredRes.error }

  const existingRes = await listOwnedContacts()
  if (!existingRes.ok) return { ok: false, error: existingRes.error }

  const diff = diffContacts(desiredRes.desired, existingRes.contacts)
  const rawGuard = applyDeletionGuard(diff.deletes, existingRes.contacts.size)
  // force is the operator's deliberate override: without it a legitimately
  // large cleanup can never drain, because suppressing the deletes keeps the
  // directory big, so the same batch trips the same threshold every night.
  const guard = force ? { tripped: false, deletes: diff.deletes, threshold: rawGuard.threshold, attempted: rawGuard.attempted } : rawGuard

  const counts = {
    creates: diff.creates.length,
    updates: diff.updates.length,
    deletes: guard.deletes.length,
  }

  if (dry) {
    return {
      ok: !guard.tripped, dry: true, counts,
      guardTripped: guard.tripped, guard, stats: desiredRes.stats,
      ownedInZoom: existingRes.contacts.size,
      ...(force ? { forced: true } : {}),
    }
  }

  // Creates first: on a cold start they are the whole job, and a limit should
  // spend itself on getting names onto handsets rather than on tidying.
  const jobs = [
    ...diff.creates.map((c) => ({ op: 'create', ...c })),
    ...diff.updates.map((u) => ({ op: 'update', ...u })),
    ...guard.deletes.map((d) => ({ op: 'delete', ...d })),
  ]
  const capped = Number.isFinite(limit) && limit > 0 ? jobs.slice(0, limit) : jobs

  if (capped.length > 0) {
    await ensureQueue(ZOOM_CONTACTS_QUEUE_NAME, ZOOM_CONTACTS_QUEUE_PARALLELISM)
  }

  let enqueued = 0
  const failures = []
  for (const job of capped) {
    const res = await publishQueuePush({
      path: ZOOM_CONTACTS_WORKER_PATH,
      body: job,
      deduplicationId: dedupId(job.op, job.e164),
      queueName: ZOOM_CONTACTS_QUEUE_NAME,
      queueParallelism: ZOOM_CONTACTS_QUEUE_PARALLELISM,
    })
    if (res.ok) enqueued++
    else failures.push(`${job.op} ${job.e164}: ${res.error ?? 'skipped'}`)
  }

  return {
    ok: !guard.tripped && failures.length === 0,
    counts,
    enqueued,
    limited: capped.length < jobs.length,
    guardTripped: guard.tripped,
    ...(force ? { forced: true } : {}),
    ...(guard.tripped ? { guard } : {}),
    ...(failures.length ? { failures: failures.slice(0, 10) } : {}),
    stats: desiredRes.stats,
    ownedInZoom: existingRes.contacts.size,
  }
}
